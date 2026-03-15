/**
 * server.js — PeerSpace Signaling Server
 * Express + Socket.IO — relays WebRTC signaling between peers.
 * Deploy this on Render; it also serves the static frontend files.
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',          // allow Netlify frontend + any origin
    methods: ['GET', 'POST']
  }
});

// Serve frontend static files from same directory
app.use(express.static(path.join(__dirname)));

// ── Room tracking ────────────────────────────────────────────────────────────
const rooms = {};   // { roomId: Set<socketId> }

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);

  // ── Join room ──────────────────────────────────────────────────────────────
  socket.on('join-room', (roomId) => {
    // Leave any existing room first
    const prev = [...socket.rooms].find(r => r !== socket.id);
    if (prev) leaveRoom(socket, prev);

    // Max 2 per room
    const count = rooms[roomId]?.size ?? 0;
    if (count >= 2) {
      socket.emit('room-full', roomId);
      return;
    }

    socket.join(roomId);
    rooms[roomId] = rooms[roomId] ?? new Set();
    rooms[roomId].add(socket.id);

    console.log(`  ${socket.id} → room "${roomId}" (${rooms[roomId].size}/2)`);

    // Tell the joiner how many were already here
    socket.emit('room-joined', { roomId, peerCount: count });

    // Tell the existing peer someone arrived
    socket.to(roomId).emit('user-connected', socket.id);
  });

  // ── Relay signaling ────────────────────────────────────────────────────────
  socket.on('offer',         ({ roomId, offer     }) => socket.to(roomId).emit('offer',         { offer,     from: socket.id }));
  socket.on('answer',        ({ roomId, answer    }) => socket.to(roomId).emit('answer',        { answer,    from: socket.id }));
  socket.on('ice-candidate', ({ roomId, candidate }) => socket.to(roomId).emit('ice-candidate', { candidate, from: socket.id }));

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      leaveRoom(socket, roomId);
      socket.to(roomId).emit('user-disconnected', socket.id);
      console.log(`  ${socket.id} left room "${roomId}"`);
    }
  });

  socket.on('disconnect', () => console.log(`[-] ${socket.id} disconnected`));
});

function leaveRoom(socket, roomId) {
  if (!rooms[roomId]) return;
  rooms[roomId].delete(socket.id);
  if (rooms[roomId].size === 0) delete rooms[roomId];
}

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀  PeerSpace signaling server → http://localhost:${PORT}\n`);
});
