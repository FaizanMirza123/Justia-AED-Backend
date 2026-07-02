/**
 * Migration: classify every law/bill into the controlled legal-applicability
 * vocabulary (topic / industry / facility_type / document_type) using an LLM.
 *
 * This is what makes metadata-filtered retrieval possible — before this runs,
 * `laws.topic/industry/facility_type` are empty arrays and retrieval falls
 * back to jurisdiction-only filtering (still hybrid-ranked, just less precise).
 *
 * Idempotent and resumable: only processes rows where metadata_classified_at
 * IS NULL, so it can be safely re-run or interrupted.
 *
 * Run from the project root (after addLegalMetadata.js):
 *   node db/migrations/classifyLawMetadata.js
 */

import OpenAI from "openai";
import pool from "../db.js";
import { TOPICS, INDUSTRIES, FACILITY_TYPES, DOCUMENT_TYPES } from "../../utils/taxonomy.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const BATCH_SIZE = 12;
const INTER_BATCH_DELAY_MS = 300;
const MODEL = "gpt-4o-mini";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SYSTEM_PROMPT = `You are a legal metadata classifier. For each statute/bill excerpt, assign
controlled-vocabulary tags describing what it governs. Base every tag ONLY on what the text
actually states — do not guess beyond the text.

Allowed values (use ONLY these strings, choose all that reasonably apply, at least one per array):
- document_type: one of ${JSON.stringify(DOCUMENT_TYPES)}
  ("bill" = proposed/pending legislation not yet enacted; "statute" = enacted, codified law)
- topic: subset of ${JSON.stringify(TOPICS)}
- industry: subset of ${JSON.stringify(INDUSTRIES)}
- facility_type: subset of ${JSON.stringify(FACILITY_TYPES)}

Rules:
- If the text applies broadly to any building/business (not a specific industry), use industry
  "General Business" and facility_type "General Business Premises" rather than guessing a narrow one.
- If the text is facility-agnostic (e.g. defines terms, sets up a state program) still tag the
  topic(s) it relates to, and use "Other" for industry/facility_type.
- Do not include a tag unless the text gives a real basis for it.

Return ONLY valid JSON: {"results": [{"id": <int>, "document_type": "...", "topic": [...], "industry": [...], "facility_type": [...]}, ...]}
One object per input item, same ids as given, no extra commentary.`;

function buildUserPrompt(batch) {
  const items = batch.map((law) => ({
    id: law.id,
    state: law.state_name,
    section: law.section,
    text: (law.description || law.title || "").slice(0, 1500),
  }));
  return `Classify these ${items.length} items:\n${JSON.stringify(items, null, 2)}`;
}

async function classifyBatch(batch) {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(batch) },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const parsed = JSON.parse(completion.choices[0].message.content);
  return Array.isArray(parsed.results) ? parsed.results : [];
}

function sanitizeArray(values, allowed) {
  if (!Array.isArray(values)) return [];
  const allowedSet = new Set(allowed);
  const cleaned = values.filter((v) => allowedSet.has(v));
  return cleaned.length > 0 ? cleaned : ["Other"];
}

async function migrate() {
  console.log("=== Legal metadata classification backfill ===\n");

  const { rows: countRows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM laws WHERE metadata_classified_at IS NULL"
  );
  const total = countRows[0].n;

  if (total === 0) {
    console.log("All laws already classified. Nothing to do.");
    await pool.end();
    return;
  }

  console.log(`Classifying ${total} laws/bills (batch size ${BATCH_SIZE})...\n`);

  let processed = 0;
  let failed = 0;

  while (true) {
    const { rows: batch } = await pool.query(
      `SELECT l.id, l.title, l.description, l.section, s.name AS state_name
       FROM laws l JOIN states s ON l.state_id = s.id
       WHERE l.metadata_classified_at IS NULL
       LIMIT $1`,
      [BATCH_SIZE]
    );

    if (batch.length === 0) break;

    try {
      const results = await classifyBatch(batch);
      const resultsById = new Map(results.map((r) => [r.id, r]));

      for (const law of batch) {
        const r = resultsById.get(law.id);
        if (!r) {
          // Model dropped this row from its output — mark classified with
          // safe defaults rather than retrying forever.
          await pool.query(
            `UPDATE laws SET document_type = 'statute', topic = '{Other}',
             industry = '{Other}', facility_type = '{Other}', metadata_classified_at = NOW()
             WHERE id = $1`,
            [law.id]
          );
          failed++;
          continue;
        }

        const documentType = DOCUMENT_TYPES.includes(r.document_type) ? r.document_type : "statute";
        const topic = sanitizeArray(r.topic, TOPICS);
        const industry = sanitizeArray(r.industry, INDUSTRIES);
        const facilityType = sanitizeArray(r.facility_type, FACILITY_TYPES);

        await pool.query(
          `UPDATE laws SET document_type = $1, topic = $2, industry = $3, facility_type = $4,
           metadata_classified_at = NOW() WHERE id = $5`,
          [documentType, topic, industry, facilityType, law.id]
        );
        processed++;
      }

      console.log(`  Progress: ${processed + failed} / ${total} (${failed} defaulted)`);
    } catch (err) {
      if (err?.status === 429) {
        console.warn("  Rate limited by OpenAI — waiting 60 s...");
        await sleep(60_000);
        continue; // retry same batch (still unclassified)
      }
      console.error(`  [error] batch starting at law ${batch[0].id}: ${err.message}`);
      // Avoid an infinite loop on a persistently failing batch — mark defaults and move on.
      for (const law of batch) {
        await pool.query(
          `UPDATE laws SET document_type = 'statute', topic = '{Other}',
           industry = '{Other}', facility_type = '{Other}', metadata_classified_at = NOW()
           WHERE id = $1`,
          [law.id]
        );
        failed++;
      }
    }

    await sleep(INTER_BATCH_DELAY_MS);
  }

  console.log(`\n=== Done ===`);
  console.log(`  Classified : ${processed}`);
  console.log(`  Defaulted  : ${failed}`);
  await pool.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
