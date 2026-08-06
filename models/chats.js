import mongoose from "mongoose";
import { Schema } from "mongoose";

const ChatsSchema = new Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, "Provide userId"],
    },
    userQuery: {
      type: String,
      default: "",
    },
    aiResponse: {
      type: String,
      default: "",
    },
    source: {
      type: [],
      default: [],
    },
    actionTriggered: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

const Chats = mongoose.model("Chats", ChatsSchema);

export default Chats;
