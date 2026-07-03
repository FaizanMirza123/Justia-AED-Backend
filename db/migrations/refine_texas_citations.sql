-- =====================================================================
-- Texas citation refinement — production script
-- Generated 2026-07-03 from a manual review request.
--
-- WHAT THIS DOES:
--   Removes 3 specific Texas `laws` rows, matched by exact justia_url
--   (never by row id, since local/production ids can diverge):
--
--   1. https://regulations.justia.com/states/texas/title-22/part-9/chapter-173/section-173-2/
--      — explicitly flagged for removal (not relevant to this dataset's scope).
--   2. https://regulations.justia.com/states/texas/title-26/part-1/chapter-505/subchapter-i/section-505-163/
--      — explicitly flagged for removal.
--   3. https://law.justia.com/codes/texas/education-code/title-2/subtitle-f/chapter-28/subchapter-a/
--      — a chapter-level stub with no real content (just a table-of-contents
--        line). Superseded by the already-present, correctly-scoped row at
--        .../subchapter-a/section-28-0023/, which is NOT touched by this
--        script and remains in the database.
--
--   Does NOT touch any other row. In particular, it does NOT remove
--   https://law.justia.com/codes/arizona/2005/title36/02262.html (explicitly
--   flagged to KEEP), even though that row's title says "Texas 02262.html"
--   while its content is Arizona AED law (references Ariz. Rev. Stat.
--   § 36-2264) — this is a known scraper mislabeling issue, left as-is per
--   instruction, not something this script attempts to fix.
--
--   Self-verifying: if fewer than 3 rows match and get deleted, the whole
--   transaction aborts (auto-rollback) instead of silently deleting a
--   partial/unexpected set — this would mean production's Texas data has
--   already diverged from what this script expects.
--
-- HOW TO RUN:
--   Back up production first (point-in-time restore or manual pg_dump).
--   Then:
--     psql "$PRODUCTION_DATABASE_URL" -f refine_texas_citations.sql
--   or paste into any GUI Postgres client (pgAdmin, TablePlus, etc.)
--   connected to production and run as one script.
--
--   On success, prints a NOTICE listing exactly which rows were deleted,
--   then commits. On failure (row count mismatch, or any SQL error), the
--   whole script rolls back — nothing partial is left behind.
-- =====================================================================

BEGIN;

DO $$
DECLARE
  deleted_count INTEGER;
  deleted_row RECORD;
  urls_to_remove TEXT[] := ARRAY[
    'https://regulations.justia.com/states/texas/title-22/part-9/chapter-173/section-173-2/',
    'https://regulations.justia.com/states/texas/title-26/part-1/chapter-505/subchapter-i/section-505-163/',
    'https://law.justia.com/codes/texas/education-code/title-2/subtitle-f/chapter-28/subchapter-a/'
  ];
BEGIN
  FOR deleted_row IN
    DELETE FROM laws
    WHERE state_id = (SELECT id FROM states WHERE slug = 'texas')
      AND justia_url = ANY(urls_to_remove)
    RETURNING id, title, justia_url
  LOOP
    RAISE NOTICE 'Deleted law id=% title=% url=%', deleted_row.id, deleted_row.title, deleted_row.justia_url;
    deleted_count := COALESCE(deleted_count, 0) + 1;
  END LOOP;

  IF deleted_count IS NULL OR deleted_count < array_length(urls_to_remove, 1) THEN
    RAISE EXCEPTION 'Expected to delete % row(s) but only matched %. Production''s Texas data may have already diverged from local (already deleted, URL changed, etc.) — aborting without committing. Investigate before re-running.', array_length(urls_to_remove, 1), COALESCE(deleted_count, 0);
  END IF;
END $$;

COMMIT;
