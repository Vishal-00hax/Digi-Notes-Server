import ai from "../config/open-ai.js";
import { createEmbedding } from "../utils/genrateEmbedding.js";
import Notes from "../models/notes.js";

export const askNotes = async (req, res) => {
  try {
    const userId = req.user._id;
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({ message: "Please ask a question" });
    }

    const questionEmbedding = await createEmbedding(question);

    const relatedNotes = await Notes.aggregate([
      {
        $vectorSearch: {
          index: "note_vector_index", // Index Name
          path: "embedding", // Searching field
          queryVector: questionEmbedding, // Embedded Query
          numCandidates: 100, // select top 100 searches
          limit: 5, // Sort top 5 from numCandidates
          filter: { userId: userId }, // Get only request user relatedNotes
        },
      },
      {
        $project: {
          title: 1,
          text: 1,
          updatedAt: 1,
          _id: 0,
          score: { $meta: "vectorSearchScore" },
        },
      }, // Select specific keys from schema
      {
        $match: {
          score: { $gte: 0.75 }, // ✅ sirf genuinely relevant notes rakho
        },
      },
    ]);

    if (relatedNotes.length === 0) {
      return res
        .status(404)
        .json({ message: "I did not found any relevant notes" });
    }

    const userContext = relatedNotes
      .map((n, i) => `Notes: ${i + 1} - Date: ${n.updatedAt} - Text: ${n.text}`)
      .join("\n\n");

    const response = await ai.chat.completions.create({
      model: process.env.GEMINI_AI_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a strict data retrieval assistant. Rely exclusively on the facts explicitly mentioned in the provided notes. Do not use your background knowledge, make assumptions, or draw logical conclusions. If the answer is not present in the notes, reply by saying the information is not found in the provided context. Output your final response in clean plain text without any formatting symbols.",
        },
        {
          role: "user",
          content: `Notes:\n${userContext}\n\nQuestion: ${question}`,
        },
      ],
    });

    const answerText = response.choices[0].message.content;
    res.status(200).json({ answer: answerText, source: relatedNotes });
  } catch (err) {
    console.error("askNotes Error:", err);
    return res.status(500).json({
      message: "Something went wrong while processing your request",
    });
  }
};
