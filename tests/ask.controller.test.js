import { jest } from "@jest/globals";
import { EventEmitter } from "node:events";

// ==========================================
// 1. CREATE MOCKS BEFORE IMPORTING CONTROLLER
// ==========================================

// Mock Mongoose 'Notes' Model
const Notes = {
  aggregate: jest.fn(),
};

// Mock Mongoose 'Chats' Model
const mockChatSave = jest.fn();
const Chats = jest.fn().mockImplementation((data) => ({
  ...data,
  _id: "new_chat_123",
  save: mockChatSave,
}));

// Chaining for Chats.find().sort().skip().limit()
const mockLimit = jest.fn();
const mockSkip = jest.fn().mockReturnValue({ limit: mockLimit });
const mockSort = jest.fn().mockReturnValue({ skip: mockSkip });
Chats.find = jest.fn().mockReturnValue({ sort: mockSort });
Chats.countDocuments = jest.fn();
Chats.findOneAndDelete = jest.fn();

// Mock Redis
const redisClient = {
  keys: jest.fn(),
  del: jest.fn(),
  get: jest.fn(),
  setEx: jest.fn(),
};

// Mock Socket.io
const mockEmit = jest.fn();
const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
const getIO = jest.fn().mockReturnValue({ to: mockTo });

// Mock AI Tools & Utils
const createEmbedding = jest.fn();
const getAiTools = jest.fn().mockReturnValue([]);
const llm = { bindTools: jest.fn().mockReturnValue({}) };

// Mock LangChain / LangGraph Components
const mockAgentInvoke = jest.fn();
const mockAgentStream = jest.fn();
const mockCompile = jest.fn().mockReturnValue({
  invoke: mockAgentInvoke,
  stream: mockAgentStream,
});
const mockStateGraphInstance = {
  addNode: jest.fn().mockReturnThis(),
  addEdge: jest.fn().mockReturnThis(),
  addConditionalEdges: jest.fn().mockReturnThis(),
  compile: mockCompile,
};

const StateGraph = jest.fn().mockImplementation(() => mockStateGraphInstance);
const MessagesAnnotation = {};
const ToolNode = jest.fn();

// Basic message classes for LangChain
class SystemMessage {
  constructor(content) {
    this.content = content;
    this.type = "system";
  }
}
class HumanMessage {
  constructor(content) {
    this.content = content;
    this.type = "human";
  }
}
class AIMessage {
  constructor(content) {
    this.content = content;
    this.type = "ai";
  }
}

const removeMd = jest.fn((str) => str); // Just pass text through for tests

// ==========================================
// 2. REGISTER MOCKS INTO JEST CACHE
// ==========================================
jest.unstable_mockModule("../models/notes.js", () => ({ default: Notes }));
jest.unstable_mockModule("../models/chats.js", () => ({ default: Chats }));
jest.unstable_mockModule("../config/redisClient.js", () => ({ redisClient }));
jest.unstable_mockModule("../utils/socket-io.js", () => ({ getIO }));
jest.unstable_mockModule("../utils/genrateEmbedding.js", () => ({
  createEmbedding,
}));
jest.unstable_mockModule("../utils/ai-tools.js", () => ({ getAiTools }));
jest.unstable_mockModule("../config/open-ai.js", () => ({ llm }));
jest.unstable_mockModule("remove-markdown", () => ({ default: removeMd }));

jest.unstable_mockModule("@langchain/langgraph/prebuilt", () => ({ ToolNode }));
jest.unstable_mockModule("@langchain/langgraph", () => ({
  StateGraph,
  MessagesAnnotation,
}));
jest.unstable_mockModule("@langchain/core/messages", () => ({
  SystemMessage,
  HumanMessage,
  AIMessage,
}));

// ==========================================
// 3. DYNAMICALLY IMPORT THE CONTROLLER
// ==========================================
// IMPORTANT: Ensure this path matches your exact controller filename
const { askNotes, askNotesStream, aiChats, deleteChat, normalizeStreamEvent, extractAgentToken } =
  await import("../controllers/askController.js");

// ==========================================
// 4. STREAMING TEST HELPERS
// ==========================================

