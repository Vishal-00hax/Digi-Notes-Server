import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export const createEmbedding = async (text) => {
  try {
    const response = await ai.models.embedContent({
      model: "gemini-embedding-2",
      contents: text,
      config: {
        // Force the output to 1536 (or leave empty for the full 3072)
        outputDimensionality: 1536,
      },
    });
    return response.embeddings[0].values;
  } catch (err) {
    console.error("Gemini Error:", err);
    throw err;
  }
};
