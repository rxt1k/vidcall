/**
 * server.js — WebRTC Signaling Server
 * Uses Express to serve static files and Socket.IO for WebRTC signaling.
 * The server never touches the actual media streams — it only relays
 * control messages (offers, answers, ICE candidates) between peers.
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' }   // allow cross-origin for local testing on different ports
});

// ── Serve the frontend files from the same folder ───────────────────────────
app.use(express.static(path.join(__dirname)));

// ── Track which sockets are in each room ────────────────────────────────────
// rooms = { roomId: Set<socketId> }
const rooms = {};

io.on('connection', (socket) => {
  console.log(`[+] Socket connected: ${socket.id}`);

  // ── JOIN ROOM ──────────────────────────────────────────────────────────────
  socket.on('join-room', (roomId) => {
    // Leave any previous room this socket might be in
    const prevRoom = [...socket.rooms].find(r => r !== socket.id);
    if (prevRoom) leaveRoom(socket, prevRoom);

    // Cap rooms at 2 participants for a simple 1-to-1 call
    const occupants = rooms[roomId] ? rooms[roomId].size : 0;
    if (occupants >= 2) {
      socket.emit('room-full', roomId);
      return;
    }

    // Join the Socket.IO room
    socket.join(roomId);
    rooms[roomId] = rooms[roomId] || new Set();
    rooms[roomId].add(socket.id);

    console.log(`  Socket ${socket.id} joined room "${roomId}" (${rooms[roomId].size}/2)`);

    // Tell the joining socket how many peers were already in the room
    socket.emit('room-joined', { roomId, peerCount: occupants });

    // Notify the existing peer (if any) that someone new arrived
    socket.to(roomId).emit('user-connected', socket.id);
  });

  // ── WEBRTC SIGNALING — relay offer / answer / ICE to the other peer ───────

  socket.on('offer', ({ roomId, offer }) => {
    console.log(`  [offer]     ${socket.id} → room "${roomId}"`);
    socket.to(roomId).emit('offer', { offer, from: socket.id });
  });

  socket.on('answer', ({ roomId, answer }) => {
    console.log(`  [answer]    ${socket.id} → room "${roomId}"`);
    socket.to(roomId).emit('answer', { answer, from: socket.id });
  });

  socket.on('ice-candidate', ({ roomId, candidate }) => {
    socket.to(roomId).emit('ice-candidate', { candidate, from: socket.id });
  });

  // ── DISCONNECT ─────────────────────────────────────────────────────────────
  socket.on('disconnecting', () => {
    // socket.rooms still contains the rooms at this point
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;   // skip the private room
      leaveRoom(socket, roomId);
      // Notify the remaining peer
      socket.to(roomId).emit('user-disconnected', socket.id);
      console.log(`  Socket ${socket.id} left room "${roomId}"`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[-] Socket disconnected: ${socket.id}`);
  });
});

// ── Helper: remove a socket from our rooms map ──────────────────────────────
function leaveRoom(socket, roomId) {
  if (rooms[roomId]) {
    rooms[roomId].delete(socket.id);
    if (rooms[roomId].size === 0) delete rooms[roomId];
  }
}

// ── Start listening ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀  Signaling server running at http://localhost:${PORT}`);
  console.log('   Open two browser tabs at that address to test.\n');
});