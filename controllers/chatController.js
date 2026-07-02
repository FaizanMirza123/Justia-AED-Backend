import OpenAI from "openai";
import pool from "../db/db.js";
import { hybridSearchExpanded } from "../models/chatModel.js";
import { extractStructuredFacts, generateQueryExpansions, resolveJurisdictionSlug } from "../utils/queryUnderstanding.js";
import { classifyApplicability, detectMissingLegislation } from "../utils/applicabilityAnalysis.js";
import { TOPICS, INDUSTRIES } from "../utils/taxonomy.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_MISSING_LEGISLATION_ROUNDS = 1;

const SYSTEM_PROMPT = `You are an AED (Automated External Defibrillator) law assistant for the Justia AED Laws platform. Your role is to help users understand AED-related laws, statutes, and bills across all U.S. states.

You will be given a CANDIDATE STATUTES list. Every statute in it has already been verified as
"directly_applicable" or "potentially_applicable" to the user's specific fact pattern (jurisdiction,
business/facility type, legal issue) — retrieval and applicability screening already happened upstream.
Do not second-guess whether a listed statute's general topic is relevant; do use your judgment about how
strongly it supports any specific sentence you write.

IMPORTANT RULES:
1. Base your answer only on the CANDIDATE STATUTES provided. Do not introduce statutes not listed. Do not
   make up statute numbers, section codes, or legal text.
2. For every sentence that relies on a specific statute, tag it immediately with [[CITE:<id>]] using the
   numeric id given for that candidate. Do not cite a statute you didn't actually rely on.
   [[CITE:<id>]] is the ONLY bracket-tag token you may ever output. Never output any other token that looks
   like [[SOMETHING]] — categories, section headers, and instructions given to you are things to describe
   in your own plain-language sentences, never to echo back as a literal tag.
3. If a candidate is marked "potentially_applicable", state the condition under which it would apply (given
   in its "condition" field) — do not present it as a settled, unconditional requirement.
4. If a candidate is a "bill" (document_type: "bill"), explicitly note that it is proposed/pending
   legislation, not yet enacted law, if you reference it.
5. Distinguish clearly between (a) mandatory legal requirements, (b) requirements conditional on facts not
   yet confirmed, and (c) best practices or recommendations that are not legally required.
5b. A candidate marked "Universal scope: yes" is baseline law for the whole jurisdiction — it applies to
    any person or entity regardless of the specific business/facility type the user described. Cite it as
    a direct, unconditional requirement or protection, not something contingent on facility type (e.g. a
    general AED-acquisition statute or a Good Samaritan civil-immunity statute).
6. You will be given a list called "categories of law not confirmed in our database". If that list is
   non-empty, write a plain-language sentence naming those categories (e.g. "local building code and OSHA
   requirements") and tell the user to consult the relevant local authority directly for those — do not
   guess at their requirements, and do not output the list as a tag or in brackets.
7. If CANDIDATE STATUTES is empty, clearly state: "Our database does not have specific information on this
   topic for the requested state/criteria." Then you may give general knowledge, clearly labeled as NOT from
   the database, with no [[CITE:]] tags.
8. Keep answers concise, well-structured, and easy to understand for non-legal professionals. Markdown is fine.
9. If asked about something completely unrelated to AED/CPR/emergency response laws, politely redirect to
   your area of expertise.
10. A candidate marked "Excerpt may be incomplete: yes" was scraped starting mid-section — it may be missing
    an earlier subdivision that defines a term it uses, or a condition/threshold (e.g. a size, occupancy, or
    membership requirement) that limits when the requirement applies. Do NOT present its requirement as
    unconditional. State the requirement as what the excerpt shows, then explicitly note that the full
    section may include additional conditions or definitions not shown here, and that the user should
    confirm the precise scope against the official statute before relying on it.
11. Read a candidate's ENTIRE text, not just its opening sentence — conditions, exceptions, occupancy/size
    thresholds, and defined terms (e.g. what "health studio" or "occupied structure" actually means for this
    section) are frequently stated in a later subdivision, not the one that states the top-line requirement.
    If any part of a candidate's text defines a term with a condition (e.g. "on a membership basis", an
    occupant-load threshold, a construction date, an exemption), you MUST state that condition in your
    answer — do not present a conditional or defined-term-dependent requirement as if it applies
    unconditionally just because the opening sentence reads that way.`;

/**
 * POST /api/chat
 * Body: { message, threadId, sessionId, filters: { state, topic, industry } }
 */
