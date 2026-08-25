# Digi-Notes — AI-Powered Notes App with Agentic RAG

Digi-Notes is a full-stack MERN application that reimagines note-taking by pairing traditional CRUD note management with an **agentic RAG (Retrieval-Augmented Generation) assistant** — an AI agent that can read, search, and act on a user's notes through natural conversation, not just answer questions about them.

## Overview

Unlike a standard RAG chatbot that only retrieves and summarizes information, Digi-Notes' assistant is **agentic**: it reasons about user intent, decides which tool to invoke, asks for confirmation before taking destructive or content-generating actions, and executes real operations — creating, updating, or deleting notes — directly from a chat interface, with results synced live across the UI.

## Key Features

- **Agentic AI Assistant** — Built with LangGraph's stateful agent workflow, the assistant autonomously decides whether a user's request needs semantic note retrieval, live web search, or a direct note mutation (create/update/delete), and executes the appropriate tool call.
- **Retrieval-Augmented Generation** — Notes are embedded using OpenAI embeddings and stored alongside their vectors in MongoDB. User questions are answered using **MongoDB Atlas Vector Search** to retrieve only the most semantically relevant notes as context, rather than dumping an entire notes collection into the prompt.
- **Confirmation-Gated Actions** — Before writing, editing, or deleting a note, the agent explicitly confirms with the user, then generates real, complete content itself (not a copy of the user's instruction) — including pulling in live web search results when a task needs current information.
- **Real-Time Sync** — Socket.IO broadcasts note and chat events (`note:created`, `note:updated`, `note:deleted`, `chat:created`) so changes appear instantly across all connected sessions without a page refresh.
- **Secure, Rotating Authentication** — JWT-based access/refresh token flow with refresh tokens stored in a dedicated MongoDB collection secured by a **TTL index** for automatic expiry, supporting multi-device session limits and "log out all other devices" functionality.
- **Performance Caching Layer** — Redis (via Upstash) caches notes and chat list/detail responses with TTL-based expiry and write-path invalidation, cutting redundant database reads while gracefully degrading to MongoDB if the cache is ever unavailable.

## Tech Stack

**Frontend:** React, Redux Toolkit
**Backend:** Node.js, Express 5
**Database:** MongoDB (Mongoose) with Atlas Vector Search
**AI / Agent Layer:** LangChain, LangGraph, OpenAI (LLM + embeddings), Tavily / web search tooling
**Caching:** Redis (Upstash)
**Real-Time:** Socket.IO
**Auth:** JWT (access + refresh tokens), bcrypt, httpOnly cookies
**Deployment:** Render (backend), Vercel (frontend)

## Architecture Highlights

- **Vector search pipeline:** each note's title and content are embedded on create/update; user questions are embedded at query time and matched via MongoDB's `$vectorSearch` aggregation stage, filtered to the requesting user and thresholded by relevance score to avoid low-quality matches.
- **Stateful agent graph:** a LangGraph `StateGraph` routes between an LLM reasoning node and a tool-execution node, looping until the agent produces a final response — enabling multi-step tool use (e.g., search the web, then create a note from the results) within a single user request.
- **Resilient caching:** every cache read/write is isolated in its own try/catch so a Redis outage never surfaces as a user-facing error — the app transparently falls back to MongoDB.

---

*Digi-Notes demonstrates end-to-end ownership of a modern AI product: schema design for vector search, agent orchestration, real-time systems, caching strategy, and production-grade auth — not just a wrapper around an LLM API call.*
