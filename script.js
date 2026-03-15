'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PeerSpace — script.js
   Signaling server: https://vidcall-lh27.onrender.com
   Supports 3 media modes: camera | screen | no-cam (call works regardless)
   ═══════════════════════════════════════════════════════════════════════════ */

const SIGNAL_SERVER = 'https://vidcall-lh27.onrender.com';

/* ── DOM ──────────────────────────────────────────────────────────────────── */
const roomIdInput       = document.getElementById('roomIdInput');
const createBtn         = document.getElementById('createBtn');
const joinBtn           = document.getElementById('joinBtn');
const copyBtn           = document.getElementById('copyBtn');
const statusDot         = document.getElementById('statusDot');
const statusText        = document.getElementById('statusText');
const localVideo        = document.getElementById('localVideo');
const remoteVideo       = document.getElementById('remoteVideo');
const localPlaceholder  = document.getElementById('localPlaceholder');
const remotePlaceholder = document.getElementById('remotePlaceholder');
const connectionBadge   = document.getElementById('connectionBadge');
const callControls      = document.getElementById('callControls');
const muteBtn           = document.getElementById('muteBtn');
const videoBtn          = document.getElementById('videoBtn');
const hangupBtn         = document.getElementById('hangupBtn');
const modeBtns          = document.querySelectorAll('.mode-btn');
const toast             = document.getElementById('toast');

/* ── WebRTC config ────────────────────────────────────────────────────────── */
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ]
};

/* ── State ────────────────────────────────────────────────────────────────── */
let socket        = null;
let peerConn      = null;
let localStream   = null;
let currentRoomId = null;
let mediaMode     = 'camera';   // 'camera' | 'screen' | 'none'
let isMuted       = false;
let isVideoOff    = false;

/* ═══════════════════════════════════════════════════════════════════════════
   UI HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

function setStatus(text, state = 'idle') {
  statusText.textContent = text;
  statusDot.className = `status-dot ${state}`;
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), 3000);
}

function activateVideo(videoEl, placeholder) {
  videoEl.classList.add('active');
  placeholder.classList.add('hidden');
}

function deactivateVideo(videoEl, placeholder) {
  videoEl.classList.remove('active');
  videoEl.srcObject = null;
  placeholder.classList.remove('hidden');
}

function generateRoomId() {
  const adj  = ['lunar','neon','cobalt','amber','onyx','cipher','void','stark'];
  const noun = ['fox','hawk','wolf','lynx','raven','pulse','node','ghost'];
  return `${adj[Math.random() * adj.length | 0]}-${noun[Math.random() * noun.length | 0]}-${Math.floor(Math.random() * 90) + 10}`;
}

function setBadge(online) {
  connectionBadge.textContent = online ? '● Online' : '● Offline';
  connectionBadge.classList.toggle('online', online);
}

function disableButtons() { createBtn.disabled = true;  joinBtn.disabled = true;  }
function enableButtons()  { createBtn.disabled = false; joinBtn.disabled = false; }

/* ═══════════════════════════════════════════════════════════════════════════
   MEDIA MODE SELECTOR
   ═══════════════════════════════════════════════════════════════════════════ */

modeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    modeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    mediaMode = btn.dataset.mode;
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   MEDIA — get local stream based on selected mode
   The call ALWAYS proceeds even if media fails — we return an empty
   MediaStream() as fallback so WebRTC still connects.
   ═══════════════════════════════════════════════════════════════════════════ */

