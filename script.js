'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PeerSpace — script.js
   Signaling server: deployed on Render, connected via Socket.IO.
   Supports three media modes: camera, screen share, or no video (audio only
   or completely silent — so the call works even if media is refused).
   ═══════════════════════════════════════════════════════════════════════════ */

// ── IMPORTANT: Replace this with your Render backend URL once deployed ──────
// While testing locally, keep it as empty string — io() auto-connects to localhost
const SIGNAL_SERVER = '';   // e.g. 'https://your-app.onrender.com'

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
let localStream   = null;   // null when mode === 'none'
let currentRoomId = null;
let mediaMode     = 'camera';  // 'camera' | 'screen' | 'none'
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
  return `${adj[Math.random()*adj.length|0]}-${noun[Math.random()*noun.length|0]}-${Math.floor(Math.random()*90)+10}`;
}

function setBadge(online) {
  connectionBadge.textContent = online ? '● Online' : '● Offline';
  connectionBadge.classList.toggle('online', online);
}

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
   ═══════════════════════════════════════════════════════════════════════════ */

async function getLocalMedia() {
  // ── Mode: No Camera — skip media entirely ─────────────────────────────────
  if (mediaMode === 'none') {
    setStatus('Joining without camera/mic', 'waiting');
    showToast('📵 Joining without media');
    // Return a silent empty MediaStream so WebRTC still works
    return new MediaStream();
  }

  // ── Mode: Screen share ────────────────────────────────────────────────────
  if (mediaMode === 'screen') {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      localVideo.srcObject = stream;
      activateVideo(localVideo, localPlaceholder);
      showToast('🖥️ Screen share active');
      // If the user stops sharing via the browser's built-in button
      stream.getVideoTracks()[0].onended = () => {
        showToast('Screen share ended');
        deactivateVideo(localVideo, localPlaceholder);
      };
      return stream;
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        showToast('Screen share cancelled — joining without video');
        return new MediaStream();
      }
      throw err;
    }
  }

  // ── Mode: Camera (default) ────────────────────────────────────────────────
  // Try camera first; if it's busy fall back to screen share; if denied join without media.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = stream;
    activateVideo(localVideo, localPlaceholder);
    showToast('📷 Camera ready');
    return stream;
  } catch (camErr) {
    console.warn('[media] Camera failed:', camErr.name, camErr.message);

    if (camErr.name === 'NotAllowedError') {
      // User denied — join without any media
      showToast('Camera denied — joining without video');
      setStatus('No camera — audio only or silent', 'waiting');
      return new MediaStream();
    }

    if (['NotReadableError', 'AbortError', 'TrackStartError'].includes(camErr.name)) {
      // Camera busy (other tab) — try screen share
      showToast('Camera busy — trying screen share…');
      setStatus('Camera busy — requesting screen…', 'waiting');
      try {
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        localVideo.srcObject = screen;
        activateVideo(localVideo, localPlaceholder);
        showToast('🖥️ Using screen share instead');
        return screen;
      } catch {
        showToast('Screen share cancelled — joining without video');
        return new MediaStream();
      }
    }

    // Unknown error — join without media anyway so the call still works
    showToast(`Media error (${camErr.name}) — joining without video`);
    return new MediaStream();
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SOCKET.IO — signaling
   ═══════════════════════════════════════════════════════════════════════════ */

function connectSocket() {
  if (socket && socket.connected) return;

  // Connect to the signaling server
  socket = SIGNAL_SERVER ? io(SIGNAL_SERVER) : io();

  socket.on('connect', () => {
    console.log('[socket] connected', socket.id);
    setBadge(true);
  });

  socket.on('disconnect', () => {
    console.log('[socket] disconnected');
    setBadge(false);
    setStatus('Disconnected from server', 'error');
  });

  // First user receives this when second joins → creates & sends offer
  socket.on('user-connected', async (peerId) => {
    console.log('[signal] user-connected', peerId);
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
    setStatus('Answering…', 'waiting');
  });

  // First user receives answer
  socket.on('answer', async ({ answer }) => {
    console.log('[signal] received answer');
    await peerConn.setRemoteDescription(new RTCSessionDescription(answer));
  });

  // ICE candidates
  socket.on('ice-candidate', async ({ candidate }) => {
    if (!peerConn || !candidate) return;
    try { await peerConn.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { console.warn('[ICE] add failed', e); }
  });

  // Remote peer left
  socket.on('user-disconnected', () => {
    showToast('Peer left the call');
    setStatus('Peer disconnected', 'idle');
    deactivateVideo(remoteVideo, remotePlaceholder);
    closePeerConnection();
    callControls.style.display = 'none';
  });

  // Room full
  socket.on('room-full', (id) => {
    setStatus(`Room "${id}" is full`, 'error');
    showToast('Room is full (max 2 people)');
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
      showToast(`Room ready: ${roomId}`);
    } else {
      setStatus('Joining room — establishing connection…', 'waiting');
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

  // Add tracks (even if stream is empty — WebRTC handles it gracefully)
  if (localStream) {
    localStream.getTracks().forEach(track => peerConn.addTrack(track, localStream));
  }

  peerConn.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', { roomId: currentRoomId, candidate });
  };

  peerConn.oniceconnectionstatechange = () => {
    const s = peerConn.iceConnectionState;
    console.log('[ICE]', s);
    if (s === 'checking')                 setStatus('Checking…', 'waiting');
    if (s === 'connected' || s === 'completed') setStatus('Connected ✓', 'active');
    if (s === 'disconnected')             setStatus('Peer disconnected', 'idle');
    if (s === 'failed')                   setStatus('Connection failed — try again', 'error');
  };

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
  // Stop all tracks
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  deactivateVideo(localVideo, localPlaceholder);
  deactivateVideo(remoteVideo, remotePlaceholder);
  closePeerConnection();
  if (socket) socket.disconnect();
  socket = null;
  localStream = null;
  currentRoomId = null;
  callControls.style.display = 'none';
  copyBtn.style.display = 'none';
  roomIdInput.value = '';
  setBadge(false);
  setStatus('Call ended', 'idle');
  enableButtons();
  showToast('Call ended');
});

/* ═══════════════════════════════════════════════════════════════════════════
   BUTTON HANDLERS
   ═══════════════════════════════════════════════════════════════════════════ */

function disableButtons() {
  createBtn.disabled = true;
  joinBtn.disabled   = true;
}
function enableButtons() {
  createBtn.disabled = false;
  joinBtn.disabled   = false;
}

createBtn.addEventListener('click', async () => {
  disableButtons();
  setStatus('Setting up media…', 'waiting');

  try {
    localStream = await getLocalMedia();
  } catch (err) {
    console.error(err);
    setStatus('Media setup failed', 'error');
    enableButtons();
    return;
  }

  const roomId = roomIdInput.value.trim() || generateRoomId();
  roomIdInput.value = roomId;
  copyBtn.style.display = 'flex';

  connectSocket();
  joinRoom(roomId);
});

joinBtn.addEventListener('click', async () => {
  const roomId = roomIdInput.value.trim();
  if (!roomId) { showToast('Enter a Room ID first'); roomIdInput.focus(); return; }

  disableButtons();
  setStatus('Setting up media…', 'waiting');

  try {
    localStream = await getLocalMedia();
  } catch (err) {
    console.error(err);
    setStatus('Media setup failed', 'error');
    enableButtons();
    return;
  }

  connectSocket();
  joinRoom(roomId);
});

/* ── Copy ────────────────────────────────────────────────────────────────── */
copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(roomIdInput.value.trim());
    showToast('Room ID copied!');
  } catch {
    showToast('Copy failed — select manually');
  }
});

/* ── Enter key ───────────────────────────────────────────────────────────── */
roomIdInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click(); });

/* ── Cleanup on close ────────────────────────────────────────────────────── */
window.addEventListener('beforeunload', () => {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (socket) socket.disconnect();
  closePeerConnection();
});