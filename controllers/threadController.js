import pool from "../db/db.js";

/**
 * GET /api/threads - List user's threads (auth) or session threads (anon)
 */
export async function listThreads(req, res) {
  try {
    let result;

    if (req.user) {
      result = await pool.query(
        `SELECT id, title, filters, created_at, updated_at
         FROM chat_threads WHERE user_id = $1
         ORDER BY updated_at DESC LIMIT 50`,
        [req.user.id]
      );
    } else {
      const sessionId = req.query.sessionId;
      if (!sessionId) return res.json([]);

      result = await pool.query(
        `SELECT id, title, filters, created_at, updated_at
         FROM chat_threads
         WHERE session_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY updated_at DESC LIMIT 20`,
        [sessionId]
      );
    }

    return res.json(result.rows);
  } catch (error) {
    console.error("List threads error:", error);
    return res.status(500).json({ error: "Failed to list threads." });
  }
}

/**
 * POST /api/threads - Create a new thread
 */
export async function createThread(req, res) {
  try {
    const { title, filters, sessionId } = req.body;
    const userId = req.user?.id || null;
    const sid = userId ? null : sessionId || null;

    // Anonymous threads expire after configured hours
    const maxAgeHours = parseInt(process.env.ANON_CHAT_MAX_AGE_HOURS || "24", 10);
    const expiresAt = userId ? null : new Date(Date.now() + maxAgeHours * 60 * 60 * 1000);

    const result = await pool.query(
      `INSERT INTO chat_threads (user_id, session_id, title, filters, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, filters, created_at, updated_at`,
      [userId, sid, title || "New conversation", JSON.stringify(filters || {}), expiresAt]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Create thread error:", error);
    return res.status(500).json({ error: "Failed to create thread." });
  }
}

/**
 * GET /api/threads/:id/messages - Get all messages for a thread
 */
export async function getThreadMessages(req, res) {
  try {
    const threadId = req.params.id;

    // Verify access
    const thread = await pool.query("SELECT id, user_id, session_id FROM chat_threads WHERE id = $1", [threadId]);
    if (thread.rows.length === 0) {
      return res.status(404).json({ error: "Thread not found." });
    }

    const t = thread.rows[0];
    const sessionId = req.query.sessionId;

    // Auth check: must be owner or matching session
    if (t.user_id && req.user?.id !== t.user_id) {
      return res.status(403).json({ error: "Access denied." });
    }
    if (!t.user_id && t.session_id && t.session_id !== sessionId) {
      return res.status(403).json({ error: "Access denied." });
    }

    const result = await pool.query(
      `SELECT id, role, content, sources, used_web_fallback, created_at
       FROM chat_messages WHERE thread_id = $1
       ORDER BY created_at ASC`,
      [threadId]
    );

    return res.json(result.rows);
  } catch (error) {
    console.error("Get messages error:", error);
    return res.status(500).json({ error: "Failed to get messages." });
  }
}

/**
 * DELETE /api/threads/:id - Delete a thread
 */
export async function deleteThread(req, res) {
  try {
    const threadId = req.params.id;

    // Verify ownership
    const thread = await pool.query("SELECT user_id, session_id FROM chat_threads WHERE id = $1", [threadId]);
    if (thread.rows.length === 0) {
      return res.status(404).json({ error: "Thread not found." });
    }

    const t = thread.rows[0];
    if (t.user_id && req.user?.id !== t.user_id) {
      return res.status(403).json({ error: "Access denied." });
    }

    await pool.query("DELETE FROM chat_threads WHERE id = $1", [threadId]);
    return res.json({ success: true });
  } catch (error) {
    console.error("Delete thread error:", error);
    return res.status(500).json({ error: "Failed to delete thread." });
  }
}

/**
 * PATCH /api/threads/:id - Update thread title
 */
export async function updateThread(req, res) {
  try {
    const threadId = req.params.id;
    const { title } = req.body;

    const result = await pool.query(
      `UPDATE chat_threads SET title = $1, updated_at = NOW()
       WHERE id = $2 RETURNING id, title, updated_at`,
      [title, threadId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Thread not found." });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    console.error("Update thread error:", error);
    return res.status(500).json({ error: "Failed to update thread." });
  }
}
