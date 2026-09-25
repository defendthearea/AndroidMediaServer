const fs = require('fs');
const path = require('path');

const MEDIA_ROOT = path.join(__dirname, '..', 'media');
const VIDEO_EXT = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v'];
const AUDIO_EXT = ['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.opus'];

function scanDir(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...scanDir(full, exts));
    } else if (exts.includes(path.extname(entry.name).toLowerCase())) {
      const stat = fs.statSync(full);
      out.push({
        id: Buffer.from(path.relative(MEDIA_ROOT, full)).toString('base64url'),
        name: path.basename(entry.name, path.extname(entry.name)),
        relPath: path.relative(MEDIA_ROOT, full),
        size: stat.size,
        modified: stat.mtime.toISOString(),
        type: exts === VIDEO_EXT ? 'video' : 'audio'
      });
    }
  }
  return out;
}

function getLibrary() {
  const movies = scanDir(path.join(MEDIA_ROOT, 'movies'), VIDEO_EXT);
  const shows  = scanDir(path.join(MEDIA_ROOT, 'shows'),  VIDEO_EXT);
  const music  = scanDir(path.join(MEDIA_ROOT, 'music'),  AUDIO_EXT);
  return { movies, shows, music };
}

function findById(id) {
  const all = Object.values(getLibrary()).flat();
  return all.find(x => x.id === id);
}

function resolveById(id) {
  const item = findById(id);
  if (!item) return null;
  return path.join(MEDIA_ROOT, item.relPath);
}

module.exports = { getLibrary, findById, resolveById, MEDIA_ROOT };
