import pool from "../db/db.js";
import { generateEmbedding, embeddingToSql } from "../utils/embeddingUtils.js";
import { TOPICS } from "../utils/taxonomy.js";

const RRF_K = 60;

/**
 * Run one hybrid (vector + BM25) retrieval pass for a single query string,
 * pre-filtered by jurisdiction and (when available) industry/topic metadata.
 *
 * `requireMetadataOverlap` controls the filter tier:
 *   true  -> jurisdiction AND (industry or topic overlap)   [tier 1, precise]
 *   false -> jurisdiction only                               [tier 2, relaxed fallback]
 */
async function hybridSearchOnce({ queryText, jurisdictionSlug, industryFilter, topicFilter, requireMetadataOverlap, limit }) {
  const embedding = await generateEmbedding(queryText);

  const conditions = ["l.embedding IS NOT NULL"];
  const params = [embeddingToSql(embedding)]; // $1
  let paramIndex = 2;

  if (jurisdictionSlug) {
    conditions.push(`s.slug = $${paramIndex}`);
    params.push(jurisdictionSlug);
    paramIndex++;
  }

  if (requireMetadataOverlap && (industryFilter?.length || topicFilter?.length)) {
    const overlapClauses = [];
    if (industryFilter?.length) {
      overlapClauses.push(`l.industry && $${paramIndex}::text[]`);
      params.push(industryFilter);
      paramIndex++;
    }
    if (topicFilter?.length) {
      overlapClauses.push(`l.topic && $${paramIndex}::text[]`);
      params.push(topicFilter);
      paramIndex++;
    }
    conditions.push(`(${overlapClauses.join(" OR ")})`);
  }

  const tsQueryIdx = paramIndex;
  params.push(queryText);
  paramIndex++;

  params.push(limit);
  const limitIdx = paramIndex;

  const sql = `
    WITH vector_ranked AS (
      SELECT l.id, row_number() OVER (ORDER BY l.embedding <=> $1::vector) AS vec_rank
      FROM laws l JOIN states s ON l.state_id = s.id
      WHERE ${conditions.join(" AND ")}
      ORDER BY l.embedding <=> $1::vector
      LIMIT 50
    ),
    bm25_ranked AS (
      SELECT l.id, row_number() OVER (
        ORDER BY ts_rank_cd(l.tsv, plainto_tsquery('english', $${tsQueryIdx})) DESC
      ) AS bm25_rank
      FROM laws l JOIN states s ON l.state_id = s.id
      WHERE ${conditions.join(" AND ")}
        AND l.tsv @@ plainto_tsquery('english', $${tsQueryIdx})
      ORDER BY bm25_rank
      LIMIT 50
    )
    SELECT
      l.id, l.title, l.description, l.justia_url, l.section,
      l.document_type, l.topic, l.industry, l.facility_type, l.universal_scope,
      s.name AS state_name, s.slug AS state_slug, s.abbreviation,
      COALESCE(1.0 / (${RRF_K} + v.vec_rank), 0) + COALESCE(1.0 / (${RRF_K} + b.bm25_rank), 0) AS rrf_score
    FROM laws l
    JOIN states s ON l.state_id = s.id
    LEFT JOIN vector_ranked v ON v.id = l.id
    LEFT JOIN bm25_ranked b ON b.id = l.id
    WHERE v.id IS NOT NULL OR b.id IS NOT NULL
    ORDER BY rrf_score DESC
    LIMIT $${limitIdx}
  `;

  const result = await pool.query(sql, params);
  return result.rows;
}

/**
 * Statutes whose own text applies broadly to any person/entity in the
 * jurisdiction (general AED law, Good Samaritan immunity, etc.) — these are
 * baseline law, not industry-specific, so they're fetched unconditionally
 * rather than relying on metadata-overlap filtering or embedding similarity.
 */
async function fetchUniversalScopeLaws(jurisdictionSlug) {
  if (!jurisdictionSlug) return [];

  const result = await pool.query(
    `SELECT l.id, l.title, l.description, l.justia_url, l.section,
            l.document_type, l.topic, l.industry, l.facility_type, l.universal_scope,
            s.name AS state_name, s.slug AS state_slug, s.abbreviation
     FROM laws l JOIN states s ON l.state_id = s.id
     WHERE s.slug = $1 AND l.universal_scope = TRUE AND l.document_type = 'statute'
       -- '*.html'-titled rows are legacy bulk-page scrapes; in this corpus they've
       -- consistently turned out to be duplicate content of an already-present,
       -- cleanly-cited individual section, so they're excluded from this
       -- guaranteed-include set rather than surfaced as separate citations.
       AND l.title NOT ILIKE '%.html'`,
    [jurisdictionSlug]
  );
  return dedupeByCitation(result.rows);
}

