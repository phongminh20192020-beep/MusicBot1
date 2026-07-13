"use strict";

const path    = require("path");
const http    = require("http");
const express = require("express");
const { Server } = require("socket.io");

const { COOKIE_NAME, createSession, destroySession, requireAuth, isValidFromHeader, parseCookies, isValid } = require("./auth");
const { statsToJSON, playerToJSON } = require("./state");

const VALID_LOOP_MODES = new Set(["off", "track", "queue"]);

function getPlayerOr404(client, res, guildId) {
  const player = client.lavalink.getPlayer(guildId);
  if (!player) {
    res.status(404).json({ error: "No active player for that server." });
    return null;
  }
  return player;
}

function startDashboard(client) {
  const app    = express();
  const server = http.createServer(app);
  const io     = new Server(server, { cors: { origin: false } });

  const PASSWORD = process.env.DASHBOARD_PASSWORD;
  if (!PASSWORD) {
    console.warn(
      "[Dashboard] DASHBOARD_PASSWORD is not set — the dashboard will refuse all logins. " +
      "Set DASHBOARD_PASSWORD in your environment to enable it."
    );
  }

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  // ─── Auth ─────────────────────────────────────────────────────────────────
  app.get("/api/me", (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    res.json({ authenticated: isValid(token) });
  });

  app.post("/api/login", (req, res) => {
    const { password } = req.body || {};
    if (!PASSWORD) return res.status(503).json({ error: "Dashboard password not configured on the server." });
    if (typeof password !== "string" || password !== PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    const token = createSession();
    res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 24 * 7, path: "/" });
    res.json({ ok: true });
  });

  app.post("/api/logout", requireAuth, (req, res) => {
    destroySession(req.sessionToken);
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`);
    res.json({ ok: true });
  });

  // ─── Read-only state ──────────────────────────────────────────────────────
  app.get("/api/stats", requireAuth, (req, res) => {
    res.json(statsToJSON(client));
  });

  app.get("/api/players", requireAuth, (req, res) => {
    const players = [...client.lavalink.players.values()].map(p => playerToJSON(client, p));
    res.json(players);
  });

  // ─── Controls (all wrap existing Player methods — no new bot behavior) ────
  app.post("/api/players/:guildId/pause", requireAuth, async (req, res) => {
    const player = getPlayerOr404(client, res, req.params.guildId);
    if (!player) return;
    await player.pause();
    res.json({ ok: true });
  });

  app.post("/api/players/:guildId/resume", requireAuth, async (req, res) => {
    const player = getPlayerOr404(client, res, req.params.guildId);
    if (!player) return;
    await player.resume();
    res.json({ ok: true });
  });

  app.post("/api/players/:guildId/skip", requireAuth, async (req, res) => {
    const player = getPlayerOr404(client, res, req.params.guildId);
    if (!player) return;
    await player.skip();
    res.json({ ok: true });
  });

  app.post("/api/players/:guildId/stop", requireAuth, async (req, res) => {
    const player = getPlayerOr404(client, res, req.params.guildId);
    if (!player) return;
    await player.stopPlaying(true);
    res.json({ ok: true });
  });

  app.post("/api/players/:guildId/disconnect", requireAuth, async (req, res) => {
    const player = getPlayerOr404(client, res, req.params.guildId);
    if (!player) return;
    await player.destroy();
    res.json({ ok: true });
  });

  app.post("/api/players/:guildId/volume", requireAuth, async (req, res) => {
    const player = getPlayerOr404(client, res, req.params.guildId);
    if (!player) return;
    const level = Number(req.body?.level);
    if (!Number.isFinite(level) || level < 0 || level > 100) {
      return res.status(400).json({ error: "level must be a number between 0 and 100." });
    }
    await player.setVolume(level);
    res.json({ ok: true });
  });

  app.post("/api/players/:guildId/loop", requireAuth, async (req, res) => {
    const player = getPlayerOr404(client, res, req.params.guildId);
    if (!player) return;
    const mode = req.body?.mode;
    if (!VALID_LOOP_MODES.has(mode)) {
      return res.status(400).json({ error: "mode must be off, track, or queue." });
    }
    await player.setRepeatMode(mode);
    res.json({ ok: true });
  });

  // ─── Live push over Socket.IO ─────────────────────────────────────────────
  io.use((socket, next) => {
    if (isValidFromHeader(socket.handshake.headers.cookie)) return next();
    next(new Error("unauthorized"));
  });

  io.on("connection", socket => {
    socket.emit("stats", statsToJSON(client));
    socket.emit("players", [...client.lavalink.players.values()].map(p => playerToJSON(client, p)));
  });

  function broadcast() {
    if (io.engine.clientsCount === 0) return;
    io.emit("stats", statsToJSON(client));
    io.emit("players", [...client.lavalink.players.values()].map(p => playerToJSON(client, p)));
  }

  const pushInterval = setInterval(broadcast, 1500);
  pushInterval.unref();

  // Nudge an immediate broadcast on the events that matter most, so the UI feels instant
  // rather than waiting for the next poll tick. Purely additive listeners — nothing here
  // changes how these events are already handled elsewhere in the bot.
  for (const evt of ["trackStart", "trackEnd", "playerCreate", "playerDestroy", "playerUpdate"]) {
    client.lavalink.on(evt, () => broadcast());
  }

  const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3000;
  server.listen(PORT, () => {
    console.log(`[Dashboard] Listening on port ${PORT}`);
  });

  return { app, server, io };
}

module.exports = { startDashboard };
