import Chats from "../models/chats.js";
import { getIO } from "../utils/socket-io.js";
import { redisClient } from "../config/redisClient.js";
import { SSE_HEADERS, writeSSEEvent, startSSEHeartbeat } from "../utils/sse.js";
import {
  searchRelatedNotes,
  buildPromptMessages,
  buildAgentGraph,
  normalizeChats,
  isActionToolUsed,
  summarizeAgentRun,
} from "../utils/askAiWorkflow.js";

const CHAT_TTL = 300;
const Chats_List_Key = (userId, page, limit) =>
  `chats:list:${userId}:${page}:${limit}`;
const Chats_Detail_Key = (chatId) => `chats:detail:${chatId}`;

const InvalidateChatsCache = async (userId, chatId) => {
  try {
    const listKeys = await redisClient.keys(`chats:list:${userId}:*`);
    const keysToDelete = [...listKeys];
    if (chatId) keysToDelete.push(Chats_Detail_Key(chatId));
    if (keysToDelete.length > 0) {
      await redisClient.del(keysToDelete);
    }
  } catch (err) {
    console.error("Redis cache invalidation chats error:", err);
  }
};

/**
 * Persists the turn, clears the cached chat pages and broadcasts the new chat.
 * Shared by the buffered and the streaming transports so both stay in sync.
 */
const saveAndBroadcastChat = async ({
  userId,
  question,
  answerText,
  relatedNotes,
  usedToolsName,
  shouldHideSource,
}) => {
  const newChat = new Chats(
    shouldHideSource
      ? {
          userId: userId,
          userQuery: question,
          aiResponse: answerText,
          actionTriggered: true,
          actionTool: usedToolsName,
        }
      : {
          userId: userId,
          userQuery: question,
          aiResponse: answerText,
          source: relatedNotes,
        },
  );

  await newChat.save();
  await InvalidateChatsCache(userId);
  getIO().to(userId.toString()).emit("chat:created", newChat);

  return newChat;
};

const buildChatPayload = ({
  savedChat,
  question,
  answerText,
  relatedNotes,
  usedToolsName,
  shouldHideSource,
}) =>
  shouldHideSource
    ? {
        _id: savedChat._id,
        question: question,
        answer: answerText,
        actionTriggered: true,
        actionTool: usedToolsName,
      }
    : {
        _id: savedChat._id,
        question: question,
        answer: answerText,
        source: relatedNotes,
      };

export const askNotes = async (req, res) => {
  try {
    const userId = req.user._id;
    const { question } = req.body;
    // Guard against a null/non-array `chats` payload so a malformed request
    // cannot crash on `chats.length`.
    const chats = normalizeChats(req.body.chats);

    if (!question) {
      return res.status(400).json({ message: "Please ask a question" });
    }

    const relatedNotes = await searchRelatedNotes(userId, question, chats);
    const Agent = buildAgentGraph(req);

    const response = await Agent.invoke(
      { messages: buildPromptMessages({ relatedNotes, chats, question }) },
      { configurable: { user: req.user } },
    );

    const { answerText, usedToolsName } = summarizeAgentRun(response);
    const shouldHideSource = isActionToolUsed(usedToolsName);

    const savedChat = await saveAndBroadcastChat({
      userId,
      question,
      answerText,
      relatedNotes,
      usedToolsName,
      shouldHideSource,
    });

    return res.status(200).json(
      buildChatPayload({
        savedChat,
        question,
        answerText,
        relatedNotes,
        usedToolsName,
        shouldHideSource,
      }),
    );
  } catch (err) {
    console.error("askNotes Error:", err);
    return res.status(500).json({
      message: "Something went wrong while processing your request",
    });
  }
};

/**
 * LangGraph yields `[mode, payload]` tuples when several stream modes are
 * enabled, but falls back to a bare payload when a single mode is used.
 * Normalising here keeps the consumer loop mode-agnostic.
 */
export const normalizeStreamEvent = (event) => {
  // Arrays first: `[mode, payload]` tuples are the primary shape, and an array
  // would otherwise trip the object branch below via its inherited `.values`.
  if (Array.isArray(event)) {
    const mode = event.length === 3 ? event[1] : event[0];
    const payload = event.length === 3 ? event[2] : event[1];
    if (mode === "messages" || mode === "values") return { mode, payload };
    return { mode: null, payload: null };
  }

  if (event && typeof event === "object") {
    if (event.messages) return { mode: "messages", payload: event.messages };
    if (event.values) return { mode: "values", payload: event.values };
  }

  return { mode: null, payload: null };
};

/**
 * A `messages` payload is `[messageChunk, metadata]`. Only the assistant node's
 * tokens are user visible — tool results must never leak into the transcript as
 * assistant prose.
 */
export const extractAgentToken = (payload) => {
  if (!Array.isArray(payload) || payload.length === 0) return "";

  const [messageChunk, metadata] = payload;
  if (!messageChunk || typeof messageChunk !== "object") return "";

  const node = metadata?.langgraph_node;
  if (node && node !== "agent") return "";

  const type = messageChunk.type;
  if (type && type !== "ai") return "";

  const { content } = messageChunk;

  if (typeof content === "string") return content;

  // Some OpenAI-compatible gateways stream array-style content parts.
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string" ? part : (part?.text ?? part?.content ?? ""),
      )
      .join("");
  }

  return "";
};

