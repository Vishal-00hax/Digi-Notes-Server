import express from "express";
import connectDB from "../server/config/db.js";
import "dotenv/config";
import cookieParser from "cookie-parser";
import authRouter from "../server/routes/authRouter.js";
import notesRouter from "./routes/notesRouter.js";

const app = express();

app.use(express.json());
app.use(cookieParser());

app.use("/api/auth/", authRouter);
app.use("/api/notes", notesRouter);

const PORT = process.env.PORT || 7777;

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running at ${PORT}`);
    });
  })
  .catch((err) => {
    console.log(`Database connexction err ${err}`);
  });
