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

// ── Rate limiting ────────────────────────────────────
const loginAttempts = new Map();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }
  entry.count++;
  const remaining = Math.max(0, RATE_LIMIT_MAX - entry.count);
  return { allowed: entry.count <= RATE_LIMIT_MAX, remaining };
}

function hashPassword(pw) {
  return crypto.createHash("sha256").update(pw).digest("hex");
}

// ── Last.fm helpers ──────────────────────────────────
const LASTFM_KEY = process.env.LASTFM_API_KEY;

async function lastfmFetch(method, extra) {
  if (!LASTFM_KEY) throw new Error("LASTFM_API_KEY not configured");
  const params = new URLSearchParams();
  params.append("method", method);
  params.append("api_key", LASTFM_KEY);
  params.append("format", "json");
  for (const [k, v] of Object.entries(extra || {})) {
    if (v !== undefined && v !== null) params.append(k, String(v));
  }
  const url = "https://ws.audioscrobbler.com/2.0/?" + params.toString();
  console.log("[Last.fm] Request:", url.replace(LASTFM_KEY, "***"));
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) {
    console.error("[Last.fm] API error:", data.error, data.message);
    throw new Error("Last.fm error " + data.error + ": " + data.message);
  }
  return data;
}

function lastfmTrackToJSON(track) {
  if (!track || typeof track !== "object") return null;
  const artist = typeof track.artist === "string" ? track.artist : (track.artist?.name || track.artist?.["#text"] || "Unknown");
  const img = Array.isArray(track.image) ? track.image : [];
  let artwork = null;
  for (const size of ["extralarge", "large", "medium", "small", ""]) {
    const found = img.find(i => i.size === size);
    if (found && found["#text"] && found["#text"].trim().length > 10) {
      artwork = found["#text"].trim();
      break;
    }
  }
  // If no image from Last.fm, leave null so enrichTracksWithArtwork can fill it
  return {
    title: track.name || "Unknown",
    artist: artist,
    artwork: artwork,
    uri: "ytmsearch:" + encodeURIComponent(artist + " " + (track.name || "")),
    durationFmt: track.duration && !isNaN(Number(track.duration)) ? formatDuration(Number(track.duration) * 1000) : "3:45",
    listeners: Number(track.listeners || 0),
    playcount: Number(track.playcount || 0),
  };
}

// ── Artwork enrichment via Lavalink ─────────────────
async function enrichTracksWithArtwork(client, tracks) {
  const node = client.lavalink.nodeManager.nodes.get("main");
  if (!node || !node.connected) {
    console.log("[Dashboard] No Lavalink node available for artwork enrichment");
    return tracks;
  }
  const enriched = [];
  for (const track of tracks) {
    if (track.artwork && track.artwork.length > 10) {
      enriched.push(track);
      continue;
    }
    try {
      const query = track.artist + " " + track.title;
      const result = await node.search({ query, source: "ytmsearch" }, { username: "Dashboard", tag: "Dashboard" });
      if (result?.tracks?.[0]?.info?.artworkUrl) {
        track.artwork = result.tracks[0].info.artworkUrl;
        console.log("[Dashboard] Got artwork for", track.title, ":", track.artwork.substring(0, 60) + "...");
      } else if (result?.tracks?.[0]?.info?.identifier) {
        track.artwork = `https://img.youtube.com/vi/${result.tracks[0].info.identifier}/mqdefault.jpg`;
        console.log("[Dashboard] Got YT thumbnail for", track.title);
      } else {
        console.log("[Dashboard] No artwork found for", track.title);
      }
    } catch (e) {
      console.error("[Dashboard] Artwork search failed for", track.title, ":", e.message);
    }
    enriched.push(track);
  }
  return enriched;
}

// ── Search cache ───────────────────────────────────
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

