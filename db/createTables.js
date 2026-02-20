import pool from "./db.js";

export const createTables = async () => {
  try {
    // -------------------
    // Create tables
    // -------------------
    await pool.query(`
      CREATE TABLE IF NOT EXISTS states (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        abbreviation VARCHAR(5) UNIQUE,
        slug VARCHAR(50) UNIQUE,
        summary TEXT
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS laws (
        id SERIAL PRIMARY KEY,
        state_id INTEGER REFERENCES states(id),
        title VARCHAR(255),
        description TEXT,
        justia_url TEXT,
        section VARCHAR(100)
      );
    `);

    // Drop legacy bills table if it exists from a previous schema
    await pool.query(`DROP TABLE IF EXISTS bills CASCADE;`);

    console.log("✅ Tables created successfully");

  } catch (error) {
    console.error("❌ Table creation/seeding error:", error);
  }
};
