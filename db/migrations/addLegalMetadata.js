/**
 * Migration: add legal-applicability metadata columns to `laws`.
 *
 * Additive only — safe to re-run. Does not touch existing data.
 *
 * Run from the project root:
 *   node db/migrations/addLegalMetadata.js
 */

import pool from "../db.js";

async function migrate() {
  console.log("=== Legal metadata schema migration ===\n");

  await pool.query(`ALTER TABLE laws ADD COLUMN IF NOT EXISTS document_type VARCHAR(20) DEFAULT 'statute';`);
  await pool.query(`ALTER TABLE laws ADD COLUMN IF NOT EXISTS topic TEXT[] DEFAULT '{}';`);
  await pool.query(`ALTER TABLE laws ADD COLUMN IF NOT EXISTS industry TEXT[] DEFAULT '{}';`);
  await pool.query(`ALTER TABLE laws ADD COLUMN IF NOT EXISTS facility_type TEXT[] DEFAULT '{}';`);
  await pool.query(`ALTER TABLE laws ADD COLUMN IF NOT EXISTS metadata_classified_at TIMESTAMP;`);

  // Generated tsvector column for BM25-style full text ranking (title + description)
  await pool.query(`
    ALTER TABLE laws ADD COLUMN IF NOT EXISTS tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))) STORED;
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_laws_tsv ON laws USING GIN (tsv);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_laws_topic ON laws USING GIN (topic);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_laws_industry ON laws USING GIN (industry);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_laws_facility_type ON laws USING GIN (facility_type);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_laws_document_type ON laws (document_type);`);

  console.log("Schema migration complete.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
