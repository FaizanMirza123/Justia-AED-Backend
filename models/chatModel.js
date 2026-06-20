import pool from "../db/db.js";
import { generateEmbedding, embeddingToSql } from "../utils/embeddingUtils.js";

/**
 * Search laws using hybrid vector + keyword search.
 * Falls back to keyword-only search when vector data is unavailable.
 */
export async function searchLaws({ query, state, topic, industry, limit = 15 }) {
  try {
    const embedding = await generateEmbedding(query);
    const results = await hybridSearch({ query, embedding, state, topic, industry, limit });
    if (results.length > 0) return results;
    // No vector matches (embeddings not yet generated) — fall through to keyword search
  } catch (err) {
    console.warn("[searchLaws] Vector search unavailable, using keyword fallback:", err.message);
  }
  return keywordSearch({ query, state, topic, industry, limit });
}

/**
 * Hybrid search: 70% cosine vector similarity + 30% full-text keyword relevance.
 * Only considers laws that already have embeddings stored.
 */
async function hybridSearch({ query, embedding, state, topic, industry, limit }) {
  const conditions = ["l.embedding IS NOT NULL"];
  const params = [embeddingToSql(embedding)]; // $1 = query vector
  let paramIndex = 2;

  if (state && state !== "all") {
    conditions.push(`(s.slug = $${paramIndex} OR LOWER(s.name) = $${paramIndex})`);
    params.push(state.toLowerCase().replace(/\s+/g, "-"));
    paramIndex++;
  }

  if (topic && topic !== "all") {
    const topicKeywords = TOPIC_MAP[topic];
    if (topicKeywords) {
      const topicConditions = topicKeywords.map((kw) => {
        params.push(`%${kw}%`);
        return `(LOWER(l.title) LIKE $${paramIndex} OR LOWER(l.description) LIKE $${paramIndex++})`;
      });
      conditions.push(`(${topicConditions.join(" OR ")})`);
    }
  }

  if (industry && industry !== "all" && industry !== "General Industry") {
    const industryKeywords = INDUSTRY_MAP[industry];
    if (industryKeywords) {
      const indConditions = industryKeywords.map((kw) => {
        params.push(`%${kw}%`);
        return `(LOWER(l.title) LIKE $${paramIndex} OR LOWER(l.description) LIKE $${paramIndex++})`;
      });
      conditions.push(`(${indConditions.join(" OR ")})`);
    }
  }

  const searchTerms = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  // Keyword score is 0 when there are no meaningful terms (pure vector search)
  let keywordScoreExpr = "0::float";
  if (searchTerms.length > 0) {
    params.push(searchTerms.join(" | "));
    const tsIdx = paramIndex++;
    keywordScoreExpr = `ts_rank_cd(
      to_tsvector('english', COALESCE(l.title, '') || ' ' || COALESCE(l.description, '')),
      to_tsquery('english', $${tsIdx})
    )`;
  }

  params.push(limit);
  const limitIdx = paramIndex;

  const sql = `
    SELECT l.id, l.title, l.description, l.justia_url, l.section,
           s.name AS state_name, s.slug AS state_slug, s.abbreviation,
           (0.7 * (1 - (l.embedding <=> $1::vector)) + 0.3 * ${keywordScoreExpr}) AS relevance
    FROM laws l
    JOIN states s ON l.state_id = s.id
    WHERE ${conditions.join(" AND ")}
    ORDER BY relevance DESC
    LIMIT $${limitIdx}
  `;

  const result = await pool.query(sql, params);
  return result.rows;
}

/**
 * Keyword-only search using PostgreSQL full-text search with ILIKE fallback.
 * Used when vector embeddings are not available.
 */
