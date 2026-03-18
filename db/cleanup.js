import pool from "./db.js";

/**
 * Deletes expired anonymous chat threads and their messages.
 * Runs periodically via setInterval in the server.
 */
export async function cleanupExpiredThreads() {
  try {
    const result = await pool.query(
      `DELETE FROM chat_threads WHERE expires_at IS NOT NULL AND expires_at < NOW()`
    );
    if (result.rowCount > 0) {
      console.log(`🧹 Cleaned up ${result.rowCount} expired anonymous chat thread(s)`);
    }
  } catch (error) {
    console.error("Cleanup error:", error);
  }
}

/**
 * Start the cleanup interval (runs every hour)
 */
export function startCleanupScheduler() {
  // Run once on startup
  cleanupExpiredThreads();
  // Then every hour
  setInterval(cleanupExpiredThreads, 60 * 60 * 1000);
  console.log("🕐 Anonymous chat cleanup scheduler started (every 1 hour)");
}
