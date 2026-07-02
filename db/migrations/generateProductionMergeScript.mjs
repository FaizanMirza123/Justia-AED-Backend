/**
 * Generates a single, portable, plain-SQL script that brings production's
 * `laws` table (and one small chat_threads column) up to date with local:
 *   1. LLM-classified legal metadata (document_type, topic, industry,
 *      facility_type, universal_scope) for all rows.
 *   2. Full-text + re-embedded corrections for specific statutes that were
 *      found to be truncated mid-section during manual verification (see
 *      MANUALLY_CORRECTED_CITATIONS below) — these were NOT part of the
 *      classification pass and would otherwise never reach production.
 *   3. The `chat_threads.last_facts` column (schema only, no data —
 *      populated going forward as conversations happen).
 *
 * Does NOT touch row ids, and does NOT touch chat_messages, users, or auth
 * data. Does NOT rely on psql-specific meta-commands like \copy, so it runs
 * via any Postgres client.
 *
 * Rows are matched by the natural key (state slug, justia_url), verified
 * unique and non-null across the whole local `laws` table before this
 * script was written. Never matched by serial id, since local and
 * production databases were seeded independently and ids can diverge.
 *
 * The generated script is self-verifying: it wraps the merge in a
 * transaction and aborts (auto-rollback) if the match rate looks
 * suspiciously low, instead of silently committing a partial merge.
 *
 * Usage:
 *   node db/migrations/generateProductionMergeScript.mjs
 * Output:
 *   db/migrations/merge_legal_metadata_to_production.sql
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "merge_legal_metadata_to_production.sql");

// Statutes manually verified and corrected against the official source
// (leginfo.legislature.ca.gov) after discovering the scraper only captured
// Google search-result snippets, not full statute text. Add an entry here
// any time a future manual correction needs to reach production too.
const MANUALLY_CORRECTED_CITATIONS = [
  { stateSlug: "california", section: "19300" },
  { stateSlug: "california", section: "104113" },
];

function sqlString(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlTextArray(arr) {
  if (!arr || arr.length === 0) return "ARRAY[]::text[]";
  const items = arr.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(",");
  return `ARRAY[${items}]::text[]`;
}

async function generate() {
  const { rows } = await pool.query(`
    SELECT s.slug AS state_slug, l.justia_url, l.document_type, l.topic, l.industry,
           l.facility_type, l.universal_scope, (l.universal_scope_classified_at IS NOT NULL) AS universal_scope_checked
    FROM laws l JOIN states s ON l.state_id = s.id
    ORDER BY s.slug, l.justia_url
  `);

  console.log(`Fetched ${rows.length} classified rows from local DB.`);

  const expectedMin = Math.floor(rows.length * 0.95);

  const valuesRows = rows.map((r) => {
    return `    (${sqlString(r.state_slug)}, ${sqlString(r.justia_url)}, ${sqlString(r.document_type)}, ${sqlTextArray(r.topic)}, ${sqlTextArray(r.industry)}, ${sqlTextArray(r.facility_type)}, ${r.universal_scope ? "TRUE" : "FALSE"}, ${r.universal_scope_checked ? "TRUE" : "FALSE"})`;
  });

  // Full-text corrections: fetch current description + embedding (as a
  // pgvector text literal) for each manually-corrected citation.
  const correctionBlocks = [];
  for (const { stateSlug, section } of MANUALLY_CORRECTED_CITATIONS) {
    const { rows: correctionRows } = await pool.query(
      `SELECT l.justia_url, l.description, l.embedding::text AS embedding_text
       FROM laws l JOIN states s ON l.state_id = s.id
       WHERE s.slug = $1 AND l.section = $2`,
      [stateSlug, section]
    );
    for (const c of correctionRows) {
      correctionBlocks.push({ stateSlug, section, justiaUrl: c.justia_url, description: c.description, embeddingText: c.embedding_text });
    }
  }
  console.log(`Fetched ${correctionBlocks.length} manually-corrected statute row(s) for full-text sync.`);

  const correctionSql = correctionBlocks
    .map(
      (c) => `DO $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE laws AS l
  SET description = ${sqlString(c.description)},
      embedding = '${c.embeddingText}'::vector
  FROM states s
  WHERE l.state_id = s.id AND s.slug = ${sqlString(c.stateSlug)} AND l.justia_url = ${sqlString(c.justiaUrl)};
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count = 0 THEN
    RAISE WARNING 'Manual correction for % section % (justia_url %) did not match any production row — production may have a different scrape of this statute. Not fatal to the overall migration; investigate separately.', ${sqlString(c.stateSlug)}, ${sqlString(c.section)}, ${sqlString(c.justiaUrl)};
  ELSE
    RAISE NOTICE 'Applied manual text correction: % section %', ${sqlString(c.stateSlug)}, ${sqlString(c.section)};
  END IF;
END $$;`
    )
    .join("\n\n");

  const sql = `-- =====================================================================
-- Legal metadata production merge script
-- Generated ${new Date().toISOString()} from the local dev database.
--
-- WHAT THIS DOES:
--   1. Adds the new metadata columns to \`laws\`, plus \`chat_threads.last_facts\`
--      (additive, safe to re-run, IF NOT EXISTS everywhere — will not error
--      if already present).
--   2. Merges LLM-classified document_type/topic/industry/facility_type/
--      universal_scope values into existing production \`laws\` rows,
--      matched by (state slug, justia_url) — NEVER by row id, since ids can
--      differ between independently-seeded databases.
--   3. Applies ${correctionBlocks.length} manually-verified full-text correction(s) to
--      statutes found to be truncated mid-section during manual review
--      (updates \`description\` and re-embeds \`embedding\` for those rows only).
--   4. Touches ONLY \`laws\` and the single \`chat_threads.last_facts\` column.
--      Does not read/write chat_messages, users, or any other data.
--   5. Self-verifying: aborts the ENTIRE script (auto-rollback, nothing
--      committed) if fewer than 95% of the ${rows.length} local \`laws\` rows find
--      a match in production. A low match rate means production's laws data
--      has drifted from local (different scrape, edited rows, etc.) and
--      should be investigated before merging blindly. The manual text
--      corrections in step 3 are lower-stakes and only warn (not abort) if a
--      specific row doesn't match, since that's 1-2 known citations, not the
--      whole dataset's integrity.
--
-- HOW TO RUN:
--   Take a backup/snapshot of the production database first (e.g. your
--   hosting provider's point-in-time restore, or a manual pg_dump) before
--   running any migration against production, as a matter of course.
--
--   Then run this file with any Postgres client, e.g.:
--     psql "$PRODUCTION_DATABASE_URL" -f merge_legal_metadata_to_production.sql
--   or paste its contents into a GUI client (pgAdmin, TablePlus, etc.)
--   connected to production and execute it as one script.
--
--   On success it prints a NOTICE with the number of rows updated, then
--   commits automatically. On failure (low match rate, or any SQL error)
--   the whole script rolls back — nothing partial is left behind.
-- =====================================================================

BEGIN;

-- --- 1. Schema (additive only) ---
ALTER TABLE laws ADD COLUMN IF NOT EXISTS document_type VARCHAR(20) DEFAULT 'statute';
ALTER TABLE laws ADD COLUMN IF NOT EXISTS topic TEXT[] DEFAULT '{}';
ALTER TABLE laws ADD COLUMN IF NOT EXISTS industry TEXT[] DEFAULT '{}';
ALTER TABLE laws ADD COLUMN IF NOT EXISTS facility_type TEXT[] DEFAULT '{}';
ALTER TABLE laws ADD COLUMN IF NOT EXISTS metadata_classified_at TIMESTAMP;
ALTER TABLE laws ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))) STORED;
ALTER TABLE laws ADD COLUMN IF NOT EXISTS universal_scope BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE laws ADD COLUMN IF NOT EXISTS universal_scope_classified_at TIMESTAMP;
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS last_facts JSONB;

CREATE INDEX IF NOT EXISTS idx_laws_tsv ON laws USING GIN (tsv);
CREATE INDEX IF NOT EXISTS idx_laws_topic ON laws USING GIN (topic);
CREATE INDEX IF NOT EXISTS idx_laws_industry ON laws USING GIN (industry);
CREATE INDEX IF NOT EXISTS idx_laws_facility_type ON laws USING GIN (facility_type);
CREATE INDEX IF NOT EXISTS idx_laws_document_type ON laws (document_type);
CREATE INDEX IF NOT EXISTS idx_laws_universal_scope ON laws (universal_scope) WHERE universal_scope = TRUE;

-- --- 2. Data merge (matched by state slug + justia_url, verified unique
--        and non-null across all ${rows.length} local rows) ---
DO $$
DECLARE
  expected_min INTEGER := ${expectedMin}; -- 95% of ${rows.length} local rows
  updated_count INTEGER;
  local_row_count INTEGER := ${rows.length};
BEGIN
  WITH v(state_slug, justia_url, document_type, topic, industry, facility_type, universal_scope, universal_scope_checked) AS (
    VALUES
${valuesRows.join(",\n")}
  ),
  resolved AS (
    SELECT s.id AS state_id, v.justia_url, v.document_type, v.topic, v.industry, v.facility_type,
           v.universal_scope, v.universal_scope_checked
    FROM v JOIN states s ON s.slug = v.state_slug
  ),
  upd AS (
    UPDATE laws AS l
    SET document_type = r.document_type,
        topic = r.topic,
        industry = r.industry,
        facility_type = r.facility_type,
        universal_scope = r.universal_scope,
        metadata_classified_at = NOW(),
        universal_scope_classified_at = CASE WHEN r.universal_scope_checked THEN NOW() ELSE l.universal_scope_classified_at END
    FROM resolved r
    WHERE l.state_id = r.state_id AND l.justia_url = r.justia_url
    RETURNING l.id
  )
  SELECT count(*) INTO updated_count FROM upd;

  RAISE NOTICE 'Local rows: % | Matched and updated in production: %', local_row_count, updated_count;

  IF updated_count < expected_min THEN
    RAISE EXCEPTION 'Only % of % local rows matched (below the % minimum) — aborting without committing. This means production''s laws table has drifted from local (different scrape run, edited/removed rows, etc.). Investigate before re-running; do not lower the threshold just to force a commit.', updated_count, local_row_count, expected_min;
  END IF;
END $$;

-- --- 3. Manually-verified full-text corrections (see MANUALLY_CORRECTED_CITATIONS
--        in generateProductionMergeScript.mjs) — warns but does not abort the
--        transaction if a specific citation doesn't match production. ---
${correctionSql}

COMMIT;
`;

  fs.writeFileSync(OUTPUT_PATH, sql, "utf8");
  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`Expected match threshold: ${expectedMin} / ${rows.length} rows (95%)`);
  await pool.end();
}

generate().catch((err) => {
  console.error("Failed to generate merge script:", err);
  process.exit(1);
});
