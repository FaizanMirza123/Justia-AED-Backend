import pool from "../db/db.js";

// Get all states
export async function getAllStates() {
  const result = await pool.query(
    "SELECT id, name, abbreviation, slug, summary FROM states ORDER BY name ASC"
  );
  return result.rows;
}

// Get details of a state by slug
export async function getStateDetails(slug) {
  const result = await pool.query(
    "SELECT s.id, s.name, s.abbreviation, s.slug, s.summary, l.title AS law_title, l.description AS law_description, l.justia_url " +
    "FROM states s LEFT JOIN laws l ON s.id = l.state_id WHERE s.slug = $1",
    [slug]
  );

  if (result.rows.length === 0) return null;

  // Combine multiple laws into array
  const state = {
    slug: result.rows[0].slug,
    name: result.rows[0].name,
    summary: result.rows[0].summary,
    laws: result.rows.map((r) => r.law_title ? { title: r.law_title, description: r.law_description, justia_url: r.justia_url } : null).filter(Boolean)
  };

  return state;
}