export async function handleChat(req, res) {
  try {
    const { message, threadId, sessionId, filters = {} } = req.body;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({ error: "Message is required." });
    }

    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === "your_openai_api_key_here") {
      return res.status(500).json({ error: "OpenAI API key is not configured." });
    }

    const userId = req.user?.id || null;

    // 1. Resolve or create thread
    let activeThreadId = threadId;
    if (!activeThreadId) {
      const maxAgeHours = parseInt(process.env.ANON_CHAT_MAX_AGE_HOURS || "24", 10);
      const expiresAt = userId ? null : new Date(Date.now() + maxAgeHours * 60 * 60 * 1000);

      const threadResult = await pool.query(
        `INSERT INTO chat_threads (user_id, session_id, title, filters, expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [userId, userId ? null : sessionId, message.slice(0, 100), JSON.stringify(filters), expiresAt]
      );
      activeThreadId = threadResult.rows[0].id;
    }

    // 2. Load conversation history + previously-resolved facts from DB
    const historyResult = await pool.query(
      `SELECT role, content FROM chat_messages WHERE thread_id = $1 ORDER BY created_at ASC`,
      [activeThreadId]
    );
    const history = historyResult.rows;

    const threadResult = await pool.query(`SELECT last_facts FROM chat_threads WHERE id = $1`, [activeThreadId]);
    const previousFacts = threadResult.rows[0]?.last_facts || null;

    // 3. Save user message to DB
    await pool.query(
      `INSERT INTO chat_messages (thread_id, role, content) VALUES ($1, 'user', $2)`,
      [activeThreadId, message]
    );

    // 4. Structured query understanding. A follow-up like "how is section
    // 1714.2 related here?" has no jurisdiction/industry/topic of its own —
    // inherit unstated fields from the previous turn instead of losing
    // context and searching every state.
    const extractedFacts = await extractStructuredFacts(message);
    const facts = mergeFacts(previousFacts, extractedFacts);
    applyExplicitFilters(facts, filters);

    let jurisdictionSlug = filters.state && filters.state !== "all"
      ? filters.state.toLowerCase().replace(/\s+/g, "-")
      : await resolveJurisdictionSlug(facts.jurisdiction);
    if (!jurisdictionSlug) {
      jurisdictionSlug = extractStateFromQuery(message);
    }

    const expansionQueries = await generateQueryExpansions(facts, message);

    // 5. Hybrid retrieval (metadata pre-filter + vector + BM25, RRF-fused)
    let candidates = await hybridSearchExpanded({ facts, jurisdictionSlug, expansionQueries, limit: 40 });

    // 6. Applicability ranking — this is the precision gate that drops
    // statutes that merely mention the same keywords but don't govern this
    // fact pattern (e.g. community care regs for a sports center question).
    let applicable = await classifyApplicability(facts, candidates);

    // 7. Missing legislation detection, with one bounded re-retrieval round.
    let missing = await detectMissingLegislation(facts, applicable);

    for (let round = 0; round < MAX_MISSING_LEGISLATION_ROUNDS && missing.missing_categories.length > 0; round++) {
      const targetedQueries = missing.missing_categories.map(
        (category) => `${facts.jurisdiction || ""} ${category} ${facts.legal_issue || ""}`.trim()
      );
      const extra = await hybridSearchExpanded({ facts, jurisdictionSlug, expansionQueries: targetedQueries, limit: 20 });

      const alreadySeenIds = new Set(candidates.map((c) => c.id));
      const newOnes = extra.filter((c) => !alreadySeenIds.has(c.id));
      if (newOnes.length === 0) break;

      const newlyClassified = await classifyApplicability(facts, newOnes);
      candidates = [...candidates, ...newOnes];
      applicable = mergeAndRankApplicable(applicable, newlyClassified);
      missing = await detectMissingLegislation(facts, applicable);
    }

    // 7b. Deterministic coverage check: every AED question has an applicable
    // Good Samaritan / civil-immunity law in its jurisdiction. Don't leave
    // this to the LLM's per-query judgment — if retrieval (including the
    // guaranteed universal-scope fetch) didn't surface one, that's a real
    // database gap and must be surfaced to the user, not silently dropped.
    if (jurisdictionSlug && !applicable.some((c) => c.state_slug === jurisdictionSlug && (c.topic || []).includes("Good Samaritan Protection"))) {
      if (!missing.missing_categories.includes("Good Samaritan Protection")) {
        missing.missing_categories = [...missing.missing_categories, "Good Samaritan Protection"];
      }
    }

    // 8. Build context + generate answer
    let dbContext;
    let usedWebFallback = false;

    if (applicable.length === 0) {
      usedWebFallback = true;
      dbContext = `No statutes in the database were found to be directly or potentially applicable to this
fact pattern. Filters applied: ${JSON.stringify(filters)}. Extracted facts: ${JSON.stringify(facts)}.
User question: "${message}"

Provide the best available general knowledge about AED laws related to the user's question. Clearly
indicate that this information is from general knowledge and not from the platform's database.`;
    } else {
      dbContext = buildDatabaseContext(applicable);
    }

    const openaiMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: `EXTRACTED FACTS:\n${JSON.stringify(facts)}` },
      { role: "system", content: `CANDIDATE STATUTES:\n${dbContext}` },
      {
        role: "system",
        content: `Categories of law not confirmed in our database: ${
          missing.missing_categories.length > 0 ? missing.missing_categories.join(", ") : "(none)"
        }`,
      },
    ];

    const recentHistory = history.slice(-20);
    for (const msg of recentHistory) {
      if (msg.role === "user" || msg.role === "assistant") {
        openaiMessages.push({ role: msg.role, content: msg.content });
      }
    }
    openaiMessages.push({ role: "user", content: message });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: openaiMessages,
      temperature: 0.3,
      max_tokens: 1500,
    });

    const rawReply = completion.choices[0]?.message?.content || "I'm sorry, I couldn't generate a response.";

    // 9. Citation filtering — only show sources the model actually cited,
    // and only if they were in the applicability-verified candidate set.
    const { cleanText, sources } = filterCitations(rawReply, applicable);

    // 10. Persist assistant message
    await pool.query(
      `INSERT INTO chat_messages (thread_id, role, content, sources, used_web_fallback)
       VALUES ($1, 'assistant', $2, $3, $4)`,
      [activeThreadId, cleanText, JSON.stringify(sources), usedWebFallback]
    );

    await pool.query(`UPDATE chat_threads SET updated_at = NOW(), last_facts = $2 WHERE id = $1`, [
      activeThreadId,
      JSON.stringify(facts),
    ]);

    return res.json({
      reply: cleanText,
      sources,
      usedWebFallback,
      missingCategories: missing.missing_categories,
      threadId: activeThreadId,
    });
  } catch (error) {
    console.error("Chat error:", error);

    if (error?.status === 401) {
      return res.status(500).json({ error: "Invalid OpenAI API key." });
    }
    if (error?.status === 429) {
      return res.status(429).json({ error: "Rate limit exceeded. Please try again shortly." });
    }

    return res.status(500).json({ error: "An error occurred while processing your question." });
  }
}

