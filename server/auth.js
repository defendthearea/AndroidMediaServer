const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-' + Date.now();

// In-memory user store. For persistence, swap with a JSON file.
const users = new Map();

// Create a default admin on first boot
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';

users.set(ADMIN_USER, {
  username: ADMIN_USER,
  passwordHash: bcrypt.hashSync(ADMIN_PASS, 10),
  isAdmin: true
});

function createToken(user) {
  return jwt.sign(
    { username: user.username, isAdmin: user.isAdmin },
    SECRET,
    { expiresIn: '30d' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

function authenticate(username, password) {
  const user = users.get(username);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.passwordHash)) return null;
  return user;
}

function addUser(username, password, isAdmin = false) {
  if (users.has(username)) return false;
  users.set(username, {
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    isAdmin
  });
  return true;
}

function middleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  req.user = payload;
  next();
}

module.exports = {
  createToken,
  verifyToken,
  authenticate,
  addUser,
  middleware,
  users
};