async function keywordSearch({ query, state, topic, industry, limit }) {
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  const searchTerms = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  if (state && state !== "all") {
    conditions.push(`(s.slug = $${paramIndex} OR LOWER(s.name) = $${paramIndex})`);
    params.push(state.toLowerCase().replace(/\s+/g, "-"));
    paramIndex++;
  }

  if (topic && topic !== "all") {
    const topicKeywords = TOPIC_MAP[topic];
    if (topicKeywords) {
      const topicConditions = topicKeywords.map((kw) => {
        params.push(`%${kw}%`);
        return `(LOWER(l.title) LIKE $${paramIndex} OR LOWER(l.description) LIKE $${paramIndex++})`;
      });
      conditions.push(`(${topicConditions.join(" OR ")})`);
    }
  }

  if (industry && industry !== "all" && industry !== "General Industry") {
    const industryKeywords = INDUSTRY_MAP[industry];
    if (industryKeywords) {
      const indConditions = industryKeywords.map((kw) => {
        params.push(`%${kw}%`);
        return `(LOWER(l.title) LIKE $${paramIndex} OR LOWER(l.description) LIKE $${paramIndex++})`;
      });
      conditions.push(`(${indConditions.join(" OR ")})`);
    }
  }

  let relevanceSelect = "1 AS relevance";
  if (searchTerms.length > 0) {
    const tsQuery = searchTerms.join(" | ");
    params.push(tsQuery);
    const tsParamIdx = paramIndex++;

    relevanceSelect = `ts_rank_cd(
      to_tsvector('english', COALESCE(l.title, '') || ' ' || COALESCE(l.description, '')),
      to_tsquery('english', $${tsParamIdx})
    ) AS relevance`;

    const ilikeConditions = searchTerms.slice(0, 5).map((term) => {
      params.push(`%${term}%`);
      return `(LOWER(l.title) LIKE $${paramIndex} OR LOWER(l.description) LIKE $${paramIndex++})`;
    });
    conditions.push(`(${ilikeConditions.join(" OR ")})`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT l.id, l.title, l.description, l.justia_url, l.section,
           s.name AS state_name, s.slug AS state_slug, s.abbreviation,
           ${relevanceSelect}
    FROM laws l
    JOIN states s ON l.state_id = s.id
    ${whereClause}
    ORDER BY relevance DESC
    LIMIT $${paramIndex}
  `;
  params.push(limit);

  const result = await pool.query(sql, params);
  return result.rows;
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

// --- Keyword maps matching the frontend classification ---

const TOPIC_MAP = {
  AED: ["automated external defibrillator", "aed", "defibrillator"],
  "CPR Training": [
    "cardiopulmonary resuscitation",
    "cpr training",
    "cpr certification",
    "resuscitation training",
    "basic life support",
    "bls training",
  ],
  "Trauma Kits": [
    "trauma kit",
    "bleeding control",
    "tourniquet",
    "hemostatic",
    "stop the bleed",
    "hemorrhage control",
  ],
};

const INDUSTRY_MAP = {
  "K-12 Education": [
    "school", "student", "k-12", "elementary", "secondary",
    "middle school", "high school", "teacher", "classroom",
  ],
  Government: [
    "government", "governmental", "public building", "state agency",
    "municipality", "state facility", "public agency",
  ],
  "Health Club / Fitness Studio / Gym": [
    "health club", "fitness", "gym", "exercise facility",
    "athletic club", "recreation center",
  ],
  "Dental Office": ["dental", "dentist"],
  "Passenger Railways": [
    "railway", "railroad", "passenger rail", "transit authority", "rail car",
  ],
  "Assisted Living": [
    "assisted living", "nursing home", "long-term care",
    "residential care", "senior care",
  ],
  "Youth Sports / Athletics": [
    "youth sport", "youth athletics", "youth league",
    "interscholastic", "youth program",
  ],
};

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "have", "been", "some", "them",
  "than", "its", "over", "such", "that", "this", "with", "will", "each",
  "from", "they", "were", "which", "their", "what", "there", "when", "who",
  "how", "about", "does", "into", "could", "would", "should", "these",
  "other", "being", "where", "after", "just", "also", "more", "any",
]);
