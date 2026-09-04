import { jest } from "@jest/globals";

// 1. Create mock functions BEFORE importing the controller
const mockSelect = jest.fn();
const mockSave = jest.fn();

const Notes = jest.fn().mockImplementation(() => ({
  save: mockSave,
}));
Notes.findOne = jest.fn().mockReturnValue({ select: mockSelect });
Notes.find = jest.fn().mockReturnValue({ select: mockSelect });
Notes.findOneAndDelete = jest.fn();

const createEmbedding = jest.fn();

const mockEmit = jest.fn();
const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
const getIO = jest.fn().mockReturnValue({ to: mockTo });

const redisClient = {
  del: jest.fn(),
  get: jest.fn(),
  setEx: jest.fn(),
};

// 2. Register mocks into Jest's ES Module cache
jest.unstable_mockModule("../models/notes.js", () => ({ default: Notes }));
jest.unstable_mockModule("../utils/genrateEmbedding.js", () => ({
  createEmbedding,
}));
jest.unstable_mockModule("../utils/socket-io.js", () => ({ getIO }));
jest.unstable_mockModule("../config/redisClient.js", () => ({ redisClient }));

// 3. Dynamically import the controller AFTER mocks are securely in place
const { createNotes, updateNotes, deleteNotes, getNotesById, getUserNotes } =
  await import("../controllers/notesController.js"); // Ensure this path matches your file name!

describe("Notes Controller", () => {
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
    // Reset console warnings/errors to keep test output clean
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  describe("createNotes", () => {
    beforeEach(() => {
      req = {
        user: { _id: "user123" },
        body: { title: "Test Title", text: "Test Text" },
      };
    });

    it("should create a note, generate embedding, clear cache, and emit socket event", async () => {
      createEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
      mockSave.mockResolvedValue({ _id: "note123", title: "Test Title" });

      await createNotes(req, res);

      expect(createEmbedding).toHaveBeenCalledWith(
        "Title: Test Title\nContent: Test Text",
      );
      expect(mockSave).toHaveBeenCalled();
      expect(redisClient.del).toHaveBeenCalledWith(["notes:list:user123"]);
      expect(getIO).toHaveBeenCalled();
      expect(mockTo).toHaveBeenCalledWith("user123");
      expect(mockEmit).toHaveBeenCalledWith("note:created", expect.any(Object));

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ data: "note123" });
    });

    it("should use default values if title and text are missing", async () => {
      req.body = {};
      createEmbedding.mockResolvedValue([0.1]);
      mockSave.mockResolvedValue({ _id: "note123" });

      await createNotes(req, res);

      expect(createEmbedding).toHaveBeenCalledWith(
        "Title: New-Note\nContent: Empty note",
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it("should return 500 on server error", async () => {
      createEmbedding.mockRejectedValue(new Error("AI Error"));

      await createNotes(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        message: "Internal server error",
        error: "AI Error",
      });
    });
  });

  describe("updateNotes", () => {
    beforeEach(() => {
      req = {
        user: { _id: "user123" },
        body: {
          notesId: "note123",
          title: "Updated Title",
          text: "Updated Text",
        },
      };
    });

    it("should return 400 if notesId is missing", async () => {
      req.body.notesId = undefined;
      await updateNotes(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("should return 404 if note is not found", async () => {
      mockSelect.mockResolvedValue(null);
      await updateNotes(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it("should update a note, generate new embedding, invalidate caches, and emit socket event", async () => {
      const existingNote = {
        title: "Old Title",
        text: "Old Text",
        save: jest
          .fn()
          .mockResolvedValue({ _id: "note123", title: "Updated Title" }),
      };
      mockSelect.mockResolvedValue(existingNote);
      createEmbedding.mockResolvedValue([0.9, 0.8]);

      await updateNotes(req, res);

      expect(createEmbedding).toHaveBeenCalledWith(
        "Title: Updated Title\nContent: Updated Text",
      );
      expect(existingNote.save).toHaveBeenCalled();
      expect(redisClient.del).toHaveBeenCalledWith([
        "notes:list:user123",
        "notes:detail:note123",
      ]);
      expect(mockEmit).toHaveBeenCalledWith("note:updated", expect.any(Object));
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe("deleteNotes", () => {
    beforeEach(() => {
      req = {
        user: { _id: "user123" },
        params: { notesId: "note123" },
      };
    });

    it("should return 400 if notesId is missing", async () => {
      req.params.notesId = undefined;
      await deleteNotes(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("should return 400 if note is not found during deletion", async () => {
      Notes.findOneAndDelete.mockResolvedValue(null);
      await deleteNotes(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("should delete note, clear cache, and emit socket event", async () => {
      Notes.findOneAndDelete.mockResolvedValue({ _id: "note123" });

      await deleteNotes(req, res);

      expect(Notes.findOneAndDelete).toHaveBeenCalledWith({
        _id: "note123",
        userId: "user123",
      });
      expect(redisClient.del).toHaveBeenCalledWith([
        "notes:list:user123",
        "notes:detail:note123",
      ]);
      expect(mockEmit).toHaveBeenCalledWith("note:deleted", "note123");
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe("getNotesById", () => {
    beforeEach(() => {
      req = {
        user: { _id: "user123" },
        params: { notesId: "note123" },
      };
    });

    it("should serve note from Redis cache if available", async () => {
      const cachedNote = { _id: "note123", title: "Cached Note" };
      redisClient.get.mockResolvedValue(JSON.stringify(cachedNote));

      await getNotesById(req, res);

      expect(redisClient.get).toHaveBeenCalledWith("notes:detail:note123");
      expect(Notes.findOne).not.toHaveBeenCalled(); // DB should not be hit
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ note: cachedNote });
    });

    it("should fetch from DB and save to Redis if cache misses", async () => {
      redisClient.get.mockResolvedValue(null);
      const dbNote = { _id: "note123", title: "DB Note" };
      mockSelect.mockResolvedValue(dbNote);

      await getNotesById(req, res);

      expect(Notes.findOne).toHaveBeenCalled();
      expect(redisClient.setEx).toHaveBeenCalledWith(
        "notes:detail:note123",
        300, // TTL
        JSON.stringify(dbNote),
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it("should return 404 if note is not found in DB", async () => {
      redisClient.get.mockResolvedValue(null);
      mockSelect.mockResolvedValue(null);

      await getNotesById(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe("getUserNotes", () => {
    beforeEach(() => {
      req = { user: { _id: "user123" } };
    });

    it("should serve notes list from Redis cache if available", async () => {
      const cachedList = [{ _id: "note1", title: "Note 1" }];
      redisClient.get.mockResolvedValue(JSON.stringify(cachedList));

      await getUserNotes(req, res);

      expect(redisClient.get).toHaveBeenCalledWith("notes:list:user123");
      expect(Notes.find).not.toHaveBeenCalled(); // DB should not be hit
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ notes: cachedList });
    });

    it("should fetch list from DB and save to Redis if cache misses", async () => {
      redisClient.get.mockResolvedValue(null);
      const dbList = [{ _id: "note1", title: "Note 1" }];
      mockSelect.mockResolvedValue(dbList);

      await getUserNotes(req, res);

      expect(Notes.find).toHaveBeenCalled();
      expect(redisClient.setEx).toHaveBeenCalledWith(
        "notes:list:user123",
        300, // TTL
        JSON.stringify(dbList),
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
