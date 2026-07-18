"use strict";

const path    = require("path");
const http    = require("http");
const crypto  = require("crypto");
const express = require("express");
const { Server } = require("socket.io");

const { COOKIE_NAME, createSession, destroySession, requireAuth, isValidFromHeader, parseCookies, isValid } = require("./auth");
const { statsToJSON, playerToJSON } = require("./state");
const { formatDuration, resolveSpotify, getSpotifyRecommendations, extractSpotifyId } = require("../utils/helpers");

const VALID_LOOP_MODES = new Set(["off", "track", "queue"]);
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map();

function cacheSearchResult(guildId, track) {
  const token = crypto.randomUUID();
  searchCache.set(`${guildId}:${token}`, { track, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
  return token;
}

function takeSearchResult(guildId, token) {
  const key = `${guildId}:${token}`;
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) { searchCache.delete(key); return null; }
  return entry.track;
}

function trackToSearchJSON(guildId, track) {
  return {
    token:       cacheSearchResult(guildId, track),
    title:       track.info.title,
    author:      track.info.author || "Unknown",
    duration:    track.info.duration || 0,
    durationFmt: track.info.isStream ? "LIVE" : formatDuration(track.info.duration || 0),
    isStream:    !!track.info.isStream,
    source:      track.info.sourceName || "unknown",
    uri:         track.info.uri || null,
    artwork:     track.info.artworkUrl?.trim() || (track.info.identifier ? `https://img.youtube.com/vi/${track.info.identifier}/mqdefault.jpg` : null),
  };
}

function getPlayerOr404(client, res, guildId) {
  const player = client.lavalink.getPlayer(guildId);
  if (!player) { res.status(404).json({ error: "No active player for that server." }); return null; }
  return player;
}

function startDashboard(client) {
  const app    = express();
  app.set('trust proxy', 1);
  const server = http.createServer(app);
  const io     = new Server(server, { cors: { origin: false } });

  const PASSWORD = process.env.DASHBOARD_PASSWORD;
  if (!PASSWORD) console.warn("[Dashboard] DASHBOARD_PASSWORD not set — logins disabled.");

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/me", (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    res.json({ authenticated: isValid(token) });
  });

  app.post("/api/login", (req, res) => {
    console.log("[Dashboard] Login attempt from", req.ip);
    const { password } = req.body || {};
    if (!PASSWORD) {
      console.warn("[Dashboard] Login rejected: DASHBOARD_PASSWORD not set");
      return res.status(503).json({ error: "Dashboard password not configured on server. Set DASHBOARD_PASSWORD env var." });
    }
    if (typeof password !== "string" || password !== PASSWORD) {
      console.log("[Dashboard] Login failed: wrong password from", req.ip);
      return res.status(401).json({ error: "Incorrect password." });
    }
    const token = createSession();
    res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", maxAge: 1000*60*60*24*7, path: "/" });
    console.log("[Dashboard] Login successful from", req.ip);
    res.json({ ok: true });
  });

  app.post("/api/logout", requireAuth, (req, res) => {
    destroySession(req.sessionToken);
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`);
    res.json({ ok: true });
  });

  app.get("/api/stats", requireAuth, (req, res) => { res.json(statsToJSON(client)); });
  app.get("/api/players", requireAuth, (req, res) => { res.json([...client.lavalink.players.values()].map(p => playerToJSON(client, p))); });

  app.post("/api/players/:guildId/pause",  requireAuth, async (req, res) => { const p=getPlayerOr404(client,res,req.params.guildId); if(p) await p.pause(); res.json({ok:true}); });
  app.post("/api/players/:guildId/resume", requireAuth, async (req, res) => { const p=getPlayerOr404(client,res,req.params.guildId); if(p) await p.resume(); res.json({ok:true}); });
  app.post("/api/players/:guildId/skip",   requireAuth, async (req, res) => { const p=getPlayerOr404(client,res,req.params.guildId); if(p) await p.skip(); res.json({ok:true}); });
  app.post("/api/players/:guildId/stop",   requireAuth, async (req, res) => { const p=getPlayerOr404(client,res,req.params.guildId); if(p) await p.stopPlaying(true); res.json({ok:true}); });
  app.post("/api/players/:guildId/disconnect", requireAuth, async (req, res) => { const p=getPlayerOr404(client,res,req.params.guildId); if(p) await p.destroy(); res.json({ok:true}); });

  app.post("/api/players/:guildId/volume", requireAuth, async (req, res) => {
    const p = getPlayerOr404(client, res, req.params.guildId); if (!p) return;
    const level = Number(req.body?.level);
    if (!Number.isFinite(level) || level < 0 || level > 100) return res.status(400).json({ error: "level must be 0-100." });
    await p.setVolume(level); res.json({ ok: true });
  });

  app.post("/api/players/:guildId/loop", requireAuth, async (req, res) => {
    const p = getPlayerOr404(client, res, req.params.guildId); if (!p) return;
    const mode = req.body?.mode;
    if (!VALID_LOOP_MODES.has(mode)) return res.status(400).json({ error: "mode must be off, track, or queue." });
    await p.setRepeatMode(mode); res.json({ ok: true });
  });

  app.post("/api/players/:guildId/shuffle", requireAuth, async (req, res) => {
    const p = getPlayerOr404(client, res, req.params.guildId); if (!p) return;
    if (!p.queue.tracks.length) return res.status(400).json({ error: "Nothing to shuffle." });
    const count = await p.queue.shuffle(); res.json({ ok: true, count });
  });

  // ─── Search ─────────────────────────────────────────
  app.get("/api/players/:guildId/search", requireAuth, async (req, res) => {
    const player = getPlayerOr404(client, res, req.params.guildId);
    if (!player) return;
    const query = (req.query.query || "").toString().trim();
    if (!query) return res.status(400).json({ error: "query is required." });
    const requester = { username: "Dashboard", tag: "Dashboard" };

    try {
      const isSpotify = /spotify\.com\/(track|playlist|album)\//.test(query);
      const isUrl     = /^https?:\/\//.test(query);
      const nodeInfo  = player.node?.info;
      const hasLavaSrc = nodeInfo?.plugins?.some(p => p.name?.toLowerCase().includes("lavasrc") || p.name?.toLowerCase().includes("spotify")) ?? false;
      let tracks = [];

      if (isSpotify && hasLavaSrc) {
        const result = await player.search({ query, source: "spsearch" }, requester).catch(() => null);
        if (result && result.loadType !== "empty" && result.loadType !== "error") tracks = result.tracks || [];
      } else if (isSpotify) {
        if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET)
          return res.status(400).json({ error: "Spotify credentials not configured." });
        const spotifyData = await resolveSpotify(query).catch(() => null);
        if (spotifyData?.tracks?.length) {
          for (const t of spotifyData.tracks.slice(0, 8)) {
            const r = await player.search({ query: t.query, source: "ytmsearch" }, requester).catch(() => null);
            if (r?.tracks?.[0]) tracks.push(r.tracks[0]);
          }
        }
      } else {
        const result = await player.search(isUrl ? { query } : { query, source: "ytmsearch" }, requester).catch(() => null);
        if (result && result.loadType !== "empty" && result.loadType !== "error") tracks = result.tracks || [];
      }
      res.json({ results: tracks.slice(0, 8).map(t => trackToSearchJSON(req.params.guildId, t)) });
    } catch (err) {
      console.error("[Dashboard] Search error:", err.message);
      res.status(500).json({ error: "Search failed." });
    }
  });

  app.post("/api/players/:guildId/queue", requireAuth, async (req, res) => {
    const player = getPlayerOr404(client, res, req.params.guildId);
    if (!player) return;
    const token = req.body?.token;
    const uri   = req.body?.uri;
    let track = null;
    if (typeof token === "string") track = takeSearchResult(req.params.guildId, token);
    if (!track && typeof uri === "string") {
      const r = await player.search({ query: uri }, { username: "Dashboard", tag: "Dashboard" }).catch(() => null);
      if (r?.tracks?.[0]) track = r.tracks[0];
    }
    if (!track) return res.status(400).json({ error: "Track not found or expired." });
    player.queue.add(track);
    if (!player.playing && !player.paused) await player.play().catch(err => console.error("[Dashboard] play() error:", err.message));
    res.json({ ok: true, title: track.info.title });
  });

  // ─── Spotify Recommendations ────────────────────────
  app.get("/api/players/:guildId/recommendations", requireAuth, async (req, res) => {
    const player = getPlayerOr404(client, res, req.params.guildId);
    if (!player) return;
    const current = player.queue?.current;
    if (!current) return res.json({ tracks: [] });
    try {
      let recs = [];
      if (current.info.sourceName === "spotify") {
        const sid = extractSpotifyId(current.info.uri);
        if (sid && process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
          const spotifyTracks = await getSpotifyRecommendations(sid, 6);
          recs = spotifyTracks.map(t => ({
            title: t.name,
            artist: t.artists?.map(a => a.name).join(", ") || "Unknown",
            uri: `ytmsearch:${encodeURIComponent((t.artists?.[0]?.name || "") + " " + t.name)}`,
            artwork: t.album?.images?.[0]?.url || null,
          }));
        }
      }
      res.json({ tracks: recs });
    } catch (err) {
      console.error("[Dashboard] Recommendations error:", err.message);
      res.json({ tracks: [] });
    }
  });

  // ─── Socket.IO ──────────────────────────────────────
  io.use((socket, next) => { if (isValidFromHeader(socket.handshake.headers.cookie)) return next(); next(new Error("unauthorized")); });

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

  const searchCacheCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of searchCache) { if (entry.expiresAt < now) searchCache.delete(key); }
  }, 60_000);
  searchCacheCleanupInterval.unref();

  for (const evt of ["trackStart", "trackEnd", "playerCreate", "playerDestroy", "playerUpdate", "trackStuck", "trackError"]) {
    client.lavalink.on(evt, () => broadcast());
  }

  // Push recommendations when track starts
  client.lavalink.on("trackStart", async (player, track) => {
    if (track?.info?.sourceName === "spotify" && io.engine.clientsCount > 0) {
      try {
        const sid = extractSpotifyId(track.info.uri);
        if (sid && process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
          const spotifyTracks = await getSpotifyRecommendations(sid, 6);
          const recs = spotifyTracks.map(t => ({
            title: t.name,
            artist: t.artists?.map(a => a.name).join(", ") || "Unknown",
            uri: `ytmsearch:${encodeURIComponent((t.artists?.[0]?.name || "") + " " + t.name)}`,
            artwork: t.album?.images?.[0]?.url || null,
          }));
          io.emit("recommendations", { guildId: player.guildId, tracks: recs });
        }
      } catch (e) { console.error("[Dashboard] Rec push error:", e.message); }
    }
  });

  const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3000;
  server.listen(PORT, () => { console.log(`[Dashboard] Listening on port ${PORT}`); });
  return { app, server, io };
}

module.exports = { startDashboard };
