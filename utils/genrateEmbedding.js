import { ai } from "../config/open-ai.js";

export const createEmbedding = async (text, retries = 2) => {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await ai.embeddings.create({
        model: "gemini-embedding-001",
        input: text,
        dimensions: 1536,
      });
      return response.data[0].embedding;
    } catch (err) {
      if (attempt === retries) throw err; // last attempt pe fail hone do
      console.warn(`Embedding attempt ${attempt + 1} failed, retrying...`);
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
};
