/**
 * Migration: classify which AED/Good-Samaritan/CPR/emergency-medical
 * statutes are "universal scope" — i.e. their own text applies broadly to
 * any person/entity in the state, not a specific facility or industry type.
 *
 * Scoped to statutes already tagged with a relevant topic (~1,700 rows)
 * rather than the full 3,624-row corpus, since only those can plausibly be
 * universal-scope AED/emergency-care law.
 *
 * Idempotent and resumable: only processes rows where
 * universal_scope_classified_at IS NULL.
 *
 * Run from the project root (after addUniversalScope.js):
 *   node db/migrations/classifyUniversalScope.js
 */

import OpenAI from "openai";
import pool from "../db.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const BATCH_SIZE = 15;
const INTER_BATCH_DELAY_MS = 300;
const MODEL = "gpt-4o-mini";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SYSTEM_PROMPT = `You are a legal scope classifier. For each statute excerpt, determine whether it is
"universal_scope": true or false.

universal_scope = true means the statute's OWN TEXT imposes an obligation or grants a protection on any
person/entity/employer in the state, with no restriction to a specific facility type, industry, or
organization category. Typical examples: a general AED acquisition/placement/maintenance law that applies
to "a person or entity that acquires an AED" or to "an occupied building"; a Good Samaritan / civil immunity
statute protecting "any person" who renders emergency care; an employer-policy statute applying to
employers generally.

universal_scope = false means any of:
- the statute is limited to a specific facility/industry/organization type (e.g. "health studio", "school",
  "dental office", "passenger railway", "assisted living facility"),
- the statute is unrelated to AED/CPR/emergency-care obligations or protections entirely,
- the text has NO OPERATIVE LEGAL EFFECT on a private person or entity — e.g. a pure "declaration of
  legislative intent" / "it is the policy of this state that..." preamble clause, or a provision describing
  what a COUNTY or other GOVERNMENT AGENCY's plan/program must contain (that governs government planning,
  not a private business or individual, and creates no requirement or protection for one).

Only mark universal_scope = true when the text itself would let a person read it and say "this statute
requires me to do X" or "this statute protects me from liability for Y" — not when it merely expresses
legislative aspiration or describes internal government process.

Return ONLY valid JSON: {"results": [{"id": <int>, "universal_scope": true|false}, ...]}
One object per input item, same ids as given, no extra commentary.`;

function buildUserPrompt(batch) {
  const items = batch.map((law) => ({
    id: law.id,
    state: law.state_name,
    section: law.section,
    text: (law.description || law.title || "").slice(0, 1500),
  }));
  return `Classify these ${items.length} items:\n${JSON.stringify(items, null, 2)}`;
}

async function classifyBatch(batch) {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(batch) },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const parsed = JSON.parse(completion.choices[0].message.content);
  return Array.isArray(parsed.results) ? parsed.results : [];
}

async function migrate() {
  console.log("=== universal_scope classification backfill ===\n");

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM laws
     WHERE universal_scope_classified_at IS NULL
       AND document_type = 'statute'
       AND topic && ARRAY['AED','Good Samaritan Protection','CPR Training','Emergency Medical']`
  );
  const total = countRows[0].n;

  if (total === 0) {
    console.log("Nothing to classify. Nothing to do.");
    await pool.end();
    return;
  }

  console.log(`Classifying ${total} candidate statutes (batch size ${BATCH_SIZE})...\n`);

  let processed = 0;
  let failed = 0;

  while (true) {
    const { rows: batch } = await pool.query(
      `SELECT l.id, l.title, l.description, l.section, s.name AS state_name
       FROM laws l JOIN states s ON l.state_id = s.id
       WHERE l.universal_scope_classified_at IS NULL
         AND l.document_type = 'statute'
         AND l.topic && ARRAY['AED','Good Samaritan Protection','CPR Training','Emergency Medical']
       LIMIT $1`,
      [BATCH_SIZE]
    );

    if (batch.length === 0) break;

    try {
      const results = await classifyBatch(batch);
      const resultsById = new Map(results.map((r) => [r.id, r]));

      for (const law of batch) {
        const r = resultsById.get(law.id);
        const universalScope = r?.universal_scope === true;
        await pool.query(
          `UPDATE laws SET universal_scope = $1, universal_scope_classified_at = NOW() WHERE id = $2`,
          [universalScope, law.id]
        );
        if (!r) failed++;
        else processed++;
      }

      console.log(`  Progress: ${processed + failed} / ${total} (${failed} defaulted to false)`);
    } catch (err) {
      if (err?.status === 429) {
        console.warn("  Rate limited by OpenAI — waiting 60 s...");
        await sleep(60_000);
        continue;
      }
      console.error(`  [error] batch starting at law ${batch[0].id}: ${err.message}`);
      for (const law of batch) {
        await pool.query(
          `UPDATE laws SET universal_scope = FALSE, universal_scope_classified_at = NOW() WHERE id = $1`,
          [law.id]
        );
        failed++;
      }
    }

    await sleep(INTER_BATCH_DELAY_MS);
  }

  console.log(`\n=== Done ===`);
  console.log(`  Classified : ${processed}`);
  console.log(`  Defaulted  : ${failed}`);
  await pool.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
