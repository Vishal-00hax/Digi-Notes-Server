import express from "express";
import connectDB from "../server/config/db.js";
import "dotenv/config";
import cookieParser from "cookie-parser";
import authRouter from "../server/routes/authRouter.js";
import notesRouter from "./routes/notesRouter.js";
import cors from "cors";
import http from "http";
import { initializeSocket } from "./utils/socket-io.js";

const app = express();

app.use(express.json());
app.use(cookieParser());

export const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:4000",
  "https://vishaldevtribe.com",
  "https://ai-resume-builder.vishaldevtribe.com", // इसे सीधे यहाँ भी डाल दें ताकि तुरंत काम करे
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (जैसे Postman या server-to-server)
      if (!origin) return callback(null, true);

      // check if origin is in allowedOrigins
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.log("Blocked by CORS:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"], // यह हेडर जोड़ना ज़रूरी है
    optionsSuccessStatus: 200, // कुछ पुराने ब्राउज़र्स 204 की जगह 200 मांगते हैं
  }),
);

app.use("/api/auth/", authRouter);
app.use("/api/notes", notesRouter);

const PORT = process.env.PORT || 7777;

const server = http.createServer(app);
initializeSocket(server);

connectDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server is running at ${PORT}`);
    });
  })
  .catch((err) => {
    console.log(`Database connexction err ${err}`);
  });
