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

  describe("askNotes (AI Agent Workflow)", () => {
    beforeEach(() => {
      req = {
        user: { _id: "user123" },
        body: { question: "What is Docker?" },
      };
      createEmbedding.mockResolvedValue([0.1, 0.2]);
      Notes.aggregate.mockResolvedValue([
        {
          _id: "note1",
          title: "Docker",
          text: "Containers",
          updatedAt: "2024-01-01",
        },
      ]);
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

      // Verify embedding and vector search ran
      expect(createEmbedding).toHaveBeenCalledWith("What is Docker?");
      expect(Notes.aggregate).toHaveBeenCalled();

      // Verify AI Agent ran
      expect(StateGraph).toHaveBeenCalled();
      expect(mockCompile).toHaveBeenCalled();
      expect(mockAgentInvoke).toHaveBeenCalled();

      // Verify Cache clearing & DB saving
      expect(redisClient.keys).toHaveBeenCalledWith("chats:list:user123:*");
      expect(redisClient.del).toHaveBeenCalled(); // Should clear cache
      expect(mockChatSave).toHaveBeenCalled();

      // Verify Socket emitted
      expect(getIO).toHaveBeenCalled();
      expect(mockEmit).toHaveBeenCalledWith("chat:created", expect.any(Object));

      // Verify API Response
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          question: "What is Docker?",
          answer: "Docker is a containerization platform.",
          source: expect.any(Array),
        }),
      );
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
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          actionTriggered: true,
          actionTool: ["create_note"],
          // Note: 'source' should be omitted for action tools based on your logic
        }),
      );
    });

    it("should handle internal server errors gracefully", async () => {
      createEmbedding.mockRejectedValue(new Error("API limits exceeded"));
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
    });

    it("should return 404 if chat is not found in database", async () => {
      Chats.findOneAndDelete.mockResolvedValue(null);
      await deleteChat(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it("should delete chat, emit socket event, clear caches, and return 200", async () => {
      Chats.findOneAndDelete.mockResolvedValue({ _id: "chat_456" });

      await deleteChat(req, res);

      expect(Chats.findOneAndDelete).toHaveBeenCalledWith({
        _id: "chat_456",
        userId: "user123",
      });

      // Cache clearing
      expect(redisClient.keys).toHaveBeenCalledWith("chats:list:user123:*");
      expect(redisClient.del).toHaveBeenCalled();

      // Socket emitted
      expect(getIO).toHaveBeenCalled();
      expect(mockEmit).toHaveBeenCalledWith("chat:deleted", "chat_456");

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        message: "Chat deleted successfully",
        id: "chat_456",
      });
    });
  });
});