/**
 * Inherit unstated fields from the previous turn's resolved facts. Each
 * message is extracted in isolation, so a follow-up question that doesn't
 * restate the state/industry/topic would otherwise silently drop them —
 * this is what keeps retrieval jurisdiction-scoped across a conversation.
 * A field is only overridden when the current message clearly states one.
 */
function mergeFacts(previous, current) {
  if (!previous) return current;
  return {
    jurisdiction: current.jurisdiction ?? previous.jurisdiction ?? null,
    business_type: current.business_type ?? previous.business_type ?? null,
    industry: current.industry ?? previous.industry ?? null,
    legal_issue: current.legal_issue ?? previous.legal_issue ?? null,
    facility_status: current.facility_status ?? previous.facility_status ?? null,
    related_topics:
      current.related_topics && current.related_topics.length > 0
        ? [...new Set([...(previous.related_topics || []), ...current.related_topics])]
        : previous.related_topics || [],
  };
}

/** Let explicit UI filters (state/topic/industry dropdowns) override or seed extracted facts. */
function applyExplicitFilters(facts, filters) {
  if (filters.industry && filters.industry !== "all" && INDUSTRIES.includes(filters.industry)) {
    facts.industry = filters.industry;
  }
  if (filters.topic && filters.topic !== "all" && TOPICS.includes(filters.topic) && !facts.related_topics.includes(filters.topic)) {
    facts.related_topics = [...facts.related_topics, filters.topic];
  }
}

