import OpenAI from "openai";
import { searchLaws } from "../models/chatModel.js";
import pool from "../db/db.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are an AED (Automated External Defibrillator) law assistant for the Justia AED Laws platform. Your role is to help users understand AED-related laws, statutes, and bills across all U.S. states.

IMPORTANT RULES:
1. You MUST base your answers on the provided database context when available. Do not make up laws or statutes.
2. When citing a law, always include the state name, law title, and section if available.
3. If the database context contains relevant laws, use them to answer. Be specific and reference actual statute text.
4. If no relevant laws are found in the database, clearly state: "Our database does not have specific information on this topic for the requested state/criteria." Then provide your best knowledge from general AED law awareness, but clearly label it as general information NOT from the database.
5. Never hallucinate or fabricate statute numbers, section codes, or specific legal text.
6. Keep answers concise, well-structured, and easy to understand for non-legal professionals.
7. If the user asks about a specific state, focus only on that state's laws.
8. When filters are applied (topic, industry), focus your answer on those specific areas.
9. You may use markdown formatting for readability (bold, bullet points, etc.).
10. If asked about something completely unrelated to AED/CPR/emergency response laws, politely redirect to your area of expertise.`;

/**
 * POST /api/chat
 * Body: { message, threadId, sessionId, filters: { state, topic, industry } }
 */
export async function handleChat(req, res) {
  try {
    const { message, threadId, sessionId, filters = {} } = req.body;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({ error: "Message is required." });
    }

    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === "your_openai_api_key_here") {
      return res.status(500).json({ error: "OpenAI API key is not configured." });
    }

    const userId = req.user?.id || null;

    // 1. Resolve or create thread
    let activeThreadId = threadId;
    if (!activeThreadId) {
      // Create a new thread
      const maxAgeHours = parseInt(process.env.ANON_CHAT_MAX_AGE_HOURS || "24", 10);
      const expiresAt = userId ? null : new Date(Date.now() + maxAgeHours * 60 * 60 * 1000);

      const threadResult = await pool.query(
        `INSERT INTO chat_threads (user_id, session_id, title, filters, expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [userId, userId ? null : sessionId, message.slice(0, 100), JSON.stringify(filters), expiresAt]
      );
      activeThreadId = threadResult.rows[0].id;
    }

    // 2. Load conversation history from DB
    const historyResult = await pool.query(
      `SELECT role, content FROM chat_messages
       WHERE thread_id = $1 ORDER BY created_at ASC`,
      [activeThreadId]
    );
    const history = historyResult.rows;

    // 3. Save user message to DB
    await pool.query(
      `INSERT INTO chat_messages (thread_id, role, content) VALUES ($1, 'user', $2)`,
      [activeThreadId, message]
    );

    // 4. Search the database for relevant laws (RAG retrieval)
    const dbResults = await searchLaws({
      query: message,
      state: filters.state || null,
      topic: filters.topic || null,
      industry: filters.industry || null,
      limit: 15,
    });

    // 5. Build context from DB results
    let dbContext = "";
    let usedWebFallback = false;

    if (dbResults.length > 0) {
      dbContext = buildDatabaseContext(dbResults);
    } else {
      usedWebFallback = true;
      dbContext = `No relevant laws were found in the database for this query.
Filters applied: ${JSON.stringify(filters)}
User question: "${message}"

Since no database results were found, provide the best available general knowledge about AED laws related to the user's question. Clearly indicate that this information is from general knowledge and not from the platform's database. If possible, suggest which states might have relevant legislation.`;
    }

    // 6. Build conversation messages for OpenAI
    const openaiMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: `DATABASE CONTEXT:\n${dbContext}` },
    ];

    // Add conversation history (last 20 messages max)
    const recentHistory = history.slice(-20);
    for (const msg of recentHistory) {
      if (msg.role === "user" || msg.role === "assistant") {
        openaiMessages.push({ role: msg.role, content: msg.content });
      }
    }

    openaiMessages.push({ role: "user", content: message });

    // 7. Call OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: openaiMessages,
      temperature: 0.3,
      max_tokens: 1500,
    });

    const reply = completion.choices[0]?.message?.content || "I'm sorry, I couldn't generate a response.";

    // 8. Build source references from DB results
    const sources = dbResults.slice(0, 5).map((law) => ({
      title: law.title,
      state: law.state_name,
      section: law.section,
      url: law.justia_url,
    }));

    // 9. Save assistant message to DB
    await pool.query(
      `INSERT INTO chat_messages (thread_id, role, content, sources, used_web_fallback)
       VALUES ($1, 'assistant', $2, $3, $4)`,
      [activeThreadId, reply, JSON.stringify(sources), usedWebFallback]
    );

    // 10. Update thread's updated_at timestamp
    await pool.query(
      `UPDATE chat_threads SET updated_at = NOW() WHERE id = $1`,
      [activeThreadId]
    );

    return res.json({
      reply,
      sources,
      usedWebFallback,
      threadId: activeThreadId,
    });
  } catch (error) {
    console.error("Chat error:", error);

    if (error?.status === 401) {
      return res.status(500).json({ error: "Invalid OpenAI API key." });
    }
    if (error?.status === 429) {
      return res.status(429).json({ error: "Rate limit exceeded. Please try again shortly." });
    }

    return res.status(500).json({ error: "An error occurred while processing your question." });
  }
}

function buildDatabaseContext(laws) {
  const lines = [`Found ${laws.length} relevant law(s) in the database:\n`];

  for (const law of laws) {
    lines.push(`--- LAW ---`);
    lines.push(`State: ${law.state_name} (${law.abbreviation})`);
    lines.push(`Title: ${law.title}`);
    if (law.section) lines.push(`Section: ${law.section}`);
    if (law.justia_url) lines.push(`Source URL: ${law.justia_url}`);
    const desc = law.description || "";
    lines.push(`Text: ${desc.length > 2000 ? desc.slice(0, 2000) + "..." : desc}`);
    lines.push("");
  }

  return lines.join("\n");
}
