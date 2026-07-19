import ai from "../config/open-ai.js";

export const createEmbedding = async (text) => {
  try {
    const response = await ai.embeddings.create({
      model: "gemini-embedding-001",
      input: text,
      dimensions: 1536, // OpenAI-style parameter name
    });
    return response.data[0].embedding;
  } catch (err) {
    console.error("Gemini Error:", err);
    throw err;
  }
};