// ── Main dashboard setup ───────────────────────────
function startDashboard(client) {
  console.log("[Dashboard] Starting dashboard...");
  console.log("[Dashboard] LASTFM_API_KEY:", LASTFM_KEY ? "configured (" + LASTFM_KEY.substring(0, 4) + "****)" : "NOT SET");
  const app    = express();
  const server = http.createServer(app);
  const io     = new Server(server, { cors: { origin: false } });

  const PASSWORD = process.env.DASHBOARD_PASSWORD;
  if (!PASSWORD) console.warn("[Dashboard] DASHBOARD_PASSWORD not set — logins disabled.");

  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  // Healthcheck for Railway autoscale
  app.get("/api/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

  app.get("/api/me", (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    res.json({ authenticated: isValid(token) });
  });

  app.post("/api/login", (req, res) => {
    const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
    const { password } = req.body || {};

    if (!PASSWORD) {
      console.warn("[Dashboard] Login rejected: DASHBOARD_PASSWORD not set");
      return res.status(503).json({ error: "Dashboard password not configured on server. Set DASHBOARD_PASSWORD env var." });
    }

    const limit = checkRateLimit(clientIp);
    if (!limit.allowed) {
      console.warn("[Dashboard] Rate limit hit for IP:", clientIp);
      return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    }

    const inputHash = hashPassword(password || "");
    const expectedHash = PASSWORD.length === 64 ? PASSWORD : hashPassword(PASSWORD);

    if (typeof password !== "string" || inputHash !== expectedHash) {
      console.warn("[Dashboard] Login failed: wrong password from", clientIp, "remaining:", limit.remaining);
      return res.status(401).json({ error: "Incorrect password. " + limit.remaining + " attempts remaining." });
    }

    console.log("[Dashboard] Login successful from", clientIp);
    const token = createSession();
    res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", maxAge: 1000*60*60*24*7, path: "/" });
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

  // ─── Last.fm Discovery ──────────────────────────────
  app.get("/api/lastfm/trending", requireAuth, async (req, res) => {
    try {
      console.log("[Dashboard] Fetching Last.fm trending...");
      const data = await lastfmFetch("chart.gettoptracks", { limit: "12" });
      const raw = data.tracks?.track || [];
      console.log("[Dashboard] Last.fm returned", raw.length, "tracks");
      let tracks = raw.map(lastfmTrackToJSON).filter(Boolean);
      console.log("[Dashboard] Parsed", tracks.length, "valid tracks");
      tracks = await enrichTracksWithArtwork(client, tracks);
      console.log("[Dashboard] Enriched", tracks.length, "tracks with artwork");
      res.json({ tracks });
    } catch (err) {
      console.error("[Dashboard] Last.fm trending error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lastfm/genre/:tag", requireAuth, async (req, res) => {
    try {
      const tag = req.params.tag;
      const data = await lastfmFetch("tag.gettoptracks", { tag, limit: "12" });
      const raw = data.tracks?.track || [];
      let tracks = raw.map(lastfmTrackToJSON).filter(Boolean);
      tracks = await enrichTracksWithArtwork(client, tracks);
      res.json({ tracks });
    } catch (err) {
      console.error("[Dashboard] Last.fm genre error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lastfm/test", requireAuth, async (req, res) => {
    try {
      if (!LASTFM_KEY) return res.status(503).json({ ok: false, error: "LASTFM_API_KEY not set" });
      const data = await lastfmFetch("chart.gettoptracks", { limit: "1" });
      res.json({ ok: true, keyPrefix: LASTFM_KEY.substring(0, 4), trackCount: data.tracks?.track?.length || 0 });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/lastfm/search", requireAuth, async (req, res) => {
    try {
      const q = (req.query.q || "").toString().trim();
      if (!q) return res.status(400).json({ error: "q is required" });
      const data = await lastfmFetch("track.search", { track: q, limit: "12" });
      const raw = data.results?.trackmatches?.track || [];
      let tracks = raw.map(lastfmTrackToJSON).filter(Boolean);
      tracks = await enrichTracksWithArtwork(client, tracks);
      res.json({ tracks });
    } catch (err) {
      console.error("[Dashboard] Last.fm search error:", err.message);
      res.status(500).json({ error: err.message });
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

  const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3000;
  server.listen(PORT, () => { console.log(`[Dashboard] Listening on port ${PORT}`); });
  return { app, server, io };
}

module.exports = { startDashboard };
