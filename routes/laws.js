// backend/routes/laws.js
import express from "express";
import pool from "../db/db.js";
const router = express.Router();

// GET all laws
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT l.*, s.slug AS state_slug, s.name AS state_name
      FROM laws l
      JOIN states s ON l.state_id = s.id
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET laws by state slug
router.get("/:slug", async (req, res) => {
  const { slug } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT l.*, s.slug AS state_slug, s.name AS state_name
       FROM laws l
       JOIN states s ON l.state_id = s.id
       WHERE s.slug = $1`,
      [slug]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


export default router;












