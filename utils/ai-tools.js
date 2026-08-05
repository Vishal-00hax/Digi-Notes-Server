import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  createNotes,
  updateNotes,
  deleteNotes,
} from "../controllers/notesController.js";
import { text } from "express";

const ProxyWrapperController = (controller, reqProxy) => {
  return new Promise((resolve) => {
    const resProxy = {
      statusCode: 200,
      status: function (code) {
        this.statusCode = code;
        return this;
      },
      json: function (data) {
        console.log(`✅ Tool Success [${this.statusCode}]:`, data);
        resolve(
          JSON.stringify({
            aiActionTriggered: true,
            statusCode: this.statusCode,
            ...data,
          }),
        );
      },
    };

    try {
      controller(reqProxy, resProxy).catch((err) => {
        console.error("❌ Async Controller Error:", err);
        resolve(JSON.stringify({ statusCode: 500, error: err.message }));
      });
    } catch (err) {
      console.error("❌ Sync Controller Error:", err);
      resolve(JSON.stringify({ statusCode: 500, error: err.message }));
    }
  });
};

// Notes tool for AI to create, update and delete notes

export const getAiTools = (req) => {
  const createNoteTool = tool(
    async ({ title, text }) => {
      const customReq = { user: req.user, body: { title, text } };
      const result = await ProxyWrapperController(createNotes, customReq);
      return result;
    },
    {
      name: "create_note",
      description: "Create a new note for the user based on their request.",
      schema: z.object({
        title: z.string().describe("Title of the note"),
        text: z.string().optional().describe("Content of the note"),
      }),
    },
  );

  const updateNoteTool = tool(
    async ({ noteId, title, text }) => {
      const customReq = {
        user: req.user,
        body: { notesId: noteId, title, text },
      };
      const result = await ProxyWrapperController(updateNotes, customReq);
      return result;
    },
    {
      name: "update_note",
      description:
        "Update an existing note. DO NOT ask the user for the ID. Find the ID from the Notes Context.",
      schema: z.object({
        noteId: z
          .string()
          .describe(
            "The EXACT 24-character hexadecimal ID of the note extracted from the context (e.g., '6a72201990e3c41a1938c5b5'). NEVER ask the user for it.",
          ),
        title: z.string().optional().describe("New title of the note"),
        text: z.string().optional().describe("New content of the note"),
      }),
    },
  );

  const deleteNoteTool = tool(
    async ({ noteId }) => {
      const customReq = { user: req.user, params: { notesId: noteId } };
      const result = await ProxyWrapperController(deleteNotes, customReq);
      return result;
    },
    {
      name: "delete_note",
      description:
        "Delete an existing note. DO NOT ask the user for the ID. Find the ID from the Notes Context.",
      schema: z.object({
        noteId: z
          .string()
          .describe(
            "The EXACT 24-character hexadecimal ID of the note extracted from the context (e.g., '6a72201990e3c41a1938c5b5'). NEVER ask the user for it.",
          ),
      }),
    },
  );

  return [createNoteTool, updateNoteTool, deleteNoteTool];
};
