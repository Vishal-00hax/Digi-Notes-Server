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
            "You are a helpful assistant answering questions based on the provided notes. Rely primarily on the facts in the notes. If the user asks for a definition of a general concept or tool (like MongoDB or Node.js) that is mentioned in the notes but not formally defined, you may provide a brief 1-sentence general definition, but must tie the rest of your answer strictly to how it is used in the user's notes. Write in clean plain text.",
        },
        {
          role: "user",
          content: `Notes:\n${userContext}\n\nQuestion: ${question}`,
        },
      ],
    });

    const answerText = response.choices[0].message.content;
    res
      .status(200)
      .json({ question: question, answer: answerText, source: relatedNotes });
  } catch (err) {
    console.error("askNotes Error:", err);
    return res.status(500).json({
      message: "Something went wrong while processing your request",
    });
  }
};
