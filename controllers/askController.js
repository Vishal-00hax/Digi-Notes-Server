import ai from "../config/open-ai.js";
import { createEmbedding } from "../utils/genrateEmbedding.js";
import Notes from "../models/notes.js";
import removeMd from "remove-markdown";

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
          _id: 1,
          score: { $meta: "vectorSearchScore" },
        },
      }, // Select specific keys from schema
      {
        $match: {
          score: { $gte: 0.76 }, // sirf genuinely relevant notes rakho
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
            "Answer the question based strictly on the factual content provided in the user notes. Rely solely on the information contained within the notes and do not include any external knowledge or assumptions about the subject matter. However, always respond in the same language the user asks the question in, translating or explaining the note content in that language as needed — the notes being in a different language than the question is not a reason to say the information is unavailable. Respond in plain text only — do not use markdown formatting like asterisks, bold markers, or bullet symbols.",
        },
        {
          role: "user",
          content: `Notes:\n${userContext}\n\nQuestion: ${question}`,
        },
      ],
    });

    const answerText = removeMd(response.choices[0].message.content)
      .replace(/\n+/g, " ")
      .trim();
    res.status(200).json({
      question: question,
      answer: answerText,
      source: relatedNotes,
    });
  } catch (err) {
    console.error("askNotes Error:", err);
    return res.status(500).json({
      message: "Something went wrong while processing your request",
    });
  }
};
