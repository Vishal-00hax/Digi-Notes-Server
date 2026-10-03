import { jest } from "@jest/globals";

// 1. Create mock functions BEFORE importing the controller
const User = jest.fn();
User.findOne = jest.fn();
User.findById = jest.fn();
User.findByIdAndUpdate = jest.fn();

const RefreshToken = {
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(),
  findOne: jest.fn(),
  deleteOne: jest.fn(),
};

const bcrypt = { hash: jest.fn() };
const jwt = { verify: jest.fn() };
const getIO = jest.fn();

// 2. Register mocks into Jest's ES Module cache
jest.unstable_mockModule("../models/user.js", () => ({ default: User }));
jest.unstable_mockModule("../models/refreshToken.js", () => ({
  default: RefreshToken,
}));
jest.unstable_mockModule("bcrypt", () => ({ default: bcrypt }));
jest.unstable_mockModule("jsonwebtoken", () => ({ default: jwt }));
jest.unstable_mockModule("../utils/socket-io.js", () => ({ getIO }));

// 3. Dynamically import the controller AFTER mocks are securely in place
const {
  userSignUp,
  userLogIn,
  userLogout,
  userProfile,
  refreshAccessToken,
  logoutAllSessions,
} = await import("../controllers/authController.js");

const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

describe("Auth Controller", () => {
  let req, res;

  const mockResponse = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.cookie = jest.fn().mockReturnValue(res);
    res.clearCookie = jest.fn().mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    res = mockResponse();

    // Add these two lines to hide console logs during tests
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("userSignUp", () => {
    beforeEach(() => {
      req = {
        body: {
          full_name: "Test User",
          email: "test@test.com",
          password: "password123",
        },
        ip: "127.0.0.1",
      };
    });

    it("should return 400 if fields are missing", async () => {
      req.body.email = undefined;
      await userSignUp(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        message: "Invalid crediancials",
      });
    });

    it("should return 400 if user already exists", async () => {
      User.findOne.mockResolvedValue({ _id: "existing_id" });
      await userSignUp(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: "User already exsist" });
    });

    it("should successfully register a new user, set cookies, and return 201", async () => {
      User.findOne.mockResolvedValue(null);
      bcrypt.hash.mockResolvedValue("hashedPassword");

      const savedUser = { _id: "new_user_id", password: "hashedPassword" };
      const mockUserInstance = {
        _id: "new_user_id",
        getAccessToken: jest.fn().mockReturnValue("access_token"),
        getRefreshToken: jest.fn().mockReturnValue("refresh_token"),
        save: jest.fn().mockResolvedValue(savedUser),
      };
      User.mockImplementation(() => mockUserInstance);
      RefreshToken.findOneAndUpdate.mockResolvedValue({});

      await userSignUp(req, res);

      expect(User.findOne).toHaveBeenCalledWith({ email: "test@test.com" });
      expect(bcrypt.hash).toHaveBeenCalledWith("password123", 10);
      expect(User).toHaveBeenCalledWith({
        full_name: "Test User",
        email: "test@test.com",
        password: "hashedPassword",
      });
      expect(mockUserInstance.save).toHaveBeenCalled();

      // The refresh-token record must store the token, the caller's IP and an
      // expiry date - not just "some object".
      expect(RefreshToken.findOneAndUpdate).toHaveBeenCalledWith(
        { userId: "new_user_id" },
        {
          $push: { token: "refresh_token" },
          $set: { ip: "127.0.0.1", expiresAt: expect.any(Date) },
        },
        { upsert: true, returnDocument: "after" },
      );

      expect(res.cookie).toHaveBeenNthCalledWith(
        1,
        "accessToken",
        "access_token",
        expect.objectContaining({ httpOnly: true, maxAge: ACCESS_TTL_MS }),
      );
      expect(res.cookie).toHaveBeenNthCalledWith(
        2,
        "refreshToken",
        "refresh_token",
        expect.objectContaining({ httpOnly: true, maxAge: REFRESH_TTL_MS }),
      );
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ user: savedUser });

      // The hashed password must never reach the client.
      expect(savedUser.password).toBeUndefined();
    });

    it("should return 400 on unexpected errors", async () => {
      User.findOne.mockRejectedValue(new Error("DB Error"));
      await userSignUp(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        message: "User Creating failed DB Error",
      });
    });
  });

  describe("userLogIn", () => {
    beforeEach(() => {
      req = {
        body: { email: "test@test.com", password: "password123" },
        ip: "127.0.0.1",
      };
    });

    it("should return 404 if user is not found", async () => {
      User.findOne.mockReturnValue({
        select: jest.fn().mockResolvedValue(null),
      });
      await userLogIn(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ message: "User not found !" });
    });

    it("should return 400 if password does not match", async () => {
      const mockUser = { verifyPassword: jest.fn().mockResolvedValue(false) };
      User.findOne.mockReturnValue({
        select: jest.fn().mockResolvedValue(mockUser),
      });

      await userLogIn(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: "Invalid Inputs" });
    });

    it("should login successfully, set cookies, and return 200", async () => {
      const mockUser = {
        _id: "user123",
        password: "hashedPassword",
        __v: 3,
        verifyPassword: jest.fn().mockResolvedValue(true),
        getAccessToken: jest.fn().mockReturnValue("access_token"),
        getRefreshToken: jest.fn().mockReturnValue("refresh_token"),
        save: jest.fn().mockResolvedValue(true),
      };
      User.findOne.mockReturnValue({
        select: jest.fn().mockResolvedValue(mockUser),
      });
      RefreshToken.findOneAndUpdate.mockResolvedValue({});

      await userLogIn(req, res);

      expect(mockUser.verifyPassword).toHaveBeenCalledWith("password123");
      expect(mockUser.save).toHaveBeenCalled();
      expect(RefreshToken.findOneAndUpdate).toHaveBeenCalledWith(
        { userId: "user123" },
        {
          $push: { token: "refresh_token" },
          $set: { ip: "127.0.0.1", expiresAt: expect.any(Date) },
        },
        { upsert: true, returnDocument: "after" },
      );

      expect(res.cookie).toHaveBeenNthCalledWith(
        1,
        "accessToken",
        "access_token",
        expect.objectContaining({ httpOnly: true, maxAge: ACCESS_TTL_MS }),
      );
      expect(res.cookie).toHaveBeenNthCalledWith(
        2,
        "refreshToken",
        "refresh_token",
        expect.objectContaining({ httpOnly: true, maxAge: REFRESH_TTL_MS }),
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ user: mockUser });

      // Neither the password hash nor the mongoose version key may be echoed.
      expect(mockUser.password).toBeUndefined();
      expect(mockUser.__v).toBeUndefined();
    });

    it("should return 500 when the lookup fails unexpectedly", async () => {
      User.findOne.mockReturnValue({
        select: jest.fn().mockRejectedValue(new Error("DB Error")),
      });

      await userLogIn(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: "Internal server error" });
    });
  });

  describe("userLogout", () => {
    beforeEach(() => {
      req = {
        user: { _id: "user123" },
        cookies: { refreshToken: "test_refresh_token" },
      };
    });

    it("should remove token from db, clear cookies, and return 200", async () => {
      RefreshToken.updateOne.mockResolvedValue({});

      await userLogout(req, res);

      expect(RefreshToken.updateOne).toHaveBeenCalledWith(
        { userId: "user123" },
        { $pull: { token: "test_refresh_token" } },
      );
      expect(res.clearCookie).toHaveBeenCalledTimes(2);
      expect(res.json).toHaveBeenCalledWith({ message: "Logout Successfull" });
    });

    it("should handle a missing refresh token gracefully and clear cookies", async () => {
      req.cookies = {};
      await userLogout(req, res);

      expect(RefreshToken.updateOne).not.toHaveBeenCalled();
      expect(res.clearCookie).toHaveBeenCalledTimes(2);
      expect(res.json).toHaveBeenCalledWith({ message: "Logout Successfull" });
    });

    it("should handle a missing user gracefully and clear cookies", async () => {
      req.user = undefined;
      await userLogout(req, res);

      expect(RefreshToken.updateOne).not.toHaveBeenCalled();
      expect(res.clearCookie).toHaveBeenCalledTimes(2);
      expect(res.json).toHaveBeenCalledWith({ message: "Logout Successfull" });
    });

    it("should return 500 when removing the stored token fails", async () => {
      RefreshToken.updateOne.mockRejectedValue(new Error("DB Error"));

      await userLogout(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: "Internal server error" });
    });
  });

  describe("userProfile", () => {
    beforeEach(() => {
      req = {
        user: {
          _id: "user123",
          name: "Test",
          password: "hashedPassword",
          __v: 2,
          tokenValidAfter: new Date(),
        },
      };
    });

    it("should return 404 when req.user is missing", async () => {
      req = {};

      await userProfile(req, res);

      expect.assertions(3);
      expect(RefreshToken.findOne).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ message: "User not found." });
    });

    it("should return 500 when the session lookup fails", async () => {
      RefreshToken.findOne.mockRejectedValue(new Error("DB Error"));

      await userProfile(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: "Internal server error" });
    });

    it("should return user and total sessions", async () => {
      RefreshToken.findOne.mockResolvedValue({ token: ["token1", "token2"] });

      await userProfile(req, res);

      expect(RefreshToken.findOne).toHaveBeenCalledWith({ userId: "user123" });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        user: req.user,
        total_sessions: 2,
      });

      // Sensitive fields must be stripped from the profile response.
      expect(req.user.password).toBeUndefined();
      expect(req.user.__v).toBeUndefined();
      expect(req.user.tokenValidAfter).toBeUndefined();
    });

    it("should report 0 sessions when the user has no session document", async () => {
      RefreshToken.findOne.mockResolvedValue(null);

      await userProfile(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        user: req.user,
        total_sessions: 0,
      });
    });
  });

  describe("refreshAccessToken", () => {
    beforeEach(() => {
      req = { cookies: { refreshToken: "old_refresh_token" } };
      process.env.JWT_SECRET = "secret";
    });

    it("should return 401 if refresh token is missing", async () => {
      req.cookies = {};
      await refreshAccessToken(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        message: "Refresh token missing, please login again",
      });
    });

    it("should return 401 if jwt verification fails", async () => {
      jwt.verify.mockImplementation(() => {
        throw new Error("Invalid token");
      });
      await refreshAccessToken(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        message: "Invalid or expired refresh token",
      });
    });

    it("should return 401 if the token payload carries no user id", async () => {
      jwt.verify.mockReturnValue({ email: "test@test.com" });
      await refreshAccessToken(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        message: "Invalid token payload",
      });
      expect(User.findById).not.toHaveBeenCalled();
    });

    it("should return 401 if token not found in database", async () => {
      jwt.verify.mockReturnValue({ _id: "user123" });
      RefreshToken.findOne.mockResolvedValue(null);
      await refreshAccessToken(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      // The lookup must be scoped to this exact token (anti-replay), not just
      // to the user - otherwise any of their sessions would be accepted.
      expect(RefreshToken.findOne).toHaveBeenCalledWith({
        userId: "user123",
        token: "old_refresh_token",
      });
      expect(res.json).toHaveBeenCalledWith({
        message: "Refresh token not found or already used",
      });
    });

    it("should return 401 if the user behind the token no longer exists", async () => {
      jwt.verify.mockReturnValue({ _id: "user123" });
      RefreshToken.findOne.mockResolvedValue({
        token: ["old_refresh_token"],
        save: jest.fn(),
      });
      User.findById.mockResolvedValue(null);

      await refreshAccessToken(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: "User not found" });
    });

    it("should return 500 when the token lookup throws", async () => {
      jwt.verify.mockReturnValue({ _id: "user123" });
      RefreshToken.findOne.mockRejectedValue(new Error("DB Error"));

      await refreshAccessToken(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: "Internal server error" });
    });

    it("should successfully rotate tokens and return 200", async () => {
      jwt.verify.mockReturnValue({ _id: "user123" });

      const mockRefreshTokenDoc = {
        token: ["old_refresh_token", "another_session_token"],
        save: jest.fn().mockResolvedValue(true),
      };
      RefreshToken.findOne.mockResolvedValue(mockRefreshTokenDoc);

      const mockUser = {
        _id: "user123",
        getAccessToken: jest.fn().mockReturnValue("new_access_token"),
        getRefreshToken: jest.fn().mockReturnValue("new_refresh_token"),
      };
      User.findById.mockResolvedValue(mockUser);

      await refreshAccessToken(req, res);

      expect(jwt.verify).toHaveBeenCalledWith(
        "old_refresh_token",
        process.env.JWT_SECRET,
      );

      // Rotation: the spent token must be evicted, the new one added, and every
      // other concurrent session left untouched.
      expect(mockRefreshTokenDoc.token).toEqual([
        "another_session_token",
        "new_refresh_token",
      ]);
      expect(mockRefreshTokenDoc.token).not.toContain("old_refresh_token");
      expect(mockRefreshTokenDoc.expiresAt).toBeInstanceOf(Date);
      expect(mockRefreshTokenDoc.save).toHaveBeenCalled();

      expect(res.cookie).toHaveBeenNthCalledWith(
        1,
        "accessToken",
        "new_access_token",
        expect.objectContaining({ httpOnly: true, maxAge: ACCESS_TTL_MS }),
      );
      expect(res.cookie).toHaveBeenNthCalledWith(
        2,
        "refreshToken",
        "new_refresh_token",
        expect.objectContaining({ httpOnly: true, maxAge: REFRESH_TTL_MS }),
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        message: "Access token refreshed",
      });
    });
  });

  describe("logoutAllSessions", () => {
    beforeEach(() => {
      req = { user: { _id: "user123" } };
    });

    it("should return 401 if user is unauthorized", async () => {
      req.user = undefined;
      await logoutAllSessions(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("should return 404 if no tokens are found", async () => {
      RefreshToken.deleteOne.mockResolvedValue({ deletedCount: 0 });
      await logoutAllSessions(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ message: "Tokens not found !" });
    });

    it("should return 500 when deleting the tokens fails", async () => {
      RefreshToken.deleteOne.mockRejectedValue(new Error("DB Error"));

      await logoutAllSessions(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: "Internal server error" });
    });

    it("should delete tokens, invalidate token usage, emit socket, and return 200", async () => {
      RefreshToken.deleteOne.mockResolvedValue({ deletedCount: 1 });
      User.findByIdAndUpdate.mockResolvedValue(true);

      const mockEmit = jest.fn();
      const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
      getIO.mockReturnValue({ to: mockTo });

      await logoutAllSessions(req, res);

      expect(RefreshToken.deleteOne).toHaveBeenCalledWith({
        userId: "user123",
      });
      // Bumping tokenValidAfter is what actually invalidates every issued JWT.
      expect(User.findByIdAndUpdate).toHaveBeenCalledWith("user123", {
        tokenValidAfter: expect.any(Date),
      });
      expect(res.clearCookie).toHaveBeenCalledTimes(2);
      expect(getIO).toHaveBeenCalled();
      expect(mockTo).toHaveBeenCalledWith("user123");
      expect(mockEmit).toHaveBeenCalledWith("force-logout");
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        message: "Logout successfull from all sessions",
      });
    });

    it("should not fail the API if socket emission fails", async () => {
      RefreshToken.deleteOne.mockResolvedValue({ deletedCount: 1 });
      User.findByIdAndUpdate.mockResolvedValue(true);

      getIO.mockImplementation(() => {
        throw new Error("Socket not initialized");
      });

      await logoutAllSessions(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        message: "Logout successfull from all sessions",
      });
    });
  });
});
