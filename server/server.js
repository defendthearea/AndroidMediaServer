const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const auth = require('./auth');
const lib = require('./library');
const sync = require('./syncplay');

const PORT = process.env.PORT || 8096;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(express.json());

// ---- Auth ----
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = auth.authenticate(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: auth.createToken(user), username: user.username });
});

app.post('/api/register', auth.middleware, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { username, password, isAdmin } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });
  const ok = auth.addUser(username, password, !!isAdmin);
  if (!ok) return res.status(409).json({ error: 'User exists' });
  res.json({ ok: true });
});

// ---- Library ----
app.get('/api/library', auth.middleware, (req, res) => {
  res.json(lib.getLibrary());
});

// ---- Streaming (Range support) ----
function streamFile(req, res, filePath) {
  if (!filePath || !fs.existsSync(filePath))
    return res.status(404).json({ error: 'Not found' });

  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  const mime = mimeFor(filePath);

  if (!range) {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': mime,
      'Accept-Ranges': 'bytes'
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
  const start = parseInt(startStr, 10);
  const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
  const chunkSize = end - start + 1;

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Type': mime
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

app.get('/api/stream/:id', auth.middleware, (req, res) => {
  streamFile(req, res, lib.resolveById(req.params.id));
});

app.get('/api/stream-token/:id', (req, res) => {
  const payload = auth.verifyToken(req.query.t);
  if (!payload) return res.status(401).send('Unauthorized');
  streamFile(req, res, lib.resolveById(req.params.id));
});

// ---- Static web ----
app.use(express.static(path.join(__dirname, '..', 'web')));

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.m4v': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/opus',
    '.wav': 'audio/wav'
  }[ext] || 'application/octet-stream';
}

// ---- HTTP + Socket.IO ----
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const payload = token && auth.verifyToken(token);
  if (!payload) return next(new Error('Unauthorized'));
  socket.username = payload.username;
  next();
});

io.on('connection', (socket) => {
  console.log(`[socket] ${socket.username} (${socket.id}) connected`);

  socket.on('sync:create', () => {
    const room = sync.createRoom(socket.username, socket.id);
    sync.joinRoom(room.id, socket.id, socket.username);
    socket.join('room:' + room.id);
    socket.emit('sync:joined', sync.roomSnapshot(room));
    io.emit('sync:rooms', sync.listRooms());
  });

  socket.on('sync:join', (roomId) => {
    const room = sync.joinRoom(roomId, socket.id, socket.username);
    if (!room) return socket.emit('sync:error', 'Room not found');
    socket.join('room:' + room.id);
    io.to('room:' + room.id).emit('sync:members', sync.roomSnapshot(room));
    io.emit('sync:rooms', sync.listRooms());
  });

  socket.on('sync:leave', () => {
    const result = sync.leaveRoom(socket.id);
    if (!result) return;
    const { room, destroyed } = result;
    socket.leave('room:' + room.id);
    if (!destroyed) {
      io.to('room:' + room.id).emit('sync:members', sync.roomSnapshot(room));
    }
    socket.emit('sync:left');
    io.emit('sync:rooms', sync.listRooms());
  });

  socket.on('sync:setMedia', ({ roomId, mediaId, mediaTitle }) => {
    const room = sync.getRoom(roomId);
    if (!room) return;
    if (room.hostSocketId !== socket.id) return;
    sync.setMedia(roomId, mediaId, mediaTitle);
    // Broadcast media change to everyone including host
    io.to('room:' + roomId).emit('sync:loadMedia', { mediaId, mediaTitle });
  });

  // NOTE: use socket.to (not io.to) for playback events so sender isn't echoed back
  socket.on('sync:play', ({ roomId, position }) => {
    const room = sync.getRoom(roomId);
    if (!room) return;
    sync.updatePlayback(roomId, { state: 'playing', position });
    socket.to('room:' + roomId).emit('sync:play', { position, at: Date.now() });
  });

  socket.on('sync:pause', ({ roomId, position }) => {
    const room = sync.getRoom(roomId);
    if (!room) return;
    sync.updatePlayback(roomId, { state: 'paused', position });
    socket.to('room:' + roomId).emit('sync:pause', { position, at: Date.now() });
  });

  socket.on('sync:seek', ({ roomId, position }) => {
    const room = sync.getRoom(roomId);
    if (!room) return;
    sync.updatePlayback(roomId, { position });
    socket.to('room:' + roomId).emit('sync:seek', { position, at: Date.now() });
  });

  socket.on('sync:buffer', ({ roomId, buffering }) => {
    const room = sync.getRoom(roomId);
    if (!room) return;
    sync.setBuffering(roomId, socket.id, buffering);
    // Only notify the others, not the sender
    socket.to('room:' + roomId).emit('sync:bufferUpdate', {
      socketId: socket.id,
      buffering,
      waitingFor: Array.from(room.waitingFor)
    });
    if (!buffering && room.waitingFor.size === 0 && room.state === 'playing') {
      io.to('room:' + roomId).emit('sync:resume', { position: room.position });
    }
  });

  socket.on('sync:list', () => {
    socket.emit('sync:rooms', sync.listRooms());
  });

  socket.on('disconnect', () => {
    const result = sync.leaveRoom(socket.id);
    if (result && !result.destroyed) {
      io.to('room:' + result.room.id).emit('sync:members', sync.roomSnapshot(result.room));
      io.emit('sync:rooms', sync.listRooms());
    }
    console.log(`[socket] ${socket.username} disconnected`);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`🎬 Media server running on http://${HOST}:${PORT}`);
});