/** Merge newly classified candidates into an existing applicable list, re-sorted by tier then score. */
function mergeAndRankApplicable(applicable, newlyClassified) {
  // newlyClassified already had not_applicable/analogous_only dropped by
  // classifyApplicability() — this filter is a defense-in-depth backstop,
  // not the primary guarantee, so the two stay consistent even if a caller
  // changes.
  const TIER_ORDER = { directly_applicable: 0, potentially_applicable: 1 };
  const merged = [
    ...applicable,
    ...newlyClassified.filter((c) => c.classification === "directly_applicable" || c.classification === "potentially_applicable"),
  ];
  merged.sort((a, b) => {
    const tierDiff = TIER_ORDER[a.classification] - TIER_ORDER[b.classification];
    if (tierDiff !== 0) return tierDiff;
    return (b.rrf_score ?? 0) - (a.rrf_score ?? 0);
  });
  return merged;
}

/**
 * Parse [[CITE:<id>]] tags out of the generated answer, keep only citations
 * that (a) the model actually used and (b) were in the applicability-verified
 * candidate set — this is what prevents "retrieved but unused/irrelevant"
 * statutes from ever reaching the user, even if they were in context.
 */
function filterCitations(rawText, applicableCandidates) {
  const candidatesById = new Map(applicableCandidates.map((c) => [String(c.id), c]));
  const citedIds = new Set();

  for (const match of rawText.matchAll(/\[\[CITE:(\d+)\]\]/g)) {
    if (candidatesById.has(match[1])) citedIds.add(match[1]);
  }

  // Universal-scope statutes (general AED law, Good Samaritan immunity) must
  // always be listed as sources for their jurisdiction — don't rely on the
  // model remembering to tag every sentence that draws on them.
  for (const c of applicableCandidates) {
    if (c.universal_scope) citedIds.add(String(c.id));
  }

  // Strip real CITE tags, then defensively strip ANY other [[...]] token the
  // model might echo back (e.g. it once leaked a literal [[MISSING_CATEGORIES]]
  // from a system-message label) so no raw tag can ever reach the user.
  const cleanText = rawText
    .replace(/\s?\[\[CITE:\d+\]\]/g, "")
    .replace(/\s?\[\[[^\]]*\]\]/g, "")
    .trim();

  const sources = Array.from(citedIds).map((id) => {
    const c = candidatesById.get(id);
    return {
      title: c.title,
      state: c.state_name,
      section: c.section,
      url: c.justia_url,
      documentType: c.document_type,
      applicability: c.classification,
      excerptMayBeIncomplete: looksTruncated(c.description),
    };
  });

  return { cleanText, sources };
}

/**
 * The scraper that built this corpus recorded Google search-result snippets
 * rather than full statute pages (confirmed for the "Statutes and Bills" data
 * source) — many rows start mid-subdivision, e.g. at "(b)" instead of "(a)",
 * which means an earlier definition or a scope-limiting condition may be
 * missing from what we have. Detect this so the answer can hedge instead of
 * asserting a requirement is unconditional based on a partial excerpt.
 */
function looksTruncated(description) {
  return /^\s*\([b-z]\)/i.test(description || "");
}