/**
 * Streaming variant of `askNotes`.
 *
 * Emits `text/event-stream` frames in this order:
 *   `sources` - retrieved notes, sent before generation so the UI can show
 *               references immediately.
 *   `token`   - incremental answer text (raw; the final `done` payload carries
 *               the sanitised text that actually gets persisted).
 *   `done`    - persisted chat id + final answer + sources/action metadata.
 *   `error`   - a failure that happened after the stream was opened.
 *
 * Validation and retrieval run BEFORE the stream is opened so a bad request or
 * a failing vector search still returns a plain JSON error status.
 */
export const askNotesStream = async (req, res) => {
  const userId = req.user._id;
  const { question } = req.body;
  const chats = normalizeChats(req.body.chats);

  if (!question) {
    return res.status(400).json({ message: "Please ask a question" });
  }

  const abortController = new AbortController();
  let clientDisconnected = false;

  // The browser aborting (tab closed, "Stop" pressed, navigation) must tear the
  // model run down instead of paying for tokens nobody will read.
  const onClientClose = () => {
    clientDisconnected = true;
    abortController.abort();
  };
  req.on("close", onClientClose);

  let stopHeartbeat = null;

  try {
    const relatedNotes = await searchRelatedNotes(userId, question, chats);

    // Client left while we were still retrieving notes.
    if (clientDisconnected) return;

    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders?.();

    stopHeartbeat = startSSEHeartbeat(res);

    writeSSEEvent(res, "sources", { source: relatedNotes });

    const Agent = buildAgentGraph(req);

    // "messages" yields the raw model tokens, "values" yields the full graph
    // state after every step (needed for the final answer + tool usage).
    const eventStream = await Agent.stream(
      { messages: buildPromptMessages({ relatedNotes, chats, question }) },
      {
        configurable: { user: req.user },
        streamMode: ["messages", "values"],
        signal: abortController.signal,
      },
    );

    let latestValues = null;

    for await (const event of eventStream) {
      const { mode, payload } = normalizeStreamEvent(event);

      if (mode === "messages") {
        const token = extractAgentToken(payload);
        if (token) writeSSEEvent(res, "token", { token });
      } else if (mode === "values" && payload) {
        latestValues = payload;
      }
    }

    if (clientDisconnected || abortController.signal.aborted) {
      // Nothing to persist: the caller explicitly stopped reading.
      return res.end();
    }

    // Without a final state snapshot there is no trustworthy answer to persist.
    if (!latestValues) {
      throw new Error("The agent run produced no final state");
    }

    const { answerText, usedToolsName } = summarizeAgentRun(latestValues);
    const shouldHideSource = isActionToolUsed(usedToolsName);

    const savedChat = await saveAndBroadcastChat({
      userId,
      question,
      answerText,
      relatedNotes,
      usedToolsName,
      shouldHideSource,
    });

    writeSSEEvent(
      res,
      "done",
      buildChatPayload({
        savedChat,
        question,
        answerText,
        relatedNotes,
        usedToolsName,
        shouldHideSource,
      }),
    );

    return res.end();
  } catch (err) {
    console.error("askNotesStream Error:", err);

    // Connection is already gone — there is nobody left to tell.
    if (clientDisconnected || res.writableEnded || res.destroyed) {
      return res.end();
    }

    if (res.headersSent) {
      writeSSEEvent(res, "error", {
        message: "Something went wrong while processing your request",
      });
      return res.end();
    }

    return res.status(500).json({
      message: "Something went wrong while processing your request",
    });
  } finally {
    stopHeartbeat?.();
    req.off("close", onClientClose);
  }
};

export const aiChats = async (req, res) => {
  try {
    const userId = req.user._id;
    // req.query values arrive as strings; normalise to positive integers so the
    // pagination math and the cache key are identical for every caller.
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 20, 1);
    const skip = (page - 1) * limit;
    const cachedKey = Chats_List_Key(userId, page, limit);

    try {
      const cached = await redisClient.get(cachedKey);
      if (cached) {
        console.log("🟢 CHATS SERVED FROM REDIS CACHE");
        return res.status(200).json(JSON.parse(cached));
      }
    } catch (cacheErr) {
      console.error("Redis read error (aiChats):", cacheErr);
    }

    const chats = await Chats.find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalChats = await Chats.countDocuments({ userId });

    const responsePayload = {
      page,
      limit,
      totalChats: totalChats,
      totalPages: Math.ceil(totalChats / limit),
      chat: chats,
    };

    try {
      await redisClient.setEx(
        cachedKey,
        CHAT_TTL,
        JSON.stringify(responsePayload),
      );
    } catch (cacheErr) {
      console.error("Redis write error (aiChats):", cacheErr);
    }
    console.log("🔵 CHATS SERVED FROM MONGODB");
    res.status(200).json(responsePayload);
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
    await InvalidateChatsCache(userId, chatId);
    res
      .status(200)
      .json({ message: "Chat deleted successfully", id: deletedChat._id });
  } catch (err) {
    console.error("CRASH IN deleteChat:", err);
    res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
};