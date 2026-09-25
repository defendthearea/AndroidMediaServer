// server/syncplay.js
// SyncPlay: room-based synchronized playback

const rooms = new Map(); // roomId -> room object

function makeRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function createRoom(hostUsername, socketId) {
  const id = makeRoomId();
  const room = {
    id,
    host: hostUsername,
    hostSocketId: socketId,
    members: new Map(), // socketId -> { username, ready }
    mediaId: null,
    mediaTitle: null,
    state: 'paused',      // 'playing' | 'paused'
    position: 0,          // seconds
    updatedAt: Date.now(),
    waitingFor: new Set() // socketIds currently buffering
  };
  rooms.set(id, room);
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function joinRoom(roomId, socketId, username) {
  const room = rooms.get(roomId);
  if (!room) return null;
  room.members.set(socketId, { username, ready: false });
  return room;
}

function leaveRoom(socketId) {
  for (const room of rooms.values()) {
    if (room.members.has(socketId)) {
      room.members.delete(socketId);
      room.waitingFor.delete(socketId);
      if (room.hostSocketId === socketId) {
        // Host left -> promote next member or destroy room
        const next = room.members.keys().next();
        if (next.done) {
          rooms.delete(room.id);
          return { room, destroyed: true };
        } else {
          const newHostId = next.value;
          room.hostSocketId = newHostId;
          room.host = room.members.get(newHostId).username;
          return { room, destroyed: false };
        }
      }
      if (room.members.size === 0) {
        rooms.delete(room.id);
        return { room, destroyed: true };
      }
      return { room, destroyed: false };
    }
  }
  return null;
}

function setMedia(roomId, mediaId, mediaTitle) {
  const room = rooms.get(roomId);
  if (!room) return null;
  room.mediaId = mediaId;
  room.mediaTitle = mediaTitle;
  room.state = 'paused';
  room.position = 0;
  room.updatedAt = Date.now();
  return room;
}

function updatePlayback(roomId, patch) {
  const room = rooms.get(roomId);
  if (!room) return null;
  if (patch.state !== undefined) room.state = patch.state;
  if (patch.position !== undefined) room.position = patch.position;
  room.updatedAt = Date.now();
  return room;
}

function setBuffering(roomId, socketId, buffering) {
  const room = rooms.get(roomId);
  if (!room) return null;
  if (buffering) room.waitingFor.add(socketId);
  else room.waitingFor.delete(socketId);
  return room;
}

function roomSnapshot(room) {
  return {
    id: room.id,
    host: room.host,
    hostSocketId: room.hostSocketId,
    mediaId: room.mediaId,
    mediaTitle: room.mediaTitle,
    state: room.state,
    position: room.position,
    updatedAt: room.updatedAt,
    waitingFor: Array.from(room.waitingFor),
    members: Array.from(room.members.entries()).map(([sid, m]) => ({
      socketId: sid,
      username: m.username
    }))
  };
}

function listRooms() {
  return Array.from(rooms.values()).map(r => ({
    id: r.id,
    host: r.host,
    mediaTitle: r.mediaTitle,
    members: r.members.size
  }));
}

module.exports = {
  rooms,
  createRoom,
  getRoom,
  joinRoom,
  leaveRoom,
  setMedia,
  updatePlayback,
  setBuffering,
  roomSnapshot,
  listRooms
};
