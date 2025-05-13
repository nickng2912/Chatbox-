import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import fs from "fs";

async function startServer() {
  const dbPath = "./chat.db";
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    console.log("chat.db deleted for fresh start.");
  }

  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const app = express();
  const server = createServer(app);
  const io = new Server(server);
  const roomUsers: Map<string, Set<string>> = new Map();

  app.use(express.static(path.resolve(__dirname, "..", "public")));

  io.on("connection", async (socket) => {
    const username = socket.handshake.auth.username || "Anonymous";
    socket.data.username = username;

    const room = String(socket.handshake.auth.room || "0");
    socket.data.room = room;
    socket.join(room);

    if (!roomUsers.has(room)) roomUsers.set(room, new Set());
    roomUsers.get(room)!.add(username);
    io.to(room).emit("room users", Array.from(roomUsers.get(room)!));

    console.log(`${username} connected and joined room ${room}`);
    io.to(room).emit("system message", `${username} joined the room`);

    try {
      const pastMessages = await db.all(
        `SELECT username, content FROM messages WHERE room = ? ORDER BY timestamp ASC LIMIT 50`,
        room
      );
      socket.emit("chat history", pastMessages);
    } catch (err) {
      console.error("Failed to load chat history on join:", err);
    }

    socket.on("chat message", async (msg: string) => {
      const room = socket.data.room;
      const username = socket.data.username;

      try {
        await db.run(
          `INSERT INTO messages (room, username, content) VALUES (?, ?, ?)`,
          room,
          username,
          msg
        );
      } catch (err) {
        console.error("Failed to save message:", err);
        return;
      }

      io.to(room).emit("chat message", {
        username,
        message: msg,
      });
    });

    socket.on("switch room", async (newRoom: string) => {
      const oldRoom = socket.data.room;
      socket.leave(oldRoom);
      roomUsers.get(oldRoom)?.delete(username);
      io.to(oldRoom).emit("room users", Array.from(roomUsers.get(oldRoom)!));
      io.to(oldRoom).emit("system message", `${username} left the room`);

      socket.join(newRoom);
      io.to(newRoom).emit("system message", `${username} joined the room`);
      socket.data.room = newRoom;

      try {
        const pastMessages = await db.all(
          `SELECT username, content FROM messages WHERE room = ? ORDER BY timestamp ASC LIMIT 50`,
          newRoom
        );
        socket.emit("chat history", pastMessages);
      } catch (err) {
        console.error("Failed to load chat history for new room:", err);
      }

      if (!roomUsers.has(newRoom)) roomUsers.set(newRoom, new Set());
      roomUsers.get(newRoom)!.add(username);
      io.to(newRoom).emit("room users", Array.from(roomUsers.get(newRoom)!));

      console.log(`${username} switched from ${oldRoom} to ${newRoom}`);
    });

    socket.on("disconnect", () => {
      const room = socket.data.room;
      roomUsers.get(room)?.delete(username);
      io.to(room).emit("room users", Array.from(roomUsers.get(room)!));
      console.log(`${username} disconnected from room ${room}`);
      io.to(room).emit("system message", `${username} left the room`);
    });
  });

  const PORT = 3000;
  server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
});