// A `streamMode: ["messages", "values"]` run yields `[mode, payload]` tuples,
// where a "messages" payload is `[messageChunk, metadata]`.
const tokenEvent = (content, { node = "agent", type = "ai" } = {}) => [
  "messages",
  [{ content, type }, { langgraph_node: node }],
];

const valuesEvent = (messages) => ["values", { messages }];

const toolCallMessage = (content, toolName) => ({
  content,
  tool_calls: [{ name: toolName }],
});

/** Builds an async-iterable stand-in for LangGraph's `stream()`. */
const makeAgentStream = (events, onBeforeYield) => ({
  async *[Symbol.asyncIterator]() {
    for (const event of events) {
      if (onBeforeYield) await onBeforeYield(event);
      yield event;
    }
  },
});

/** Parses the raw SSE bytes a response received back into `{event, data}` pairs. */
const parseFrames = (res) =>
  res.frames
    .join("")
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const lines = frame.split("\n");
      return {
        event: lines[0].replace(/^event:\s*/, ""),
        data: JSON.parse(lines[1].replace(/^data:\s*/, "")),
        raw: frame,
      };
    });

const framesOfType = (res, type) =>
  parseFrames(res).filter((frame) => frame.event === type);

/** The concatenated answer the client would have rendered while streaming. */
const streamedText = (res) =>
  framesOfType(res, "token")
    .map((frame) => frame.data.token)
    .join("");

const abortError = () => {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
};

