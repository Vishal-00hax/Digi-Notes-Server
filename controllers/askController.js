import { llm } from "../config/open-ai.js";
import { createEmbedding } from "../utils/genrateEmbedding.js";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import Notes from "../models/notes.js";
import removeMd from "remove-markdown";
import { getAiTools } from "../utils/ai-tools.js";
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

const ACTION_TOOLS = ["create_note", "update_note", "delete_note"];

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
      .map(
        (n, i) =>
          `Note ${i + 1} - Note ID: ${n._id} - Title: ${n.title || "Untitled"} - Date: ${n.updatedAt} - Content: ${n.text}`,
      )
      .join("\n\n");

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
    CRITICAL RULES:
    1. The user will ask to update or delete notes using their TITLE (e.g., "Delete my personal info note").
    2. NEVER ask the user for a Note ID. The user does not know their IDs.
    3. You must secretly look at the 'Notes Context' below, match the user's title to the correct Note ID, and pass that ID to your tools.
    4. After a tool successfully runs, briefly tell the user that their task is completed.`;

    const response = await Agent.invoke(
      {
        messages: [
          new SystemMessage(systemPrompt),
          new HumanMessage(
            `Notes Context:\n${userContext}\n\nUser Prompt: ${question}`,
          ),
        ],
      },
      { configurable: { user: req.user } },
    );

    const usedToolsName = response.messages
      .filter((msg) => msg.tool_calls?.length > 0)
      .flatMap((msg) => msg.tool_calls.map((tc) => tc.name));

    const shouldHideSource = calledToolNames.some((name) =>
      ACTION_TOOLS.includes(name),
    );

    const lastMessage = response.messages[response.messages.length - 1];

    const answerText = removeMd(lastMessage.content || "")
      .replace(/\n+/g, " ")
      .trim();

    if (shouldHideSource) {
      return res.status(200).json({
        question: question,
        answer: answerText,
        actionTriggered: true,
      });
    }

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
