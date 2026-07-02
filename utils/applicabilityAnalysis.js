/**
 * Post-retrieval legal applicability analysis.
 *
 * Retrieval (vector + BM25 + metadata filter) answers "what's plausibly
 * relevant". This module answers the actual legal question: "does this
 * statute's scope actually cover the user's fact pattern, or does it just
 * mention the same keywords". That distinction is what stops e.g. community
 * care facility regulations from outranking health club regulations for a
 * sports center question.
 */

import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = "gpt-4o-mini";
const CLASSIFY_BATCH_SIZE = 10;

const TIER_ORDER = {
  directly_applicable: 0,
  potentially_applicable: 1,
  analogous_only: 2,
  not_applicable: 3,
};

const CLASSIFY_SYSTEM_PROMPT = `You are a legal applicability analyst. You are given a fact pattern and a
list of candidate statutes/regulations retrieved by search. For EACH candidate, determine how it applies
to the fact pattern. Do not answer the user's underlying legal question — only classify applicability.

Classify each candidate as exactly one of:
- "directly_applicable": the statute's stated scope explicitly covers this business/facility type and
  legal issue, AND the fact pattern confirms every condition/defined-term the statute's applicability
  depends on.
- "potentially_applicable": the statute could apply depending on facts not yet known. This includes the
  case where the statute's applicability hinges on a DEFINED TERM (e.g. "health studio" requires
  "on a membership basis") or a numeric/factual THRESHOLD (e.g. occupant load, square footage,
  construction/renovation date) that the given fact pattern does not confirm — read the candidate's full
  text for such definitions/thresholds, not just its opening sentence, before marking anything
  directly_applicable. Also use this tier for a closely related facility type governed under the same
  regulatory scheme.
- "analogous_only": the statute addresses the same general topic (e.g. AEDs) but governs a clearly
  different, unrelated facility type or industry. Not legally binding here, but may be informative context.
- "not_applicable": the statute's scope excludes this fact pattern entirely.

WORKED EXAMPLE (do not skip this pattern just because the business type "sounds like" an obvious match):
Fact pattern: business_type = "Sports Center", industry = "Health Club / Fitness Studio / Gym".
Candidate statute text: "(a) Every health studio ... shall acquire an AED ... (h) 'health studio' means a
facility permitting use of its equipment to individuals or groups for physical exercise ... ON A MEMBERSHIP
BASIS."
The user never said their sports center operates on a membership basis — "sports center" could equally be a
pay-per-visit facility, a league/tournament venue, or a rental space, none of which would meet this
statute's own definition. The correct classification here is "potentially_applicable" with
condition = "confirm the facility operates on a membership basis, per the statute's definition of 'health
studio' in subdivision (h)" — NOT "directly_applicable". General industry-label similarity ("Health Club")
is not the same as the fact pattern satisfying the statute's own defined term.

For each candidate return exactly:
{ "id": <candidate id>, "classification": "...", "reasoning": "<one sentence>", "condition": "<if potentially_applicable, state the exact defined-term or threshold that must be confirmed, else empty string>" }

Output ONLY valid JSON: {"results": [ ... ]}, one object per candidate, in the same order given.`;

const MISSING_LEGISLATION_SYSTEM_PROMPT = `You are a legal research completeness checker. Given the
structured fact pattern and the categories of law actually found (from directly_applicable or
potentially_applicable retrieval results), determine whether any expected category of governing law was
NOT found. Use general legal knowledge of what typically regulates this kind of business, not the
retrieved text itself.

Output ONLY valid JSON: {"missing_categories": ["..."], "reasoning": "<why each is expected but absent>"}
If nothing important is missing, return an empty array for missing_categories.`;

function buildCandidateForPrompt(c) {
  return {
    id: c.id,
    jurisdiction: c.state_name,
    citation: c.section || c.title,
    document_type: c.document_type,
    industry: c.industry,
    facility_type: c.facility_type,
    topic: c.topic,
    // Definitions and thresholds that gate a statute's applicability often
    // sit in a later subdivision, not the opening sentence — a short slice
    // here means the classifier never sees them at all (verified: cut off
    // the "on a membership basis" condition on CA HSC §104113 entirely).
    text: (c.description || "").slice(0, 6000),
  };
}

