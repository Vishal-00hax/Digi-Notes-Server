import { jest } from "@jest/globals";

// 1. Create mock functions BEFORE importing the controller
const mockSave = jest.fn();

// `findOne` and `find` are separate model calls, so they must not share a
// projection mock - otherwise a test cannot prove which query was issued.
const mockFindOneSelect = jest.fn();
const mockFindSelect = jest.fn();

const Notes = jest.fn().mockImplementation(() => ({
  save: mockSave,
}));
Notes.findOne = jest.fn().mockReturnValue({ select: mockFindOneSelect });
Notes.find = jest.fn().mockReturnValue({ select: mockFindSelect });
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

  afterEach(() => {
    jest.restoreAllMocks();
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
      // The document handed to the model must carry the owner, content and vector.
      expect(Notes).toHaveBeenCalledWith({
        userId: "user123",
        title: "Test Title",
        text: "Test Text",
        embedding: [0.1, 0.2, 0.3],
      });
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

    it("should still create the note when cache invalidation fails", async () => {
      createEmbedding.mockResolvedValue([0.1]);
      mockSave.mockResolvedValue({ _id: "note123" });
      redisClient.del.mockRejectedValue(new Error("Redis down"));

      await createNotes(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
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
      expect(res.json).toHaveBeenCalledWith({ message: "Invalid notesId" });
      expect(Notes.findOne).not.toHaveBeenCalled();
    });

    it("should return 404 if note is not found", async () => {
      mockFindOneSelect.mockResolvedValue(null);
      await updateNotes(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ message: "Note not found." });
    });

    it("should scope the lookup to the requesting user", async () => {
      mockFindOneSelect.mockResolvedValue({
        title: "Old Title",
        text: "Old Text",
        save: jest.fn().mockResolvedValue({ _id: "note123" }),
      });

      await updateNotes(req, res);

      expect(Notes.findOne).toHaveBeenCalledWith({
        _id: "note123",
        userId: "user123",
      });
      expect(mockFindOneSelect).toHaveBeenCalledWith("-__v");
    });

    it("should update a note, generate new embedding, invalidate caches, and emit socket event", async () => {
      // `save()` resolves to the same object the controller mutates, and the
      // controller strips `embedding` afterwards - so capture the value at the
      // moment of the write to prove the vector was actually persisted.
      let embeddingAtSaveTime;
      const existingNote = {
        _id: "note123",
        title: "Old Title",
        text: "Old Text",
        save: jest.fn().mockImplementation(() => {
          embeddingAtSaveTime = existingNote.embedding;
          return Promise.resolve(existingNote);
        }),
      };
      mockFindOneSelect.mockResolvedValue(existingNote);
      createEmbedding.mockResolvedValue([0.9, 0.8]);

      await updateNotes(req, res);

      expect(createEmbedding).toHaveBeenCalledWith(
        "Title: Updated Title\nContent: Updated Text",
      );

      // The stored document must actually be mutated, not merely re-saved.
      expect(existingNote.title).toBe("Updated Title");
      expect(existingNote.text).toBe("Updated Text");
      expect(embeddingAtSaveTime).toEqual([0.9, 0.8]);
      expect(existingNote.save).toHaveBeenCalled();

      expect(redisClient.del).toHaveBeenCalledWith([
        "notes:list:user123",
        "notes:detail:note123",
      ]);
      expect(mockEmit).toHaveBeenCalledWith("note:updated", expect.any(Object));
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        message: "Notes updated successfull",
        data: existingNote,
      });
      // The embedding vector must not be echoed back to the client.
      expect(existingNote.embedding).toBeUndefined();
    });

    it("should re-embed from the stored values when only the title changes", async () => {
      const existingNote = {
        _id: "note123",
        title: "Old Title",
        text: "Kept Text",
        embedding: [1, 1],
        save: jest
          .fn()
          .mockImplementation(() => Promise.resolve(existingNote)),
      };
      mockFindOneSelect.mockResolvedValue(existingNote);
      createEmbedding.mockResolvedValue([0.5]);
      req.body = { notesId: "note123", title: "Renamed" };

      await updateNotes(req, res);

      expect(createEmbedding).toHaveBeenCalledWith(
        "Title: Renamed\nContent: Kept Text",
      );
      expect(existingNote.title).toBe("Renamed");
      expect(existingNote.text).toBe("Kept Text");
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it("should return 500 when the save fails", async () => {
      const existingNote = {
        title: "Old Title",
        text: "Old Text",
        save: jest.fn().mockRejectedValue(new Error("Write failed")),
      };
      mockFindOneSelect.mockResolvedValue(existingNote);
      createEmbedding.mockResolvedValue([0.9]);

      await updateNotes(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        message: "Internal server error",
        error: "Write failed",
      });
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
      expect(res.json).toHaveBeenCalledWith({ message: "Invalid notesId" });
      expect(Notes.findOneAndDelete).not.toHaveBeenCalled();
    });

    it("should return 404 if note is not found during deletion", async () => {
      Notes.findOneAndDelete.mockResolvedValue(null);
      await deleteNotes(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      // A missing note must be distinguishable from a malformed id.
      expect(res.json).toHaveBeenCalledWith({ message: "Note not found." });
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
      expect(res.json).toHaveBeenCalledWith({
        message: "Delete notes successfull ID:note123",
      });
    });

    it("should return 500 when the delete fails", async () => {
      Notes.findOneAndDelete.mockRejectedValue(new Error("Delete failed"));

      await deleteNotes(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        message: "Internal server error",
        error: "Delete failed",
      });
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
      mockFindOneSelect.mockResolvedValue(dbNote);

      await getNotesById(req, res);

      // Scoped to the requesting user and stripped of the embedding vector.
      expect(Notes.findOne).toHaveBeenCalledWith({
        _id: "note123",
        userId: "user123",
      });
      expect(mockFindOneSelect).toHaveBeenCalledWith("-__v -embedding");
      expect(redisClient.setEx).toHaveBeenCalledWith(
        "notes:detail:note123",
        300, // TTL
        JSON.stringify(dbNote),
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ note: dbNote });
    });

    it("should fall back to the DB when the redis read fails", async () => {
      redisClient.get.mockRejectedValue(new Error("Redis down"));
      const dbNote = { _id: "note123", title: "DB Note" };
      mockFindOneSelect.mockResolvedValue(dbNote);

      await getNotesById(req, res);

      expect(Notes.findOne).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ note: dbNote });
    });

    it("should still return the note when the redis write fails", async () => {
      redisClient.get.mockResolvedValue(null);
      mockFindOneSelect.mockResolvedValue({ _id: "note123" });
      redisClient.setEx.mockRejectedValue(new Error("Redis down"));

      await getNotesById(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ note: { _id: "note123" } });
    });

    it("should return 404 if note is not found in DB", async () => {
      redisClient.get.mockResolvedValue(null);
      mockFindOneSelect.mockResolvedValue(null);

      await getNotesById(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ message: "Note Not Found !" });
    });

    it("should return 500 when the lookup fails", async () => {
      redisClient.get.mockResolvedValue(null);
      Notes.findOne.mockImplementation(() => {
        throw new Error("DB Error");
      });

      await getNotesById(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        message: "Internal server error",
        error: "DB Error",
      });
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
      mockFindSelect.mockResolvedValue(dbList);

      await getUserNotes(req, res);

      expect(Notes.find).toHaveBeenCalledWith({ userId: "user123" });
      expect(mockFindSelect).toHaveBeenCalledWith("-__v -embedding");
      expect(redisClient.setEx).toHaveBeenCalledWith(
        "notes:list:user123",
        300, // TTL
        JSON.stringify(dbList),
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ notes: dbList });
    });

    it("should return an empty list with 200 rather than a 404", async () => {
      redisClient.get.mockResolvedValue(null);
      mockFindSelect.mockResolvedValue([]);

      await getUserNotes(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ notes: [] });
    });

    it("should fall back to the DB when the redis read fails", async () => {
      redisClient.get.mockRejectedValue(new Error("Redis down"));
      const dbList = [{ _id: "note1" }];
      mockFindSelect.mockResolvedValue(dbList);

      await getUserNotes(req, res);

      expect(Notes.find).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ notes: dbList });
    });

    it("should still return the list when the redis write fails", async () => {
      redisClient.get.mockResolvedValue(null);
      mockFindSelect.mockResolvedValue([{ _id: "note1" }]);
      redisClient.setEx.mockRejectedValue(new Error("Redis down"));

      await getUserNotes(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ notes: [{ _id: "note1" }] });
    });

    it("should return 500 when the lookup fails", async () => {
      redisClient.get.mockResolvedValue(null);
      Notes.find.mockImplementation(() => {
        throw new Error("DB Error");
      });

      await getUserNotes(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        message: "Internal server error",
        error: "DB Error",
      });
    });
  });
});
