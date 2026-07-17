import Notes from "../models/notes.js";

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
    notes.title = title;
    notes.text = text;
    const updatedNote = await notes.save();
    res.status(200).json({ data: updatedNote });
  } catch (err) {
    res.status(500).json({ message: "Internal server error ", err });
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
