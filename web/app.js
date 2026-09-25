// web/app.js
const API = '';
let token = localStorage.getItem('token');
let currentTab = 'movies';
let library = { movies: [], shows: [], music: [] };
let socket = null;

let mySocketId = null;
let currentRoom = null;
let currentRoomId = null;
let suppressPlayerEvents = false;

const $ = (id) => document.getElementById(id);

// ---- View switching ----
function show(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(screenId).classList.add('active');
}

// ---- Login ----
async function login() {
  const username = $('username').value.trim();
  const password = $('password').value;
  $('login-error').textContent = '';
  try {
    const r = await fetch(`${API}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      $('login-error').textContent = e.error || 'Login failed';
      return;
    }
    const data = await r.json();
    token = data.token;
    localStorage.setItem('token', token);
    await enterApp();
  } catch {
    $('login-error').textContent = 'Cannot reach server';
  }
}

function logout() {
  token = null;
  localStorage.removeItem('token');
  if (socket) { socket.disconnect(); socket = null; }
  show('login-view');
}

// ---- Library ----
async function loadLibrary() {
  const r = await fetch(`${API}/api/library`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (r.status === 401) { logout(); return; }
  library = await r.json();
}

function renderGrid() {
  const items = library[currentTab] || [];
  const grid = $('grid');
  if (!items.length) {
    grid.innerHTML = `<div class="empty">No ${currentTab} found.</div>`;
    return;
  }
  grid.innerHTML = items.map(item => `
    <div class="card" data-id="${item.id}">
      <div class="icon">${item.type === 'video' ? '🎬' : '🎵'}</div>
      <div class="name">${escapeHtml(item.name)}</div>
      <div class="meta">${formatSize(item.size)}</div>
    </div>
  `).join('');

  grid.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', () => onCardClick(card.dataset.id));
  });
}

// ---- Socket.IO ----
function connectSocket() {
  socket = io({ auth: { token } });

  socket.on('connect', () => {
    mySocketId = socket.id;
    socket.emit('sync:list');
  });

  socket.on('sync:rooms', renderRoomList);

  socket.on('sync:joined', (room) => {
    currentRoomId = room.id;
    currentRoom = room;
    renderRoomPanel();
    $('sync-badge').hidden = false;
  });

  socket.on('sync:members', (room) => {
    currentRoomId = room.id;
    currentRoom = room;
    renderRoomPanel();
    $('sync-badge').hidden = false;
  });

  socket.on('sync:left', () => {
    currentRoom = null;
    currentRoomId = null;
    renderRoomPanel();
    $('sync-badge').hidden = true;
  });

  socket.on('sync:loadMedia', async ({ mediaId }) => {
    if (!currentRoomId) return;
    await playItemById(mediaId, { fromSync: true });
  });

  socket.on('sync:play', ({ position }) => applyRemote('play', position));
  socket.on('sync:pause', ({ position }) => applyRemote('pause', position));
  socket.on('sync:seek', ({ position }) => applyRemote('seek', position));
  socket.on('sync:resume', ({ position }) => applyRemote('play', position));

  socket.on('sync:bufferUpdate', ({ waitingFor }) => {
    if (currentRoom) currentRoom.waitingFor = waitingFor;
    $('sync-waiting').hidden = !(waitingFor && waitingFor.length);
  });

  socket.on('sync:error', (msg) => alert('SyncPlay: ' + msg));
}

function applyRemote(action, position) {
  const v = getMediaEl();
  if (!v) return;
  suppressPlayerEvents = true;
  try {
    if (Math.abs(v.currentTime - position) > 0.5) v.currentTime = position;
    if (action === 'play') v.play().catch(() => {});
    if (action === 'pause') v.pause();
  } finally {
    setTimeout(() => { suppressPlayerEvents = false; }, 400);
  }
}

// ---- Playback ----
function getMediaEl() {
  return document.querySelector('#player-container video, #player-container audio');
}

function findItem(id) {
  return [...library.movies, ...library.shows, ...library.music].find(x => x.id === id);
}

async function onCardClick(id) {
  if (currentRoomId && currentRoom && currentRoom.hostSocketId === mySocketId) {
    const item = findItem(id);
    socket.emit('sync:setMedia', {
      roomId: currentRoomId, mediaId: id, mediaTitle: item ? item.name : ''
    });
    return;
  }
  if (currentRoomId && currentRoom.hostSocketId !== mySocketId) {
    alert('Only the host can change the movie in SyncPlay.');
    return;
  }
  await playItemById(id);
}

async function playItemById(id, opts = {}) {
  const item = findItem(id);
  if (!item) return;

  $('player-title').textContent = item.name;
  const container = $('player-container');
  const src = `${API}/api/stream-token/${id}?t=${encodeURIComponent(token)}`;

  container.innerHTML = '';
  await new Promise(r => setTimeout(r, 30));

  if (item.type === 'video') {
    container.innerHTML = `<video controls autoplay playsinline preload="metadata" src="${src}"></video>`;
  } else {
    container.innerHTML = `<audio controls autoplay preload="metadata" src="${src}"></audio>`;
  }
  show('player-view');

  setTimeout(() => {
    attachSyncListeners();
    if (opts.fromSync && currentRoom && currentRoom.mediaId === id) {
      const v = getMediaEl();
      if (v) {
        v.currentTime = currentRoom.position || 0;
        if (currentRoom.state === 'playing') v.play().catch(() => {});
      }
    }
  }, 400);
}

function attachSyncListeners() {
  const v = getMediaEl();
  if (!v) return;

  // Guard: only attach once per element
  if (v.dataset.syncAttached) return;
  v.dataset.syncAttached = '1';

  v.addEventListener('play', () => {
    if (suppressPlayerEvents || !currentRoomId) return;
    socket.emit('sync:play', { roomId: currentRoomId, position: v.currentTime });
  });

  v.addEventListener('pause', () => {
    if (suppressPlayerEvents || !currentRoomId) return;
    if (v.ended) return;
    socket.emit('sync:pause', { roomId: currentRoomId, position: v.currentTime });
  });

  v.addEventListener('seeked', () => {
    if (suppressPlayerEvents || !currentRoomId) return;
    socket.emit('sync:seek', { roomId: currentRoomId, position: v.currentTime });
  });

  v.addEventListener('waiting', () => {
    if (!currentRoomId) return;
    socket.emit('sync:buffer', { roomId: currentRoomId, buffering: true });
  });

  v.addEventListener('playing', () => {
    if (!currentRoomId) return;
    socket.emit('sync:buffer', { roomId: currentRoomId, buffering: false });
  });
}

function stopPlayback() {
  $('player-container').innerHTML = '';
  show('app-view');
}

// ---- SyncPlay UI ----
function renderRoomList(rooms) {
  const el = $('sync-room-list');
  if (!rooms || !rooms.length) {
    el.innerHTML = `<div class="room-empty">No active rooms.</div>`;
    return;
  }
  el.innerHTML = rooms.map(r => `
    <div class="room-item">
      <div>
        <b>${escapeHtml(r.id)}</b>
        <div class="meta">Host: ${escapeHtml(r.host)} · ${r.members} watching</div>
      </div>
      <button data-room="${r.id}">Join</button>
    </div>
  `).join('');

  el.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      socket.emit('sync:join', b.dataset.room);
      $('sync-panel').hidden = true;
    });
  });
}

function renderRoomPanel() {
  if (!currentRoom) {
    $('sync-not-in-room').hidden = false;
    $('sync-in-room').hidden = true;
    return;
  }
  $('sync-not-in-room').hidden = true;
  $('sync-in-room').hidden = false;

  $('sync-room-id').textContent = currentRoom.id;
  $('sync-host').textContent = currentRoom.host;

  const membersEl = $('sync-members');
  membersEl.innerHTML = currentRoom.members.map(m =>
    `<span class="member-chip ${m.socketId === currentRoom.hostSocketId ? 'host' : ''}">
      ${escapeHtml(m.username)}${m.socketId === currentRoom.hostSocketId ? ' 👑' : ''}
    </span>`
  ).join('');
}

// ---- App entry ----
async function enterApp() {
  try {
    await loadLibrary();
    renderGrid();
    show('app-view');
    connectSocket();
  } catch {
    logout();
  }
}

// ---- Utils ----
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes/1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes/1048576).toFixed(1) + ' MB';
  return (bytes/1073741824).toFixed(2) + ' GB';
}

// ---- Events ----
$('login-btn').addEventListener('click', login);
$('password').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
$('logout-btn').addEventListener('click', logout);
$('back-btn').addEventListener('click', stopPlayback);

$('sync-btn').addEventListener('click', () => {
  $('sync-panel').hidden = false;
  if (socket) socket.emit('sync:list');
});
$('sync-close').addEventListener('click', () => { $('sync-panel').hidden = true; });
$('sync-create').addEventListener('click', () => {
  if (socket) socket.emit('sync:create');
  $('sync-panel').hidden = true;
});
$('sync-leave').addEventListener('click', () => {
  if (socket) socket.emit('sync:leave');
  $('sync-panel').hidden = true;
});

document.querySelectorAll('#tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTab = btn.dataset.tab;
    $('lib-title').textContent = currentTab.charAt(0).toUpperCase() + currentTab.slice(1);
    renderGrid();
  });
});

if (token) {
  enterApp();
} else {
  show('login-view');
}