/**
 * The scraped corpus contains repeat scrapes of the same statute under
 * slightly different section formatting (e.g. "1797-196" / "1797.196" /
 * "section-1797.196" from different scrape years). Normal ranked retrieval
 * hides this because only top-N by score surface; guaranteed-include sets
 * don't have that natural filter, so dedupe explicitly by normalized
 * section (falling back to normalized title when section is missing).
 */
function dedupeByCitation(rows) {
  const seen = new Map();
  for (const row of rows) {
    const rawKey = row.section && row.section !== "N/A" ? row.section : row.title;
    // Digits-only: "1797.196", "1797-196", and "...section-1797.196" all
    // collapse to the same key regardless of separator/prefix formatting.
    const digits = rawKey.replace(/[^0-9]/g, "");
    const key = `${row.state_slug}:${digits || rawKey.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    const existing = seen.get(key);
    // Prefer a row with a clean section number over one whose section is
    // "N/A" (title-only citation) so the displayed source looks sane.
    if (!existing || (existing.section === "N/A" && row.section !== "N/A")) {
      seen.set(key, row);
    }
  }
  return Array.from(seen.values());
}

/**
 * Hybrid retrieval across multiple expanded queries, merged by summing RRF
 * scores per law (a statute hit by several expansions is a stronger
 * applicability signal than one hit by a single lucky phrase).
 *
 * Falls back from a metadata-filtered tier to a jurisdiction-only tier when
 * the precise tier returns too few candidates for a given query, so a
 * mis-canonicalized industry/topic term can't zero out retrieval entirely.
 */
export async function hybridSearchExpanded({ facts, jurisdictionSlug, expansionQueries, limit = 40 }) {
  const industryFilter = facts?.industry ? [facts.industry] : [];
  const topicFilter = (facts?.related_topics || []).filter((t) => TOPICS.includes(t));
  const MIN_TIER1_RESULTS = 3;

  const merged = new Map();

  for (const queryText of expansionQueries) {
    let rows = [];
    try {
      rows = await hybridSearchOnce({
        queryText,
        jurisdictionSlug,
        industryFilter,
        topicFilter,
        requireMetadataOverlap: true,
        limit: 20,
      });

      if (rows.length < MIN_TIER1_RESULTS) {
        const fallbackRows = await hybridSearchOnce({
          queryText,
          jurisdictionSlug,
          industryFilter,
          topicFilter,
          requireMetadataOverlap: false,
          limit: 20,
        });
        // Merge, preferring tier-1 rows already collected (higher precision)
        const seen = new Set(rows.map((r) => r.id));
        for (const r of fallbackRows) if (!seen.has(r.id)) rows.push(r);
      }
    } catch (err) {
      console.warn(`[hybridSearchExpanded] query "${queryText}" failed:`, err.message);
      continue;
    }

    for (const row of rows) {
      const existing = merged.get(row.id);
      if (existing) {
        existing.rrf_score += row.rrf_score;
        existing.matched_queries += 1;
      } else {
        merged.set(row.id, { ...row, matched_queries: 1 });
      }
    }
  }

  // Universal-scope statutes (general AED law, Good Samaritan immunity, etc.)
  // are baseline law for the jurisdiction — guarantee their inclusion instead
  // of leaving them to compete on embedding/BM25 score against narrower,
  // more specifically-worded candidates.
  const universalRows = await fetchUniversalScopeLaws(jurisdictionSlug);
  for (const row of universalRows) {
    if (!merged.has(row.id)) {
      merged.set(row.id, { ...row, rrf_score: 0, matched_queries: 0 });
    }
  }

  // Dedupe across BOTH sources together (ranked hybrid search and the
  // guaranteed universal-scope fetch each independently found rows), not
  // just within one — the same statute can otherwise reach the final list
  // twice as separate duplicate-scrape rows with different ids.
  const deduped = dedupeByCitation(Array.from(merged.values()));

  const ranked = deduped.sort((a, b) => b.rrf_score - a.rrf_score);
  const guaranteed = ranked.filter((r) => r.universal_scope);
  const rest = ranked.filter((r) => !r.universal_scope);

  return [...guaranteed, ...rest.slice(0, Math.max(0, limit - guaranteed.length))];
}

/**
 * Get all distinct state names for filter options
 */
export async function getAllStateNames() {
  const result = await pool.query(
    "SELECT name, slug, abbreviation FROM states ORDER BY name ASC"
  );
  return result.rows;
}
