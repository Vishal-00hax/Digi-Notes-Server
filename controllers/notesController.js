import Notes from "../models/notes.js";
import { createEmbedding } from "../utils/genrateEmbedding.js";
import { getIO } from "../utils/socket-io.js";
import { redisClient } from "../config/redisClient.js";

const NOTES_LIST_TTL = 300;

const notesListKey = (userId) => `notes:list:${userId}`;
const notesDetailKey = (notesId) => `notes:detail:${notesId}`;

// Helper to safely invalidate related cache keys
const invalidateNotesCache = async (userId, notesId) => {
  try {
    const keysToDelete = [notesListKey(userId)];
    if (notesId) keysToDelete.push(notesDetailKey(notesId));
    await redisClient.del(keysToDelete);
  } catch (err) {
    console.error("Redis cache invalidation error:", err);
  }
};

export const createNotes = async (req, res) => {
  try {
    const userId = req.user._id;
    const { title, text } = req.body;

    const finalTitle = title !== undefined ? title : "New-Note";
    const finalText = text !== undefined ? text : "Empty note";

    const textToEmbed = `Title: ${finalTitle || "Untitled"}\nContent: ${finalText || "Empty note"}`;
    const emembedding = await createEmbedding(textToEmbed);

    const note = new Notes({
      userId: userId,
      title: finalTitle,
      text: finalText,
      embedding: emembedding,
    });
    const newNote = await note.save();
    await invalidateNotesCache(userId); // list is now stale
    getIO().to(userId.toString()).emit("note:created", newNote);
    res.status(201).json({ data: newNote._id });
  } catch (err) {
    console.error("CRASH IN createNotes:", err);
    res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
};

export const updateNotes = async (req, res) => {
  try {
    const userId = req.user._id;
    const { notesId, title, text } = req.body;
    if (!notesId) {
      return res.status(400).json({ message: "Invalid notesId" });
    }
    const notes = await Notes.findOne({ _id: notesId, userId }).select("-__v");
    if (!notes) {
      return res.status(404).json({ message: "Note not found." });
    }

    const finalTitle = title !== undefined ? title : notes.title;
    const finalText = text !== undefined ? text : notes.text;

    const textToEmbed = `Title: ${finalTitle || "Untitled"}\nContent: ${finalText || "Empty note"}`;
    const emembedding = await createEmbedding(textToEmbed);

    if (title !== undefined) notes.title = title;
    if (text !== undefined) notes.text = text;
    notes.embedding = emembedding;
    const updatedNote = await notes.save();
    await invalidateNotesCache(userId, notesId); // both list and detail are stale
    getIO().to(userId.toString()).emit("note:updated", updatedNote);
    res
      .status(200)
      .json({ message: "Notes updated successfull", data: updatedNote._id });
  } catch (err) {
    console.error("CRASH IN updateNotes:", err);
    res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
};

export const deleteNotes = async (req, res) => {
  try {
    const { notesId } = req.params;
    const userId = req.user._id;
    if (!notesId) {
      return res.status(400).json({ message: "Invalid notesId" });
    }
    const notes = await Notes.findOneAndDelete({ _id: notesId, userId });
    if (!notes) {
      return res.status(400).json({ message: "Invalid notesId" });
    }
    await invalidateNotesCache(userId, notesId);
    getIO().to(userId.toString()).emit("note:deleted", notesId);
    res.status(200).json({ message: `Delete notes successfull ID:${notesId}` });
  } catch (err) {
    console.error("CRASH IN deleteNotes:", err);
    res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
};

export const getNotesById = async (req, res) => {
  try {
    const { notesId } = req.params;
    const userId = req.user._id;
    const cacheKey = notesDetailKey(notesId);
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        console.log("🟢 NOTES SERVED FROM REDIS CACHE");
        return res.status(200).json({ note: JSON.parse(cached) });
      }
    } catch (cacheErr) {
      console.error("Redis read error (getNotesById):", cacheErr);
      // fall through to DB on cache failure
    }

    const notes = await Notes.findOne({ _id: notesId, userId }).select(
      "-__v -embedding",
    );
    if (!notes) {
      return res.status(404).json({ message: "Note Not Found !" });
    }

    try {
      await redisClient.setEx(cacheKey, NOTES_LIST_TTL, JSON.stringify(notes));
    } catch (cacheErr) {
      console.error("Redis write error (getNotesById):", cacheErr);
    }

    console.log("🔵 NOTES SERVED FROM MONGODB");
    res.status(200).json({ note: notes });
  } catch (err) {
    console.error("CRASH IN getNotesById:", err);
    res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
};

export const getUserNotes = async (req, res) => {
  try {
    const userId = req.user._id;
    const cacheKey = notesListKey(userId);

    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        console.log("🟢 NOTES SERVED FROM REDIS CACHE");
        return res.status(200).json({ notes: JSON.parse(cached) });
      }
    } catch (cacheErr) {
      console.error("Redis read error (getUserNotes):", cacheErr);
    }

    const notes = await Notes.find({ userId: userId }).select(
      "-__v -embedding",
    );
    if (!notes) {
      return res.status(404).json({ message: "Notes not found." });
    }

    try {
      await redisClient.setEx(cacheKey, NOTES_LIST_TTL, JSON.stringify(notes));
    } catch (cacheErr) {
      console.error("Redis write error (getUserNotes):", cacheErr);
    }

    console.log("🔵 NOTES SERVED FROM MONGODB");
    res.status(200).json({ notes: notes });
  } catch (err) {
    console.error("CRASH IN getUserNotes:", err);
    res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
};
