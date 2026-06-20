import pool from "./db.js";

export const createTables = async () => {
  try {
    // Enable pgvector extension (must exist before any vector column is created)
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

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

    // Add embedding column to existing laws tables (idempotent)
    await pool.query(`
      ALTER TABLE laws ADD COLUMN IF NOT EXISTS embedding vector(1536);
    `);

    // HNSW index for fast cosine-distance nearest-neighbour search
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_laws_embedding_hnsw
      ON laws USING hnsw (embedding vector_cosine_ops);
    `);

    // Drop legacy bills table if it exists from a previous schema
    await pool.query(`DROP TABLE IF EXISTS bills CASCADE;`);

    // -------------------
    // Auth & Chat tables
    // -------------------
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_threads (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        session_id VARCHAR(100),
        title VARCHAR(255) DEFAULT 'New conversation',
        filters JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        thread_id INTEGER REFERENCES chat_threads(id) ON DELETE CASCADE NOT NULL,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        sources JSONB DEFAULT '[]',
        used_web_fallback BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Index for cleaning up expired anonymous threads
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_threads_expires_at
      ON chat_threads(expires_at) WHERE expires_at IS NOT NULL;
    `);

    // Index for user thread lookups
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_threads_user_id
      ON chat_threads(user_id) WHERE user_id IS NOT NULL;
    `);

    // Index for session-based anonymous thread lookups
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_threads_session_id
      ON chat_threads(session_id) WHERE session_id IS NOT NULL;
    `);

    console.log("✅ Tables created successfully");

  } catch (error) {
    console.error("❌ Table creation/seeding error:", error);
  }
};
