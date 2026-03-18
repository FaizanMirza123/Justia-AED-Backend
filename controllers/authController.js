import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pool from "../db/db.js";

const TOKEN_EXPIRY = "7d";

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

/**
 * POST /api/auth/register
 */
export async function register(req, res) {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: "Name, email, and password are required." });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    // Check existing user
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, created_at",
      [email.toLowerCase(), passwordHash, name.trim()]
    );

    const user = result.rows[0];
    const token = generateToken(user);

    return res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (error) {
    console.error("Register error:", error);
    return res.status(500).json({ error: "Registration failed." });
  }
}

/**
 * POST /api/auth/login
 */
export async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const result = await pool.query(
      "SELECT id, email, name, password_hash FROM users WHERE email = $1",
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = generateToken(user);

    return res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Login failed." });
  }
}

/**
 * GET /api/auth/me
 */
export async function getMe(req, res) {
  return res.json({ user: req.user });
}

/**
 * Migrate anonymous session threads to an authenticated user.
 * Called after login/register with a sessionId.
 */
export async function migrateSessionThreads(req, res) {
  try {
    const { sessionId } = req.body;
    if (!sessionId || !req.user) {
      return res.json({ migrated: 0 });
    }

    const result = await pool.query(
      `UPDATE chat_threads
       SET user_id = $1, session_id = NULL, expires_at = NULL
       WHERE session_id = $2 AND user_id IS NULL`,
      [req.user.id, sessionId]
    );

    return res.json({ migrated: result.rowCount });
  } catch (error) {
    console.error("Migration error:", error);
    return res.status(500).json({ error: "Failed to migrate threads." });
  }
}
