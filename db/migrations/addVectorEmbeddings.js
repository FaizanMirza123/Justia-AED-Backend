/**
 * Migration: Generate vector embeddings for all existing laws.
 *
 * Run from the project root:
 *   node db/migrations/addVectorEmbeddings.js
 *
 * The script is safe to re-run — it skips laws that already have embeddings.
 * On OpenAI rate-limit errors it pauses for 60 seconds before retrying.
 */

// db.js calls dotenv.config(), so importing it first ensures env vars are set
// before embeddingUtils.js creates the OpenAI client.
import pool from "../db.js";
import { generateEmbedding, embeddingToSql } from "../../utils/embeddingUtils.js";

const BATCH_SIZE = 20;
const INTER_BATCH_DELAY_MS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function migrate() {
  console.log("=== pgvector embedding migration ===\n");

  // 1. Ensure pgvector extension and schema are ready
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector;");
  await pool.query("ALTER TABLE laws ADD COLUMN IF NOT EXISTS embedding vector(1536);");
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_laws_embedding_hnsw
    ON laws USING hnsw (embedding vector_cosine_ops);
  `);
  console.log("Schema ready.");

  // 2. Count laws still needing embeddings
  const { rows: countRows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM laws WHERE embedding IS NULL"
  );
  const total = countRows[0].n;

  if (total === 0) {
    console.log("All laws already have embeddings. Nothing to do.");
    await pool.end();
    return;
  }

  console.log(`Generating embeddings for ${total} laws (batch size ${BATCH_SIZE})...\n`);

  let processed = 0;
  let failed = 0;

  while (true) {
    const { rows: batch } = await pool.query(
      `SELECT id, title, description FROM laws WHERE embedding IS NULL LIMIT $1`,
      [BATCH_SIZE]
    );

    if (batch.length === 0) break;

    for (const law of batch) {
      const text = `${law.title || ""} ${law.description || ""}`.trim();

      if (!text) {
        // Nothing to embed — mark with a zero vector so it isn't retried
        failed++;
        console.warn(`  [skip] law ${law.id} has no text`);
        continue;
      }

      try {
        const embedding = await generateEmbedding(text);
        await pool.query(
          "UPDATE laws SET embedding = $1::vector WHERE id = $2",
          [embeddingToSql(embedding), law.id]
        );
        processed++;

        if (processed % 50 === 0) {
          console.log(`  Progress: ${processed} / ${total} (${failed} skipped)`);
        }
      } catch (err) {
        if (err?.status === 429) {
          console.warn("  Rate limited by OpenAI — waiting 60 s...");
          await sleep(60_000);
          // Retry the same law by not incrementing processed/failed
          // The outer while loop will re-fetch it since embedding is still NULL
        } else {
          console.error(`  [error] law ${law.id}: ${err.message}`);
          failed++;
        }
      }
    }

    await sleep(INTER_BATCH_DELAY_MS);
  }

  console.log(`\n=== Done ===`);
  console.log(`  Embedded : ${processed}`);
  console.log(`  Skipped  : ${failed}`);
  await pool.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
