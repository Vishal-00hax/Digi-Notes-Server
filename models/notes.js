import mongoose, { mongo } from "mongoose";
import { Schema } from "mongoose";

const NotesSchema = new Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, "Provide userId"],
    },
    title: {
      type: String,
      default: "New-Notes",
    },
    text: {
      type: String,
      default: "",
    },
    embedding: {
      type: [Number],
      default: [],
    },
  },
  { timestamps: true },
);

const Notes = mongoose.model("Notes", NotesSchema);

export default Notes;
