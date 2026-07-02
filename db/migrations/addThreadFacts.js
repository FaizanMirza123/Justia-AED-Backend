/**
 * Migration: add `last_facts` to chat_threads.
 *
 * Structured facts (jurisdiction, industry, legal_issue, ...) are extracted
 * fresh from each message in isolation. A follow-up like "how is section
 * 1714.2 related here?" carries no jurisdiction/industry/topic of its own —
 * without persisting the previous turn's resolved facts, retrieval silently
 * loses the jurisdiction filter and searches all 51 states.
 *
 * Additive only — safe to re-run.
 *
 * Run from the project root:
 *   node db/migrations/addThreadFacts.js
 */

import pool from "../db.js";

async function migrate() {
  console.log("=== chat_threads.last_facts schema migration ===\n");

  await pool.query(`ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS last_facts JSONB;`);

  console.log("Schema migration complete.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
