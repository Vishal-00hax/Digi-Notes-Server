import { llm } from "../config/open-ai.js";
import { createEmbedding } from "../utils/genrateEmbedding.js";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import Notes from "../models/notes.js";
import removeMd from "remove-markdown";
import { getAiTools } from "../utils/ai-tools.js";
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import Chats from "../models/chats.js";
import { getIO } from "../utils/socket-io.js";

const ACTION_TOOLS = ["create_note", "update_note", "delete_note"];

export const askNotes = async (req, res) => {
  try {
    const userId = req.user._id;
    const { question, chats = [] } = req.body;

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

    const userContext =
      relatedNotes.length > 0
        ? relatedNotes
            .map(
              (n, i) =>
                `Note ${i + 1} - Note ID: ${n._id} - Title: ${n.title || "Untitled"} - Date: ${n.updatedAt} - Content: ${n.text}`,
            )
            .join("\n\n")
        : "No matching notes found in the database.";

    const chatHistory = chats
      .map(
        (c, i) =>
          `Chat ${i + 1} - User Query: ${c.userQuery} - AI Response: ${c.aiResponse}`,
      )
      .join("\n\n");

    console.log("Chats", chatHistory);

    const tools = getAiTools(req);
    const toolNode = new ToolNode(tools);
    const LLM = llm.bindTools(tools);

    // This function is check tool is required or not.
    const shouldContinue = (state) => {
      const lastMessage = state.messages[state.messages.length - 1];
      if (lastMessage.tool_calls?.length) {
        return "tools";
      }
      return "__end__";
    };

    // This is AI model call node.
    const callModel = async (state) => {
      const response = await LLM.invoke(state.messages);
      return { messages: [response] };
    };

    // Graph for AI model in LangGraph.
    const workflow = new StateGraph(MessagesAnnotation)
      .addNode("agent", callModel)
      .addNode("tools", toolNode)
      .addEdge("__start__", "agent")
      .addConditionalEdges("agent", shouldContinue)
      .addEdge("tools", "agent");

    const Agent = workflow.compile();

    const systemPrompt = `You are an intelligent assistant managing user notes.

    CRITICAL WORKFLOW FOR MODIFYING NOTES (Create/Update/Delete):
    
    STEP 1: CONFIRMATION (DO THIS FIRST)
    If the user asks to delete, update, or create a note, DO NOT call any tool immediately. 
    First, find the relevant note from the 'Notes Context'. Then, ask the user for confirmation in a very natural way, mentioning the exact note title. 
    Example: "I found your note titled '[Note Title]'. Should I go ahead and delete it? (Yes/No)"
    STOP HERE. DO NOT CALL ANY TOOL.
    
    STEP 2: EXECUTION (DO THIS ONLY AFTER CONFIRMATION)
    Read the 'Chat History'. If your last response was asking for confirmation, and the user's current prompt is "Yes", "do it", "sure", or a similar positive confirmation, ONLY THEN call the appropriate tool (create_note, update_note, or delete_note).

    GENERAL RULES:
    - Never ask the user for a Note ID. You match the ID secretly using the Notes Context.
    - After the tool successfully runs, tell the user that the task is completed and summarize what was done.`;

    const response = await Agent.invoke(
      {
        messages: [
          new SystemMessage(systemPrompt),
          new HumanMessage(
            `Notes Context:\n${userContext}\n\nUser Prompt: ${question}\n\n Chat History:\n${chatHistory}`,
          ),
        ],
      },
      { configurable: { user: req.user } },
    );

    const usedToolsName = Array.from(
      new Set(
        response.messages
          .filter((msg) => msg.tool_calls?.length > 0)
          .flatMap((msg) => msg.tool_calls.map((tc) => tc.name)),
      ),
    );

    const shouldHideSource = usedToolsName.some((name) =>
      ACTION_TOOLS.includes(name),
    );

    const lastMessage = response.messages[response.messages.length - 1];

    const answerText = removeMd(lastMessage.content || "")
      .replace(/\n+/g, " ")
      .trim();

    if (shouldHideSource) {
      const newChat = new Chats({
        userId: userId,
        userQuery: question,
        aiResponse: answerText,
        actionTriggered: true,
        actionTool: usedToolsName,
      });

      await newChat.save();
      getIO().to(userId.toString()).emit("chat:created", newChat);

      return res.status(200).json({
        _id: newChat._id,
        question: question,
        answer: answerText,
        actionTriggered: true,
        actionTool: usedToolsName,
      });
    }

    const newChat = new Chats({
      userId: userId,
      userQuery: question,
      aiResponse: answerText,
      source: relatedNotes,
    });

    await newChat.save();
    getIO().to(userId.toString()).emit("chat:created", newChat);

    res.status(200).json({
      _id: newChat._id,
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

export const aiChats = async (req, res) => {
  try {
    const userId = req.user._id;
    const page = req.query.page || 1;
    const limit = req.query.limit || 20;
    const skip = (page - 1) * limit;

    const chats = await Chats.find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalChats = await Chats.countDocuments({ userId });

    if (!chats) {
      return res.status(404).json({ message: "No chats found" });
    }

    res.status(200).json({
      page,
      limit,
      totalChats: totalChats,
      totalPages: Math.ceil(totalChats / limit),
      chat: chats,
    });
  } catch (err) {
    console.error("CRASH IN aiChats:", err);
    res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
};

export const deleteChat = async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user._id;

    if (!chatId) {
      return res.status(400).json({ message: "Chat ID is required" });
    }
    const deletedChat = await Chats.findOneAndDelete({
      _id: chatId,
      userId: userId,
    });
    if (!deletedChat) {
      return res.status(404).json({ message: "Chat not found" });
    }
    getIO()
      .to(userId.toString())
      .emit("chat:deleted", deletedChat._id.toString());
    res
      .status(200)
      .json({ message: "Chat deleted successfully", id: deletedChat._id });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
};
