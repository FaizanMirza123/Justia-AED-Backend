import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Generate a text embedding using OpenAI's text-embedding-3-small model.
 * Returns a 1536-dimensional float array.
 */
export async function generateEmbedding(text) {
  const cleanText = text.replace(/\s+/g, " ").trim().slice(0, 8000);
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: cleanText,
  });
  return response.data[0].embedding;
}

/**
 * Convert a JS float array to a PostgreSQL vector literal string.
 * e.g. [0.1, 0.2, 0.3] → "[0.1,0.2,0.3]"
 */
export function embeddingToSql(embedding) {
  return `[${embedding.join(",")}]`;
}