describe("AI Chats Controller", () => {
  let req, res;

  const mockResponse = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  /**
   * A response that also behaves like a real `http.ServerResponse`, so the
   * streaming controller can writeHead/write/end against it and the assertions
   * can read back the exact SSE bytes the browser would have received.
   */
  const mockStreamResponse = () => {
    const frames = [];
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.writeHead = jest.fn(() => {
      // A real ServerResponse flips this once headers go out, and the
      // controller branches on it to decide between SSE and JSON error output.
      res.headersSent = true;
      return res;
    });
    res.flushHeaders = jest.fn();
    res.write = jest.fn((chunk) => {
      frames.push(chunk);
      return true;
    });
    res.end = jest.fn(() => {
      res.writableEnded = true;
      return res;
    });
    res.writableEnded = false;
    res.destroyed = false;
    res.headersSent = false;
    res.frames = frames;
    return res;
  };

  const mockStreamRequest = (body, user = { _id: "user123" }) => {
    const req = new EventEmitter();
    req.user = user;
    req.body = body;
    return req;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    res = mockResponse();

    // Hide standard console logs/errors during tests to keep terminal clean
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});

    // Default Redis Mock setup for invalidation
    redisClient.keys.mockResolvedValue(["chats:list:user123:1:20"]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // The vector-search pipeline is asserted verbatim elsewhere: the
  // `filter: { userId }` clause is what stops one user's notes leaking into
  // another user's AI context, so it must never be left unverified.
  const EXPECTED_VECTOR_SEARCH_PIPELINE = (queryVector) => [
    {
      $vectorSearch: {
        index: "note_vector_index",
        path: "embedding",
        queryVector,
        numCandidates: 100,
        limit: 5,
        filter: { userId: "user123" },
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
    },
    { $match: { score: { $gte: 0.79 } } },
  ];

  const RELATED_NOTES = [
    {
      _id: "note1",
      title: "Docker",
      text: "Containers",
      updatedAt: "2024-01-01",
    },
  ];

  describe("askNotes (AI Agent Workflow)", () => {
    beforeEach(() => {
      req = {
        user: { _id: "user123" },
        body: { question: "What is Docker?" },
      };
      createEmbedding.mockResolvedValue([0.1, 0.2]);
      Notes.aggregate.mockResolvedValue(RELATED_NOTES);
      mockChatSave.mockResolvedValue(true);
    });

    it("should return 400 if question is missing", async () => {
      req.body.question = undefined;
      await askNotes(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        message: "Please ask a question",
      });
    });

    it("should process standard query without tools, save chat, and return answer with source", async () => {
      // Mock Agent returning a standard text message
      mockAgentInvoke.mockResolvedValue({
        messages: [{ content: "Docker is a containerization platform." }],
      });

      await askNotes(req, res);

      // Verify embedding and vector search ran - scoped to this user only.
      expect(createEmbedding).toHaveBeenCalledWith("What is Docker?");
      expect(Notes.aggregate).toHaveBeenCalledWith(
        EXPECTED_VECTOR_SEARCH_PIPELINE([0.1, 0.2]),
      );

      // Verify the agent was wired up with the user's toolset.
      expect(getAiTools).toHaveBeenCalledWith(req);
      expect(llm.bindTools).toHaveBeenCalledWith(getAiTools.mock.results[0].value);
      expect(StateGraph).toHaveBeenCalledWith(MessagesAnnotation);
      expect(mockCompile).toHaveBeenCalled();
      expect(mockAgentInvoke).toHaveBeenCalledWith(
        expect.any(Object),
        { configurable: { user: req.user } },
      );

      // The retrieved notes must reach the model as context, in the final
      // user turn alongside the question.
      const [invokeArgs] = mockAgentInvoke.mock.calls[0];
      const lastMessage = invokeArgs.messages[invokeArgs.messages.length - 1];
      expect(lastMessage.content).toContain(
        "Note 1 - Note ID: note1 - Title: Docker",
      );
      expect(lastMessage.content).toContain("Current Prompt: What is Docker?");

      // Verify Cache clearing & DB saving
      expect(redisClient.keys).toHaveBeenCalledWith("chats:list:user123:*");
      expect(redisClient.del).toHaveBeenCalledWith([
        "chats:list:user123:1:20",
      ]);
      expect(Chats).toHaveBeenCalledWith({
        userId: "user123",
        userQuery: "What is Docker?",
        aiResponse: "Docker is a containerization platform.",
        source: RELATED_NOTES,
      });
      expect(mockChatSave).toHaveBeenCalled();

      // Verify Socket emitted
      expect(getIO).toHaveBeenCalled();
      expect(mockTo).toHaveBeenCalledWith("user123");
      expect(mockEmit).toHaveBeenCalledWith("chat:created", expect.any(Object));

      // Verify API Response
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        _id: "new_chat_123",
        question: "What is Docker?",
        answer: "Docker is a containerization platform.",
        source: RELATED_NOTES,
      });
    });

    it("should collapse newlines and trim the answer text", async () => {
      mockAgentInvoke.mockResolvedValue({
        messages: [{ content: "  First line\n\nSecond line\n" }],
      });

      await askNotes(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ answer: "First line Second line" }),
      );
    });

    it("should search using the previous query when chat history exists", async () => {
      req.body = {
        question: "yes do it",
        chats: [
          { userQuery: "delete my docker note", aiResponse: "Which one?" },
        ],
      };
      mockAgentInvoke.mockResolvedValue({
        messages: [{ content: "Done." }],
      });

      await askNotes(req, res);

      // The embedding must combine the previous query with the confirmation.
      expect(createEmbedding).toHaveBeenCalledWith("delete my docker note yes do it");

      // History must be replayed as human/ai message pairs.
      const [invokeArgs] = mockAgentInvoke.mock.calls[0];
      expect(invokeArgs.messages.map((m) => m.type)).toEqual([
        "system",
        "human",
        "ai",
        "human",
      ]);
      expect(invokeArgs.messages[1].content).toBe("delete my docker note");
      expect(invokeArgs.messages[2].content).toBe("Which one?");
    });

    it("should tell the model when no notes match", async () => {
      Notes.aggregate.mockResolvedValue([]);
      mockAgentInvoke.mockResolvedValue({
        messages: [{ content: "I could not find it." }],
      });

      await askNotes(req, res);

      const [invokeArgs] = mockAgentInvoke.mock.calls[0];
      const lastMessage = invokeArgs.messages[invokeArgs.messages.length - 1];
      expect(lastMessage.content).toContain(
        "No matching notes found in the database.",
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ source: [] }),
      );
    });

    it("should tolerate a malformed chats payload", async () => {
      req.body = { question: "Hello?", chats: null };
      mockAgentInvoke.mockResolvedValue({
        messages: [{ content: "Hi." }],
      });

      await askNotes(req, res);

      expect(createEmbedding).toHaveBeenCalledWith("Hello?");
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it("should hide sources and flag actionTriggered if the AI used an ACTION TOOL", async () => {
      // Mock Agent returning a message that triggered a tool (like 'create_note')
      mockAgentInvoke.mockResolvedValue({
        messages: [
          {
            content: "I created the note.",
            tool_calls: [{ name: "create_note" }],
          },
        ],
      });

      await askNotes(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        _id: "new_chat_123",
        question: "What is Docker?",
        answer: "I created the note.",
        actionTriggered: true,
        actionTool: ["create_note"],
      });

      // `source` must be omitted entirely for action tools, not merely absent
      // from an objectContaining assertion.
      const payload = res.json.mock.calls[0][0];
      expect(payload).not.toHaveProperty("source");

      expect(Chats).toHaveBeenCalledWith({
        userId: "user123",
        userQuery: "What is Docker?",
        aiResponse: "I created the note.",
        actionTriggered: true,
        actionTool: ["create_note"],
      });
    });

    it("should dedupe repeated tools across messages", async () => {
      mockAgentInvoke.mockResolvedValue({
        messages: [
          { content: "working", tool_calls: [{ name: "update_note" }] },
          { content: "working", tool_calls: [{ name: "update_note" }] },
          { content: "Done, updated." },
        ],
      });

      await askNotes(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          actionTriggered: true,
          actionTool: ["update_note"],
        }),
      );
    });

    it("should keep sources for non-action tools", async () => {
      mockAgentInvoke.mockResolvedValue({
        messages: [
          { content: "searching", tool_calls: [{ name: "ask_notes" }] },
          { content: "Here is what your notes say." },
        ],
      });

      await askNotes(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          source: expect.any(Array),
        }),
      );
      expect(res.json.mock.calls[0][0]).not.toHaveProperty("actionTriggered");
    });

    it("should handle internal server errors gracefully", async () => {
      createEmbedding.mockRejectedValue(new Error("API limits exceeded"));
      await askNotes(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        message: "Something went wrong while processing your request",
      });
    });

    it("should return 500 when persisting the chat fails", async () => {
      mockAgentInvoke.mockResolvedValue({
        messages: [{ content: "Answer." }],
      });
      mockChatSave.mockRejectedValue(new Error("Write failed"));

      await askNotes(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        message: "Something went wrong while processing your request",
      });
    });
  });

  describe("normalizeStreamEvent", () => {
    it("unwraps the [mode, payload] tuples langgraph emits for multi-mode streams", () => {
      expect(normalizeStreamEvent(["messages", ["chunk", {}]])).toEqual({
        mode: "messages",
        payload: ["chunk", {}],
      });
      expect(normalizeStreamEvent(["values", { messages: [] }])).toEqual({
        mode: "values",
        payload: { messages: [] },
      });
    });

    it("supports the 3-tuple namespace shape used for subgraph streams", () => {
      const payload = { messages: [] };
      expect(normalizeStreamEvent([[], "values", payload])).toEqual({
        mode: "values",
        payload,
      });
    });

    it("supports already-keyed chunk objects", () => {
      expect(normalizeStreamEvent({ values: { messages: [1] } })).toEqual({
        mode: "values",
        payload: { messages: [1] },
      });
      expect(normalizeStreamEvent({ messages: ["c", {}] })).toEqual({
        mode: "messages",
        payload: ["c", {}],
      });
    });

    it("ignores anything that is not a stream we know about", () => {
      expect(normalizeStreamEvent(undefined)).toEqual({
        mode: null,
        payload: null,
      });
      expect(normalizeStreamEvent(["updates", { a: 1 }])).toEqual({
        mode: null,
        payload: null,
      });
    });
  });

  describe("extractAgentToken", () => {
    it("returns the plain string content of an agent chunk", () => {
      expect(extractAgentToken([{ type: "ai", content: "Hello" }, { langgraph_node: "agent" }])).toBe("Hello");
    });

    it("drops chunks emitted by the tools node", () => {
      expect(
        extractAgentToken([{ type: "tool", content: "result" }, { langgraph_node: "tools" }]),
      ).toBe("");
    });

    it("drops tool messages even when the node is unlabelled", () => {
      expect(extractAgentToken([{ type: "tool", content: "result" }, {}])).toBe("");
    });

    it("keeps tokens when langgraph metadata is missing entirely", () => {
      expect(extractAgentToken([{ type: "ai", content: "Hi" }])).toBe("Hi");
    });

    it("joins array-style content parts from OpenAI-compatible gateways", () => {
      expect(
        extractAgentToken([
          { type: "ai", content: [{ text: "a" }, { text: "b" }, "c"] },
          { langgraph_node: "agent" },
        ]),
      ).toBe("abc");
    });

    it("returns an empty string for empty or malformed payloads", () => {
      expect(extractAgentToken(undefined)).toBe("");
      expect(extractAgentToken([])).toBe("");
      expect(extractAgentToken(["not-an-object", {}])).toBe("");
      expect(extractAgentToken([{ type: "ai", content: "" }, {}])).toBe("");
    });
  });

  describe("askNotesStream (SSE token streaming)", () => {
    let req, res;

    beforeEach(() => {
      req = mockStreamRequest({ question: "What is Docker?" });
      res = mockStreamResponse();
      createEmbedding.mockResolvedValue([0.1, 0.2]);
      Notes.aggregate.mockResolvedValue(RELATED_NOTES);
      mockChatSave.mockResolvedValue(true);
    });

    it("should reject a missing question with JSON before opening the stream", async () => {
      req.body = {};

      await askNotesStream(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        message: "Please ask a question",
      });
      // Nothing may be written to the socket before the stream is opened.
      expect(res.writeHead).not.toHaveBeenCalled();
      expect(res.write).not.toHaveBeenCalled();
    });

    it("should open the response as an unbuffered SSE stream", async () => {
      mockAgentStream.mockResolvedValue(
        makeAgentStream([valuesEvent([{ content: "Answer." }])]),
      );

      await askNotesStream(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          // Proxies must not buffer or the whole point of streaming is lost.
          "X-Accel-Buffering": "no",
        }),
      );
      expect(res.flushHeaders).toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();
    });

    it("should stream tokens then finish with the persisted chat", async () => {
      mockAgentStream.mockResolvedValue(
        makeAgentStream([
          tokenEvent("Docker "),
          tokenEvent("is a "),
          tokenEvent("container platform."),
          valuesEvent([{ content: "Docker is a container platform." }]),
        ]),
      );

      await askNotesStream(req, res);

      // The exact bytes the client renders must equal the streamed tokens.
      expect(streamedText(res)).toBe("Docker is a container platform.");

      const frames = parseFrames(res);
      expect(frames.map((f) => f.event)).toEqual(["sources", "token", "token", "token", "done"]);

      // Sources are pushed before generation starts so references show instantly.
      expect(frames[0].data).toEqual({ source: RELATED_NOTES });

      expect(frames.at(-1).data).toEqual({
        _id: "new_chat_123",
        question: "What is Docker?",
        answer: "Docker is a container platform.",
        source: RELATED_NOTES,
      });

      // Parity with the buffered endpoint: same persistence, cache and socket.
      expect(Chats).toHaveBeenCalledWith({
        userId: "user123",
        userQuery: "What is Docker?",
        aiResponse: "Docker is a container platform.",
        source: RELATED_NOTES,
      });
      expect(redisClient.keys).toHaveBeenCalledWith("chats:list:user123:*");
      expect(mockEmit).toHaveBeenCalledWith("chat:created", expect.any(Object));
      expect(res.end).toHaveBeenCalled();
    });

    it("should ask the graph for both message tokens and state snapshots", async () => {
      mockAgentStream.mockResolvedValue(
        makeAgentStream([valuesEvent([{ content: "Answer." }])]),
      );

      await askNotesStream(req, res);

      expect(mockAgentStream).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.any(Array),
        }),
        expect.objectContaining({
          configurable: { user: req.user },
          streamMode: ["messages", "values"],
          signal: expect.any(AbortSignal),
        }),
      );

      // The retrieved notes must still reach the model as context.
      const [invokeArgs] = mockAgentStream.mock.calls[0];
      const lastMessage = invokeArgs.messages[invokeArgs.messages.length - 1];
      expect(lastMessage.content).toContain(
        "Note 1 - Note ID: note1 - Title: Docker",
      );
      expect(lastMessage.content).toContain("Current Prompt: What is Docker?");
    });

    it("should never forward tool-node output to the client", async () => {
      mockAgentStream.mockResolvedValue(
        makeAgentStream([
          tokenEvent("Searching... "),
          tokenEvent("done", { node: "tools" }),
          tokenEvent("tool noise", { node: "tools", type: "tool" }),
          valuesEvent([
            toolCallMessage("working", "web_search"),
            { content: "Here is the answer." },
          ]),
        ]),
      );

      await askNotesStream(req, res);

      expect(streamedText(res)).toBe("Searching... ");
      expect(framesOfType(res, "done")[0].data.answer).toBe(
        "Here is the answer.",
      );
    });

    it("should send the sanitised answer in done, not the raw streamed text", async () => {
      mockAgentStream.mockResolvedValue(
        makeAgentStream([
          tokenEvent("**Docker**\nis a platform"),
          valuesEvent([{ content: "  **Docker**\n\nis a platform\n" }]),
        ]),
      );

      await askNotesStream(req, res);

      expect(streamedText(res)).toBe("**Docker**\nis a platform");
      expect(framesOfType(res, "done")[0].data.answer).toBe(
        "**Docker** is a platform",
      );
      // Whatever is persisted must match what `done` reports back.
      expect(Chats).toHaveBeenCalledWith(
        expect.objectContaining({
          aiResponse: "**Docker** is a platform",
        }),
      );
    });

    it("should flag action tools and omit sources from the done payload", async () => {
      mockAgentStream.mockResolvedValue(
        makeAgentStream([
          tokenEvent("I created the note."),
          valuesEvent([
            toolCallMessage("", "create_note"),
            { content: "I created the note." },
          ]),
        ]),
      );

      await askNotesStream(req, res);

      const done = framesOfType(res, "done")[0].data;
      expect(done).toEqual({
        _id: "new_chat_123",
        question: "What is Docker?",
        answer: "I created the note.",
        actionTriggered: true,
        actionTool: ["create_note"],
      });
      // `source` must be omitted entirely for action tools.
      expect(done).not.toHaveProperty("source");

      expect(Chats).toHaveBeenCalledWith({
        userId: "user123",
        userQuery: "What is Docker?",
        aiResponse: "I created the note.",
        actionTriggered: true,
        actionTool: ["create_note"],
      });
    });

    it("should not persist or report a chat when the client disconnects mid-stream", async () => {
      let runSignal = null;
      let abortedDuringRun = false;

      mockAgentStream.mockImplementation(async (input, config) => {
        runSignal = config.signal;
        return makeAgentStream(
          [
            tokenEvent("Docker "),
            tokenEvent("is a platform."),
            valuesEvent([{ content: "Docker is a platform." }]),
          ],
          ([mode]) => {
            if (mode !== "messages") return;
            req.emit("close");
            // The model run must actually be torn down, not just ignored.
            abortedDuringRun = config.signal.aborted;
            if (abortedDuringRun) throw abortError();
          },
        );
      });

      await askNotesStream(req, res);

      expect(abortedDuringRun).toBe(true);
      expect(runSignal.aborted).toBe(true);
      expect(Chats).not.toHaveBeenCalled();
      expect(parseFrames(res).map((f) => f.event)).not.toContain("done");
      expect(parseFrames(res).map((f) => f.event)).not.toContain("error");
      expect(res.end).toHaveBeenCalled();
    });

    it("should not open a stream if the client leaves during retrieval", async () => {
      createEmbedding.mockImplementation(async () => {
        req.emit("close");
        return [0.1, 0.2];
      });
      mockAgentStream.mockResolvedValue(makeAgentStream([]));

      await askNotesStream(req, res);

      expect(res.writeHead).not.toHaveBeenCalled();
      expect(res.write).not.toHaveBeenCalled();
      expect(mockAgentStream).not.toHaveBeenCalled();
    });

    it("should stop writing tokens once the client is gone", async () => {
      const res = mockStreamResponse();
      let seen = 0;
      mockAgentStream.mockResolvedValue(
        makeAgentStream(
          [tokenEvent("Docker "), tokenEvent("is a platform.")],
          () => {
            // Flip the flag only once the controller has had a chance to
            // consume the first chunk — i.e. the socket dies between tokens.
            seen++;
            if (seen === 2) res.writableEnded = true;
          },
        ),
      );

      await askNotesStream(req, res);

      expect(streamedText(res)).toBe("Docker ");
    });

    it("should report a mid-stream failure as an error frame", async () => {
      mockAgentStream.mockImplementation(async () => ({
        async *[Symbol.asyncIterator]() {
          yield tokenEvent("Partial ");
          throw new Error("model exploded");
        },
      }));

      await askNotesStream(req, res);

      expect(streamedText(res)).toBe("Partial ");
      expect(framesOfType(res, "error")[0].data).toEqual({
        message: "Something went wrong while processing your request",
      });
      expect(res.end).toHaveBeenCalled();
      // A failed run must not leave a half-finished chat behind.
      expect(Chats).not.toHaveBeenCalled();
    });

    it("should return a plain 500 when retrieval fails before the stream opens", async () => {
      createEmbedding.mockRejectedValue(new Error("API limits exceeded"));

      await askNotesStream(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        message: "Something went wrong while processing your request",
      });
      expect(res.writeHead).not.toHaveBeenCalled();
    });

    it("should fail the stream when persisting the chat fails", async () => {
      mockAgentStream.mockResolvedValue(
        makeAgentStream([
          tokenEvent("Answer."),
          valuesEvent([{ content: "Answer." }]),
        ]),
      );
      mockChatSave.mockRejectedValue(new Error("Write failed"));

      await askNotesStream(req, res);

      expect(framesOfType(res, "error")[0].data).toEqual({
        message: "Something went wrong while processing your request",
      });
      expect(framesOfType(res, "done")).toHaveLength(0);
    });

    it("should error instead of saving a blank chat when no final snapshot arrives", async () => {
      mockAgentStream.mockResolvedValue(makeAgentStream([tokenEvent("Half")]));

      await askNotesStream(req, res);

      // Persisting an empty answer would leave a permanent blank message.
      expect(framesOfType(res, "done")).toHaveLength(0);
      expect(framesOfType(res, "error")[0].data).toEqual({
        message: "Something went wrong while processing your request",
      });
      expect(Chats).not.toHaveBeenCalled();
    });

    it("should keep the close listener detached after the request finishes", async () => {
      mockAgentStream.mockResolvedValue(
        makeAgentStream([valuesEvent([{ content: "Answer." }])]),
      );

      await askNotesStream(req, res);

      expect(req.listenerCount("close")).toBe(0);
    });

    it("should tolerate a malformed chats payload", async () => {
      req.body = { question: "Hello?", chats: null };
      mockAgentStream.mockResolvedValue(
        makeAgentStream([valuesEvent([{ content: "Hi." }])]),
      );

      await askNotesStream(req, res);

      expect(createEmbedding).toHaveBeenCalledWith("Hello?");
      expect(framesOfType(res, "done")[0].data.answer).toBe("Hi.");
    });
  });

  describe("aiChats (Pagination & Caching)", () => {
    beforeEach(() => {
      req = {
        user: { _id: "user123" },
        query: { page: 1, limit: 10 },
      };
    });

    it("should serve chats from Redis cache if available", async () => {
      const mockCachedData = { page: 1, chat: [{ _id: "chat1" }] };
      redisClient.get.mockResolvedValue(JSON.stringify(mockCachedData));

      await aiChats(req, res);

      expect(redisClient.get).toHaveBeenCalledWith("chats:list:user123:1:10");
      expect(Chats.find).not.toHaveBeenCalled(); // DB skipped
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(mockCachedData);
    });

    it("should fetch from DB, set Redis, and return payload on cache miss", async () => {
      redisClient.get.mockResolvedValue(null);
      const dbChats = [{ _id: "chat1", userQuery: "Hi" }];
      mockLimit.mockResolvedValue(dbChats);
      Chats.countDocuments.mockResolvedValue(15);

      await aiChats(req, res);

      expect(Chats.find).toHaveBeenCalledWith({ userId: "user123" });
      expect(mockSort).toHaveBeenCalledWith({ createdAt: -1 });
      expect(mockSkip).toHaveBeenCalledWith(0);
      expect(mockLimit).toHaveBeenCalledWith(10);
      expect(Chats.countDocuments).toHaveBeenCalledWith({ userId: "user123" });

      const expectedPayload = {
        page: 1,
        limit: 10,
        totalChats: 15,
        totalPages: 2,
        chat: dbChats,
      };

      expect(redisClient.setEx).toHaveBeenCalledWith(
        "chats:list:user123:1:10",
        300, // TTL
        JSON.stringify(expectedPayload),
      );

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expectedPayload);
    });

    it("should coerce string query params into numbers", async () => {
      // Express always delivers query values as strings.
      req.query = { page: "2", limit: "5" };
      redisClient.get.mockResolvedValue(null);
      mockLimit.mockResolvedValue([]);
      Chats.countDocuments.mockResolvedValue(12);

      await aiChats(req, res);

      expect(redisClient.get).toHaveBeenCalledWith("chats:list:user123:2:5");
      expect(mockSkip).toHaveBeenCalledWith(5);
      expect(mockLimit).toHaveBeenCalledWith(5);
      expect(res.json).toHaveBeenCalledWith({
        page: 2,
        limit: 5,
        totalChats: 12,
        totalPages: 3,
        chat: [],
      });
    });

    it("should fall back to sane defaults for invalid query params", async () => {
      req.query = { page: "abc", limit: "0" };
      redisClient.get.mockResolvedValue(null);
      mockLimit.mockResolvedValue([]);
      Chats.countDocuments.mockResolvedValue(3);

      await aiChats(req, res);

      expect(redisClient.get).toHaveBeenCalledWith("chats:list:user123:1:20");
      expect(res.json).toHaveBeenCalledWith({
        page: 1,
        limit: 20,
        totalChats: 3,
        totalPages: 1,
        chat: [],
      });
    });

    it("should fall back to the DB when the redis read fails", async () => {
      redisClient.get.mockRejectedValue(new Error("Redis down"));
      mockLimit.mockResolvedValue([]);
      Chats.countDocuments.mockResolvedValue(0);

      await aiChats(req, res);

      expect(Chats.find).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it("should return 500 when the lookup fails", async () => {
      redisClient.get.mockResolvedValue(null);
      Chats.find.mockImplementation(() => {
        throw new Error("DB Error");
      });

      await aiChats(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        message: "Internal server error",
        error: "DB Error",
      });
    });
  });

  describe("deleteChat", () => {
    beforeEach(() => {
      req = {
        user: { _id: "user123" },
        params: { chatId: "chat_456" },
      };
    });

    it("should return 400 if chatId is not provided", async () => {
      req.params.chatId = undefined;
      await deleteChat(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: "Chat ID is required" });
      expect(Chats.findOneAndDelete).not.toHaveBeenCalled();
    });

    it("should return 404 if chat is not found in database", async () => {
      Chats.findOneAndDelete.mockResolvedValue(null);
      await deleteChat(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ message: "Chat not found" });
    });

    it("should delete chat, emit socket event, clear caches, and return 200", async () => {
      Chats.findOneAndDelete.mockResolvedValue({ _id: "chat_456" });

      await deleteChat(req, res);

      expect(Chats.findOneAndDelete).toHaveBeenCalledWith({
        _id: "chat_456",
        userId: "user123",
      });

      // Cache clearing: every cached page plus this chat's detail entry.
      expect(redisClient.keys).toHaveBeenCalledWith("chats:list:user123:*");
      expect(redisClient.del).toHaveBeenCalledWith([
        "chats:list:user123:1:20",
        "chats:detail:chat_456",
      ]);

      // Socket emitted
      expect(getIO).toHaveBeenCalled();
      expect(mockTo).toHaveBeenCalledWith("user123");
      expect(mockEmit).toHaveBeenCalledWith("chat:deleted", "chat_456");

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        message: "Chat deleted successfully",
        id: "chat_456",
      });
    });

    it("should return 500 when the delete fails", async () => {
      Chats.findOneAndDelete.mockRejectedValue(new Error("Delete failed"));

      await deleteChat(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        message: "Internal server error",
        error: "Delete failed",
      });
    });
  });
});
