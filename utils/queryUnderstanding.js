/**
 * Structured query understanding: turns a free-form legal question into
 * structured facts (jurisdiction, business type, industry, legal issue, ...)
 * and expands those facts into multiple targeted search queries.
 *
 * This is what lets retrieval answer "what statutes GOVERN this scenario"
 * instead of "what statutes MENTION these words".
 */

import OpenAI from "openai";
import pool from "../db/db.js";
import { TOPICS, INDUSTRIES, FACILITY_STATUSES } from "./taxonomy.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = "gpt-4o-mini";

const EXTRACTION_SYSTEM_PROMPT = `You are a legal-intake classifier for a statute retrieval system. Extract
structured facts from the user's question. Do not answer the legal question. Do not guess facts the
user didn't state or clearly imply — use null or an empty array instead of inferring.

Output ONLY valid JSON matching this schema:
{
  "jurisdiction": string | null,       // full US state name, or "Federal", or null if not stated
  "business_type": string | null,      // the specific kind of establishment, e.g. "Sports Center"
  "industry": string | null,           // pick the single closest match from this allowed list, or null: ${JSON.stringify(INDUSTRIES)}
  "legal_issue": string | null,        // the specific compliance question, e.g. "AED Requirement"
  "facility_status": ${JSON.stringify(FACILITY_STATUSES)} or null,
  "related_topics": string[]           // adjacent regulatory categories a lawyer would also check,
                                        // drawn from this allowed list where possible: ${JSON.stringify([...TOPICS, ...INDUSTRIES])}
}`;

const EXPANSION_SYSTEM_PROMPT = `Given structured legal facts and the user's original question, generate 6-10
short search queries a legal researcher would use to find statutes and regulations that could govern this
scenario. Vary the phrasing (industry terms, facility terms, general legal category terms) so lexical and
semantic search each have good targets. Do not include queries about clearly unrelated facility types.
Always include the jurisdiction in each query if one is known.

Output ONLY valid JSON: {"queries": ["...", "..."]}`;

export async function extractStructuredFacts(question) {
  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: question },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    });

    const facts = JSON.parse(completion.choices[0].message.content);
    return {
      jurisdiction: facts.jurisdiction ?? null,
      business_type: facts.business_type ?? null,
      industry: INDUSTRIES.includes(facts.industry) ? facts.industry : null,
      legal_issue: facts.legal_issue ?? null,
      facility_status: FACILITY_STATUSES.includes(facts.facility_status) ? facts.facility_status : null,
      related_topics: Array.isArray(facts.related_topics) ? facts.related_topics : [],
    };
  } catch (err) {
    console.warn("[extractStructuredFacts] LLM extraction failed, using empty facts:", err.message);
    return {
      jurisdiction: null,
      business_type: null,
      industry: null,
      legal_issue: null,
      facility_status: null,
      related_topics: [],
    };
  }
}

export async function generateQueryExpansions(facts, originalQuestion) {
  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: EXPANSION_SYSTEM_PROMPT },
        {
          role: "user",
          content: `FACTS:\n${JSON.stringify(facts)}\n\nORIGINAL QUESTION:\n${originalQuestion}`,
        },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    const queries = Array.isArray(parsed.queries) ? parsed.queries.filter((q) => typeof q === "string" && q.trim()) : [];
    return queries.length > 0 ? queries : [originalQuestion];
  } catch (err) {
    console.warn("[generateQueryExpansions] LLM expansion failed, using original question only:", err.message);
    return [originalQuestion];
  }
}

/**
 * Resolve a free-text jurisdiction (e.g. "California", "Federal") to a state
 * slug in the `states` table. Returns null if it can't be matched to a
 * specific state (e.g. "Federal", or no jurisdiction stated).
 */
export async function resolveJurisdictionSlug(jurisdiction) {
  if (!jurisdiction) return null;
  const normalized = jurisdiction.trim().toLowerCase();
  if (normalized === "federal") return null;

  const result = await pool.query(
    `SELECT slug FROM states WHERE LOWER(name) = $1 OR LOWER(abbreviation) = $1 LIMIT 1`,
    [normalized]
  );
  return result.rows[0]?.slug ?? null;
}