async function classifyOneBatch(facts, batch) {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
      {
        role: "user",
        content: `FACTS:\n${JSON.stringify(facts)}\n\nCANDIDATES:\n${JSON.stringify(
          batch.map(buildCandidateForPrompt),
          null,
          2
        )}`,
      },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const parsed = JSON.parse(completion.choices[0].message.content);
  return Array.isArray(parsed.results) ? parsed.results : [];
}

/**
 * Classify every candidate's applicability to the fact pattern.
 * Returns candidates merged with { classification, reasoning, condition },
 * sorted by tier (directly_applicable first) then by retrieval score.
 * `not_applicable` candidates are dropped entirely — this is the precision
 * gate that keeps irrelevant-but-similar statutes out of the final answer.
 */
export async function classifyApplicability(facts, candidates) {
  if (candidates.length === 0) return [];

  // Universal-scope statutes (general AED law, Good Samaritan immunity) apply
  // to any entity in the jurisdiction by definition — skip the LLM judgment
  // call for them entirely so they can never be mis-demoted for not matching
  // the user's specific facility/industry.
  const universalCandidates = candidates.filter((c) => c.universal_scope);
  const otherCandidates = candidates.filter((c) => !c.universal_scope);

  const classifiedById = new Map();
  for (const c of universalCandidates) {
    classifiedById.set(c.id, {
      id: c.id,
      classification: "directly_applicable",
      reasoning: "This is a baseline statute that applies to any person or entity in this jurisdiction, regardless of business or facility type.",
      condition: "",
    });
  }

  for (let i = 0; i < otherCandidates.length; i += CLASSIFY_BATCH_SIZE) {
    const batch = otherCandidates.slice(i, i + CLASSIFY_BATCH_SIZE);
    try {
      const results = await classifyOneBatch(facts, batch);
      for (const r of results) classifiedById.set(r.id, r);
    } catch (err) {
      console.warn("[classifyApplicability] batch failed, treating as potentially_applicable:", err.message);
      // Fail open toward caution rather than silently dropping candidates:
      // mark unclassifiable candidates as potentially_applicable so a
      // transient LLM error can't hide real law from the user.
      for (const c of batch) {
        classifiedById.set(c.id, {
          id: c.id,
          classification: "potentially_applicable",
          reasoning: "Applicability could not be automatically verified.",
          condition: "",
        });
      }
    }
  }

  // Keep only directly/potentially applicable candidates. "analogous_only"
  // (same topic, different facility/industry — e.g. a community-care AED
  // rule surfacing for a sports-center question) is deliberately dropped
  // here rather than left to the answer-generation model's judgment to
  // exclude — this is the deterministic guarantee that irrelevant sources
  // never reach the user, not a request to the model to please not cite them.
  const merged = candidates
    .map((c) => {
      const verdict = classifiedById.get(c.id);
      if (!verdict) return null;
      return { ...c, ...verdict };
    })
    .filter((c) => c && (c.classification === "directly_applicable" || c.classification === "potentially_applicable"));

  merged.sort((a, b) => {
    const tierDiff = TIER_ORDER[a.classification] - TIER_ORDER[b.classification];
    if (tierDiff !== 0) return tierDiff;
    return (b.rrf_score ?? 0) - (a.rrf_score ?? 0);
  });

  return merged;
}

export async function detectMissingLegislation(facts, applicableCandidates) {
  const foundCategories = [
    ...new Set(
      applicableCandidates.flatMap((c) => [...(c.topic || []), ...(c.industry || [])])
    ),
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: MISSING_LEGISLATION_SYSTEM_PROMPT },
        {
          role: "user",
          content: `FACTS:\n${JSON.stringify(facts)}\n\nCATEGORIES_FOUND:\n${JSON.stringify(foundCategories)}`,
        },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    return {
      missing_categories: Array.isArray(parsed.missing_categories) ? parsed.missing_categories : [],
      reasoning: parsed.reasoning || "",
    };
  } catch (err) {
    console.warn("[detectMissingLegislation] failed, assuming no gaps:", err.message);
    return { missing_categories: [], reasoning: "" };
  }
}
