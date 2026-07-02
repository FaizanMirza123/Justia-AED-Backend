/**
 * Migration: add `universal_scope` metadata to `laws`.
 *
 * Some statutes are not industry- or facility-specific — they apply broadly
 * to any person/entity in the jurisdiction (e.g. a general AED
 * acquisition/maintenance law, or a Good Samaritan civil-immunity statute
 * covering anyone who renders emergency aid). Those must never be filtered
 * out by industry/facility metadata matching or left to per-query LLM
 * judgment — they are baseline law for the whole state.
 *
 * Additive only — safe to re-run.
 *
 * Run from the project root:
 *   node db/migrations/addUniversalScope.js
 */

import pool from "../db.js";

async function migrate() {
  console.log("=== universal_scope schema migration ===\n");

  await pool.query(`ALTER TABLE laws ADD COLUMN IF NOT EXISTS universal_scope BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE laws ADD COLUMN IF NOT EXISTS universal_scope_classified_at TIMESTAMP;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_laws_universal_scope ON laws (universal_scope) WHERE universal_scope = TRUE;`);

  console.log("Schema migration complete.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