function buildDatabaseContext(candidates) {
  const lines = [`Found ${candidates.length} applicable law(s):\n`];

  for (const c of candidates) {
    lines.push(`--- CANDIDATE id=${c.id} ---`);
    lines.push(`State: ${c.state_name}`);
    lines.push(`Title: ${c.title}`);
    if (c.section) lines.push(`Section: ${c.section}`);
    if (c.justia_url) lines.push(`Source URL: ${c.justia_url}`);
    lines.push(`Document type: ${c.document_type || "statute"}`);
    lines.push(`Universal scope: ${c.universal_scope ? "yes" : "no"}`);
    lines.push(`Excerpt may be incomplete: ${looksTruncated(c.description) ? "yes" : "no"}`);
    lines.push(`Applicability: ${c.classification} — ${c.reasoning || ""}`);
    if (c.classification === "potentially_applicable" && c.condition) {
      lines.push(`Condition to confirm applicability: ${c.condition}`);
    }
    // 2000 chars silently truncated the trailing definitions/conditions on
    // ~200 statutes in this corpus (verified on §19300 and §104113, where the
    // scope-limiting subdivisions live at the end of the text) before the
    // model ever saw them. 6000 covers those while still capping the rare
    // (~1.6% of rows) pathologically long bulk-scrape entries.
    const desc = c.description || "";
    lines.push(`Text: ${desc.length > 6000 ? desc.slice(0, 6000) + "..." : desc}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Attempt to extract a US state slug from free-form query text.
 * Fallback used only when structured extraction doesn't yield a jurisdiction.
 */
function extractStateFromQuery(query) {
  const normalized = " " + query.toLowerCase().replace(/[^\w\s]/g, " ") + " ";

  for (const { slug, name, abbreviation } of STATE_LIST) {
    const nameRegex = new RegExp(`\\b${name.replace(/-/g, "\\s+")}\\b`);
    if (nameRegex.test(normalized)) return slug;
    const abbrRegex = new RegExp(`\\b${abbreviation.toLowerCase()}\\b`);
    if (abbrRegex.test(normalized)) return slug;
  }
  return null;
}

const STATE_LIST = [
  { slug: "alabama", name: "alabama", abbreviation: "AL" },
  { slug: "alaska", name: "alaska", abbreviation: "AK" },
  { slug: "arizona", name: "arizona", abbreviation: "AZ" },
  { slug: "arkansas", name: "arkansas", abbreviation: "AR" },
  { slug: "california", name: "california", abbreviation: "CA" },
  { slug: "colorado", name: "colorado", abbreviation: "CO" },
  { slug: "connecticut", name: "connecticut", abbreviation: "CT" },
  { slug: "delaware", name: "delaware", abbreviation: "DE" },
  { slug: "florida", name: "florida", abbreviation: "FL" },
  { slug: "georgia", name: "georgia", abbreviation: "GA" },
  { slug: "hawaii", name: "hawaii", abbreviation: "HI" },
  { slug: "idaho", name: "idaho", abbreviation: "ID" },
  { slug: "illinois", name: "illinois", abbreviation: "IL" },
  { slug: "indiana", name: "indiana", abbreviation: "IN" },
  { slug: "iowa", name: "iowa", abbreviation: "IA" },
  { slug: "kansas", name: "kansas", abbreviation: "KS" },
  { slug: "kentucky", name: "kentucky", abbreviation: "KY" },
  { slug: "louisiana", name: "louisiana", abbreviation: "LA" },
  { slug: "maine", name: "maine", abbreviation: "ME" },
  { slug: "maryland", name: "maryland", abbreviation: "MD" },
  { slug: "massachusetts", name: "massachusetts", abbreviation: "MA" },
  { slug: "michigan", name: "michigan", abbreviation: "MI" },
  { slug: "minnesota", name: "minnesota", abbreviation: "MN" },
  { slug: "mississippi", name: "mississippi", abbreviation: "MS" },
  { slug: "missouri", name: "missouri", abbreviation: "MO" },
  { slug: "montana", name: "montana", abbreviation: "MT" },
  { slug: "nebraska", name: "nebraska", abbreviation: "NE" },
  { slug: "nevada", name: "nevada", abbreviation: "NV" },
  { slug: "new-hampshire", name: "new hampshire", abbreviation: "NH" },
  { slug: "new-jersey", name: "new jersey", abbreviation: "NJ" },
  { slug: "new-mexico", name: "new mexico", abbreviation: "NM" },
  { slug: "new-york", name: "new york", abbreviation: "NY" },
  { slug: "north-carolina", name: "north carolina", abbreviation: "NC" },
  { slug: "north-dakota", name: "north dakota", abbreviation: "ND" },
  { slug: "ohio", name: "ohio", abbreviation: "OH" },
  { slug: "oklahoma", name: "oklahoma", abbreviation: "OK" },
  { slug: "oregon", name: "oregon", abbreviation: "OR" },
  { slug: "pennsylvania", name: "pennsylvania", abbreviation: "PA" },
  { slug: "rhode-island", name: "rhode island", abbreviation: "RI" },
  { slug: "south-carolina", name: "south carolina", abbreviation: "SC" },
  { slug: "south-dakota", name: "south dakota", abbreviation: "SD" },
  { slug: "tennessee", name: "tennessee", abbreviation: "TN" },
  { slug: "texas", name: "texas", abbreviation: "TX" },
  { slug: "utah", name: "utah", abbreviation: "UT" },
  { slug: "vermont", name: "vermont", abbreviation: "VT" },
  { slug: "virginia", name: "virginia", abbreviation: "VA" },
  { slug: "washington", name: "washington", abbreviation: "WA" },
  { slug: "west-virginia", name: "west virginia", abbreviation: "WV" },
  { slug: "wisconsin", name: "wisconsin", abbreviation: "WI" },
  { slug: "wyoming", name: "wyoming", abbreviation: "WY" },
  { slug: "district-of-columbia", name: "district of columbia", abbreviation: "DC" },
];
