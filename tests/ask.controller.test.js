import { jest } from "@jest/globals";

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
const mockCompile = jest.fn().mockReturnValue({ invoke: mockAgentInvoke });
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
const { askNotes, aiChats, deleteChat } =
  await import("../controllers/askController.js");

describe("AI Chats Controller", () => {
  let req, res;

  const mockResponse = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
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
