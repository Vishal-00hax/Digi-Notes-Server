import Notes from "../models/notes.js";
import { createEmbedding } from "../utils/genrateEmbedding.js";

export const createNotes = async (req, res) => {
  try {
    const userId = req.user._id;
    const note = new Notes({
      userId: userId,
    });
    const newNote = await note.save();
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
    const notes = await Notes.findById({ _id: notesId }).select("-__v");
    if (!notes) {
      return res.status(404).json({ message: "Note not found." });
    }

    const textToEmbed = text || "Empty note";
    const emembedding = await createEmbedding(textToEmbed);

    notes.title = title;
    notes.text = text;
    notes.embedding = emembedding;
    const updatedNote = await notes.save();
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
    if (!notesId) {
      return res.status(400).json({ message: "Invalid notesId" });
    }
    const notes = await Notes.findByIdAndDelete({ _id: notesId });
    if (notes) {
      return res
        .status(200)
        .json({ message: `Delete notes successfull ID:${notesId}` });
    }
    res.status(400).json({ message: "Invalid notesId" });
  } catch (err) {
    res.status(500).json({ message: "Internal server error ", err });
  }
};

export const getNotesById = async (req, res) => {
  try {
    const { notesId } = req.params;

    const notes = await Notes.findById({ _id: notesId }).select("-__v");
    if (!notes) {
      return res.status(404).json({ message: "Note Not Found !" });
    }

    res.status(200).json({ data: notes });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
};
