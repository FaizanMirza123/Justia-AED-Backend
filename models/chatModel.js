import pool from "../db/db.js";

/**
 * Search laws using PostgreSQL full-text search + ILIKE fallback.
 * Returns the most relevant laws based on the user's query and optional filters.
 */
export async function searchLaws({ query, state, topic, industry, limit = 15 }) {
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  // Extract meaningful search terms from the query
  const searchTerms = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  // --- State filter ---
  if (state && state !== "all") {
    conditions.push(`(s.slug = $${paramIndex} OR LOWER(s.name) = $${paramIndex})`);
    params.push(state.toLowerCase().replace(/\s+/g, "-"));
    paramIndex++;
  }

  // --- Topic keyword filter ---
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

  // --- Industry keyword filter ---
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

  // --- Full-text search on query terms ---
  let relevanceSelect = "1 AS relevance";
  if (searchTerms.length > 0) {
    const tsQuery = searchTerms.join(" | ");
    params.push(tsQuery);
    const tsParamIdx = paramIndex++;

    relevanceSelect = `ts_rank_cd(
      to_tsvector('english', COALESCE(l.title, '') || ' ' || COALESCE(l.description, '')),
      to_tsquery('english', $${tsParamIdx})
    ) AS relevance`;

    // Also add ILIKE fallback so partial matches still return results
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
