
import pool from "./db.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const updateLaws = async () => {
    try {
        // 1. Add the column if it doesn't exist
        console.log("Adding justia_url column if it doesn't exist...");
        await pool.query(`
            ALTER TABLE laws 
            ADD COLUMN IF NOT EXISTS justia_url TEXT;
        `);
        console.log("Column check/creation complete.");

        // 2. Read the JSON file
        const jsonPath = path.join(__dirname, "..", "laws_with_urls.json");
        const data = await fs.readFile(jsonPath, "utf-8");
        const laws = JSON.parse(data);

        console.log(`Found ${laws.length} laws to process.`);

        // 3. Update each law
        // We can use a transaction or just loop. For simplicity and feedback, I'll loop.
        let updatedCount = 0;
        
        // Use a client for transaction if we wanted, but individual updates are fine here for this scale.
        for (const law of laws) {
             if (law.justia_url) {
                await pool.query(
                    `UPDATE laws SET justia_url = $1 WHERE id = $2`,
                    [law.justia_url, law.id]
                );
                updatedCount++;
            }
        }

        console.log(`Successfully updated ${updatedCount} laws with Justia URLs.`);

    } catch (err) {
        console.error("Error updating laws:", err);
    } finally {
        await pool.end();
    }
};

updateLaws();
