/**
 * seedFromFiles.js
 *
 * Reads every state folder inside "Statutes and Bills/", extracts statutes
 * from the *_statutes_final.jsonl file and bills from bills.json, then
 * inserts everything into PostgreSQL.
 *
 * Run with:  node db/seedFromFiles.js
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import pool from "./db.js";
import { createTables } from "./createTables.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "..", "Statutes and Bills");
const BATCH_SIZE = 200;

// ─── State metadata ──────────────────────────────────────────────────────────

const STATE_ABBREVIATIONS = {
  "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR",
  "California": "CA", "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE",
  "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID",
  "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS",
  "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD",
  "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS",
  "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV",
  "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
  "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK",
  "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC",
  "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX", "Utah": "UT",
  "Vermont": "VT", "Virginia": "VA", "Washington": "WA", "West Virginia": "WV",
  "Wisconsin": "WI", "Wyoming": "WY", "District of Columbia": "DC",
};

// Case-insensitive reverse map: "maryland" → "Maryland"
const CANONICAL_NAME = Object.fromEntries(
  Object.keys(STATE_ABBREVIATIONS).map((name) => [name.toLowerCase(), name])
);

/** Convert a state name to a URL slug, e.g. "New York" → "new-york" */
function toSlug(name) {
  return name.toLowerCase().replace(/\s+/g, "-");
}

/** Extract the last meaningful path segment from a URL.
 *  "https://law.justia.com/codes/alabama/.../section-6-5-332-3/" → "section-6-5-332-3"
 */
function lastUrlSegment(url) {
  if (!url) return null;
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : null;
  } catch {
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read a file as a stream of parsed JSON lines (JSONL). Returns an array. */
async function readJsonl(filePath) {
  const rows = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return rows;
}

/**
 * Insert rows in batches using a multi-row VALUES clause.
 * @param {string} sql  SQL up to VALUES – placeholder indices start at $1
 * @param {Array[]}  batches  array of value arrays
 * @param {Function} buildRow  (item) => [...values]
 */
async function batchInsert(baseColumns, tableName, items, buildRow) {
  if (!items.length) return 0;
  let inserted = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    const colCount = buildRow(chunk[0]).length;

    const placeholders = chunk
      .map((_, rowIdx) =>
        "(" +
        Array.from({ length: colCount }, (__, colIdx) => `$${rowIdx * colCount + colIdx + 1}`).join(", ") +
        ")"
      )
      .join(", ");

    const values = chunk.flatMap(buildRow);

    await pool.query(
      `INSERT INTO ${tableName} (${baseColumns}) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
      values
    );
    inserted += chunk.length;
  }
  return inserted;
}

// ─── Clear existing data ──────────────────────────────────────────────────────

async function clearTables() {
  console.log("🧹  Clearing existing data …");
  await pool.query("TRUNCATE TABLE laws   RESTART IDENTITY CASCADE");
  await pool.query("TRUNCATE TABLE states RESTART IDENTITY CASCADE");
  console.log("    Tables cleared.\n");
}

// ─── Main seeder ─────────────────────────────────────────────────────────────

async function seed() {
  await createTables();
  await clearTables();

  // List every sub-directory in "Statutes and Bills"
  const stateFolders = fs
    .readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let totalStates = 0;
  let totalStatutes = 0;
  let totalBills = 0;

  for (const folderName of stateFolders) {
    const folderPath = path.join(DATA_DIR, folderName);

    // ── Find the JSONL statute file ──────────────────────────────────────────
    const allFiles = fs.readdirSync(folderPath);
    const jsonlFile = allFiles.find(
      (f) => f.endsWith("_statutes_final.jsonl") && !f.endsWith(".progress.json")
    );

    if (!jsonlFile) {
      console.warn(`⚠️   No statute JSONL found in "${folderName}", skipping.`);
      continue;
    }

    const jsonlPath = path.join(folderPath, jsonlFile);
    const statutes = await readJsonl(jsonlPath);

    // ── Determine canonical state name ───────────────────────────────────────
    // Prefer the `state` field from the first JSONL row, then fall back to the
    // folder name.  In both cases normalise to the canonical spelling so the
    // abbreviation lookup always succeeds (e.g. "MaryLand" → "Maryland").
    const rawName =
      statutes.length > 0 ? statutes[0].state : normalizeFolderName(folderName);
    const stateName = CANONICAL_NAME[rawName.toLowerCase()] ?? rawName;

    const abbreviation = STATE_ABBREVIATIONS[stateName] ?? null;
    const slug = toSlug(stateName);

    // ── Upsert state ─────────────────────────────────────────────────────────
    const stateResult = await pool.query(
      `INSERT INTO states (name, abbreviation, slug)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, abbreviation = EXCLUDED.abbreviation
       RETURNING id`,
      [stateName, abbreviation, slug]
    );
    const stateId = stateResult.rows[0].id;
    totalStates++;

    // ── Insert statutes ───────────────────────────────────────────────────────
    // Title = "StateName last-url-segment", e.g. "Alabama section-6-5-332-3"
    const statuteCount = await batchInsert(
      "state_id, title, description, justia_url, section",
      "laws",
      statutes,
      (s) => {
        const urlSlug = lastUrlSegment(s.link);
        const title = urlSlug ? `${stateName} ${urlSlug}` : stateName;
        return [stateId, title, s.description ?? null, s.link ?? null, s.section ?? null];
      }
    );
    totalStatutes += statuteCount;

    // ── Insert bills into laws ────────────────────────────────────────────────
    // Bills share the laws table: title = bill_id, description = bill title/description
    const billsPath = path.join(folderPath, "bills.json");
    let billCount = 0;

    if (fs.existsSync(billsPath)) {
      const raw = fs.readFileSync(billsPath, "utf8").trim();
      const bills = raw ? JSON.parse(raw) : [];

      billCount = await batchInsert(
        "state_id, title, description, justia_url, section",
        "laws",
        bills,
        (b) => [
          stateId,
          b.bill_id ?? null,
          b.description ?? b.title ?? null,
          b.link ?? null,
          b.bill_id ?? null,
        ]
      );
      totalBills += billCount;
    }

    console.log(
      `✅  ${stateName.padEnd(25)} (${abbreviation ?? "?? "})  ` +
      `statutes: ${String(statuteCount).padStart(4)}   bills: ${String(billCount).padStart(4)}`
    );
  }

  console.log("\n─────────────────────────────────────────────");
  console.log(`🎉  Done!`);
  console.log(`    States   : ${totalStates}`);
  console.log(`    Statutes : ${totalStatutes}`);
  console.log(`    Bills    : ${totalBills}`);
  console.log("─────────────────────────────────────────────\n");

  await pool.end();
}

/** Fallback: turn a folder name into a properly-cased state name */
function normalizeFolderName(folder) {
  // Handle known edge cases
  const overrides = {
    idaho: "Idaho",
    maryland: "Maryland",
    "district of columbia": "District of Columbia",
  };
  const key = folder.toLowerCase();
  return overrides[key] ?? folder.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Run ──────────────────────────────────────────────────────────────────────

seed().catch((err) => {
  console.error("❌  Seeding failed:", err);
  pool.end();
  process.exit(1);
});
