import Notes from "../models/notes.js";
import { createEmbedding } from "../utils/genrateEmbedding.js";
import { getIO } from "../utils/socket-io.js";

export const createNotes = async (req, res) => {
  try {
    const userId = req.user._id;
    const note = new Notes({
      userId: userId,
    });
    const newNote = await note.save();
    getIO().to(userId.toString()).emit("note:created", newNote);
    res.status(201).json({ data: newNote._id });
  } catch (err) {
    res.status(500).json({ message: "Internal server error ", err });
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

    const textToEmbed = text || "Empty note";
    const emembedding = await createEmbedding(textToEmbed);

    if (title !== undefined) notes.title = title;
    if (text !== undefined) notes.text = text;
    notes.embedding = emembedding;
    const updatedNote = await notes.save();
    getIO().to(userId.toString()).emit("note:updated", updatedNote);
    res
      .status(200)
      .json({ message: "Notes updated successfull", data: updatedNote._id });
  } catch (err) {
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
    getIO().to(userId.toString()).emit("note:deleted", notesId);
    res.status(200).json({ message: `Delete notes successfull ID:${notesId}` });
  } catch (err) {
    res.status(500).json({ message: "Internal server error ", err });
  }
};

export const getNotesById = async (req, res) => {
  try {
    const { notesId } = req.params;
    const userId = req.user._id;
    const notes = await Notes.findOne({ _id: notesId, userId }).select(
      "-__v -embedding",
    );
    if (!notes) {
      return res.status(404).json({ message: "Note Not Found !" });
    }

    res.status(200).json({ note: notes });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
};

export const getUserNotes = async (req, res) => {
  try {
    const userId = req.user._id;
    const notes = await Notes.find({ userId: userId }).select(
      "-__v -embedding -text",
    );
    if (!notes) {
      return res.status(404).json({ message: "Notes not found." });
    }
    res.status(200).json({ notes: notes });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
};
