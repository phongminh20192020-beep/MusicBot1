"use strict";

const crypto = require("crypto");

const COOKIE_NAME    = "mb_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// In-memory session store: token -> expiry timestamp.
// Single-instance dashboards only (fine for a bot process) — sessions reset on restart.
const sessions = new Map();

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isValid(token) {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

// Periodically sweep expired sessions so the Map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions) {
    if (now > expiry) sessions.delete(token);
  }
}, 1000 * 60 * 30).unref();

/** Express middleware: rejects with 401 JSON if no valid session cookie. */
function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const token   = cookies[COOKIE_NAME];
  if (!isValid(token)) return res.status(401).json({ error: "Not authenticated" });
  req.sessionToken = token;
  next();
}

/** Validate a session token pulled from a raw cookie header (used for Socket.IO handshakes). */
function isValidFromHeader(cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  return isValid(cookies[COOKIE_NAME]);
}

module.exports = {
  COOKIE_NAME,
  parseCookies,
  createSession,
  isValid,
  destroySession,
  requireAuth,
  isValidFromHeader,
};