async function getLocalMedia() {

  // ── No Cam mode ────────────────────────────────────────────────────────────
  if (mediaMode === 'none') {
    showToast('📵 Joining without camera');
    setStatus('No media — joining anyway', 'waiting');
    return new MediaStream();
  }

  // ── Screen share mode ──────────────────────────────────────────────────────
  if (mediaMode === 'screen') {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      localVideo.srcObject = stream;
      activateVideo(localVideo, localPlaceholder);
      showToast('🖥️ Screen share active');
      stream.getVideoTracks()[0].onended = () => {
        deactivateVideo(localVideo, localPlaceholder);
        showToast('Screen share stopped');
      };
      return stream;
    } catch (err) {
      // User cancelled or denied — still join the call
      showToast('Screen share cancelled — joining without video');
      return new MediaStream();
    }
  }

  // ── Camera mode (default) ──────────────────────────────────────────────────
  // Attempt 1: real camera + mic
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = stream;
    activateVideo(localVideo, localPlaceholder);
    showToast('📷 Camera ready');
    return stream;
  } catch (camErr) {
    console.warn('[media] camera error:', camErr.name);

    // Denied by user → join silently, no blocking
    if (camErr.name === 'NotAllowedError') {
      showToast('Camera denied — joining without video');
      setStatus('No camera access — joining anyway', 'waiting');
      return new MediaStream();
    }

    // Camera busy (another tab) → try screen share as fallback
    if (['NotReadableError', 'AbortError', 'TrackStartError'].includes(camErr.name)) {
      showToast('Camera busy — trying screen share…');
      try {
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        localVideo.srcObject = screen;
        activateVideo(localVideo, localPlaceholder);
        showToast('🖥️ Using screen share instead');
        return screen;
      } catch {
        showToast('Screen cancelled — joining without video');
        return new MediaStream();
      }
    }

    // Any other error → still join the call
    showToast(`Media error — joining without video`);
    return new MediaStream();
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SOCKET.IO — connect to Render signaling server
   ═══════════════════════════════════════════════════════════════════════════ */

function connectSocket() {
  if (socket && socket.connected) return;

  setStatus('Connecting to server…', 'waiting');

  socket = io(SIGNAL_SERVER, {
    transports: ['websocket', 'polling'],   // try WS first, fall back to polling
    reconnectionAttempts: 5,
  });

  socket.on('connect', () => {
    console.log('[socket] connected', socket.id);
    setBadge(true);
    setStatus('Connected to server', 'idle');
  });

  socket.on('connect_error', (err) => {
    console.error('[socket] connect error', err.message);
    setStatus('Server unreachable — is Render awake?', 'error');
    showToast('⚠️ Cannot reach server — it may be waking up, try again in 30s');
    enableButtons();
  });

  socket.on('disconnect', () => {
    setBadge(false);
    setStatus('Disconnected', 'error');
  });

  // ── Signaling events ───────────────────────────────────────────────────────

  // First user gets this when second joins → creates offer
  socket.on('user-connected', async (peerId) => {
    console.log('[signal] peer joined:', peerId);
    setStatus('Peer joined — connecting…', 'waiting');
    await createPeerConnection();
    await sendOffer();
  });

  // Second user receives offer → answers
  socket.on('offer', async ({ offer }) => {
    console.log('[signal] received offer');
    await createPeerConnection();
    await peerConn.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConn.createAnswer();
    await peerConn.setLocalDescription(answer);
    socket.emit('answer', { roomId: currentRoomId, answer });
    setStatus('Answering call…', 'waiting');
  });

  // First user receives answer
  socket.on('answer', async ({ answer }) => {
    console.log('[signal] received answer');
    await peerConn.setRemoteDescription(new RTCSessionDescription(answer));
  });

  // Both sides exchange ICE candidates
  socket.on('ice-candidate', async ({ candidate }) => {
    if (!peerConn || !candidate) return;
    try { await peerConn.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { console.warn('[ICE] failed to add:', e); }
  });

  // Peer left
  socket.on('user-disconnected', () => {
    showToast('Peer left the call');
    setStatus('Peer disconnected', 'idle');
    deactivateVideo(remoteVideo, remotePlaceholder);
    closePeerConnection();
    callControls.style.display = 'none';
    enableButtons();
  });

  // Room is full
  socket.on('room-full', (id) => {
    setStatus(`Room "${id}" is full (max 2)`, 'error');
    showToast('Room is full!');
    enableButtons();
  });
}

function joinRoom(roomId) {
  currentRoomId = roomId;
  socket.emit('join-room', roomId);

  socket.once('room-joined', ({ peerCount }) => {
    if (peerCount === 0) {
      roomIdInput.value = roomId;
      copyBtn.style.display = 'flex';
      setStatus('Waiting for peer — share the Room ID', 'waiting');
      showToast(`Room: ${roomId}`);
    } else {
      setStatus('Joining — establishing P2P connection…', 'waiting');
    }
    callControls.style.display = 'flex';
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   WEBRTC PEER CONNECTION
   ═══════════════════════════════════════════════════════════════════════════ */

async function createPeerConnection() {
  closePeerConnection();

  peerConn = new RTCPeerConnection(RTC_CONFIG);

  // Add tracks (empty stream is fine — WebRTC handles it gracefully)
  if (localStream) {
    localStream.getTracks().forEach(track => peerConn.addTrack(track, localStream));
  }

  peerConn.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', { roomId: currentRoomId, candidate });
  };

  peerConn.oniceconnectionstatechange = () => {
    const s = peerConn.iceConnectionState;
    console.log('[ICE]', s);
    if (s === 'checking')                      setStatus('Checking connection…', 'waiting');
    if (s === 'connected' || s === 'completed') setStatus('Connected ✓  Live', 'active');
    if (s === 'disconnected')                  setStatus('Peer disconnected', 'idle');
    if (s === 'failed')                        setStatus('Connection failed — try again', 'error');
  };

  // Remote stream arrives
  peerConn.ontrack = ({ streams }) => {
    console.log('[RTC] remote track received');
    if (streams?.[0]) {
      remoteVideo.srcObject = streams[0];
      activateVideo(remoteVideo, remotePlaceholder);
      setStatus('Live 🟢', 'active');
    }
  };
}

async function sendOffer() {
  const offer = await peerConn.createOffer();
  await peerConn.setLocalDescription(offer);
  socket.emit('offer', { roomId: currentRoomId, offer });
  console.log('[RTC] offer sent');
}

function closePeerConnection() {
  if (peerConn) { peerConn.close(); peerConn = null; }
}

/* ═══════════════════════════════════════════════════════════════════════════
   IN-CALL CONTROLS
   ═══════════════════════════════════════════════════════════════════════════ */

muteBtn.addEventListener('click', () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  muteBtn.classList.toggle('active', isMuted);
  muteBtn.querySelector('span').textContent = isMuted ? 'Unmute' : 'Mute';
  showToast(isMuted ? '🔇 Muted' : '🔊 Unmuted');
});

videoBtn.addEventListener('click', () => {
  if (!localStream) return;
  isVideoOff = !isVideoOff;
  localStream.getVideoTracks().forEach(t => { t.enabled = !isVideoOff; });
  videoBtn.classList.toggle('active', isVideoOff);
  videoBtn.querySelector('span').textContent = isVideoOff ? 'Show Cam' : 'Video';
  showToast(isVideoOff ? '📷 Video off' : '📷 Video on');
});

hangupBtn.addEventListener('click', () => {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  deactivateVideo(localVideo,  localPlaceholder);
  deactivateVideo(remoteVideo, remotePlaceholder);
  closePeerConnection();
  if (socket) { socket.disconnect(); socket = null; }
  localStream   = null;
  currentRoomId = null;
  isMuted       = false;
  isVideoOff    = false;
  callControls.style.display = 'none';
  copyBtn.style.display = 'none';
  roomIdInput.value = '';
  setBadge(false);
  setStatus('Call ended', 'idle');
  enableButtons();
  showToast('Call ended');
});

/* ═══════════════════════════════════════════════════════════════════════════
   BUTTON HANDLERS — Create & Join
   ═══════════════════════════════════════════════════════════════════════════ */

createBtn.addEventListener('click', async () => {
  disableButtons();
  setStatus('Setting up media…', 'waiting');

  localStream = await getLocalMedia();   // never throws — always returns a stream

  const roomId = roomIdInput.value.trim() || generateRoomId();
  roomIdInput.value = roomId;
  copyBtn.style.display = 'flex';

  connectSocket();
  // Wait for socket to connect before joining the room
  if (socket.connected) {
    joinRoom(roomId);
  } else {
    socket.once('connect', () => joinRoom(roomId));
  }
});

joinBtn.addEventListener('click', async () => {
  const roomId = roomIdInput.value.trim();
  if (!roomId) { showToast('Enter a Room ID first'); roomIdInput.focus(); return; }

  disableButtons();
  setStatus('Setting up media…', 'waiting');

  localStream = await getLocalMedia();   // never throws

  connectSocket();
  if (socket.connected) {
    joinRoom(roomId);
  } else {
    socket.once('connect', () => joinRoom(roomId));
  }
});

/* ── Copy room ID ─────────────────────────────────────────────────────────── */
copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(roomIdInput.value.trim());
    showToast('Room ID copied!');
  } catch {
    showToast('Copy failed — select manually');
  }
});

/* ── Enter key to join ────────────────────────────────────────────────────── */
roomIdInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click(); });

/* ── Cleanup on tab close ─────────────────────────────────────────────────── */
window.addEventListener('beforeunload', () => {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (socket)      socket.disconnect();
  closePeerConnection();
});
