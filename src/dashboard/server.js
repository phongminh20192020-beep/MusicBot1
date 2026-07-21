"use strict";

const path    = require("path");
const http    = require("http");
const crypto  = require("crypto");
const express = require("express");
const { Server } = require("socket.io");

const { exec } = require("child_process");
const { promisify } = require("util");
const { COOKIE_NAME, createSession, destroySession, requireAuth, isValidFromHeader, parseCookies, isValid } = require("./auth");
const { statsToJSON, playerToJSON } = require("./state");
const { formatDuration, resolveSpotify, getSpotifyRecommendations, extractSpotifyId, getSpotifyToken } = require("../utils/helpers");
const { PENALTY_WORDS, TIER1_BONUS, TIER2_BONUS, TIER3_BONUS } = require("./public/keywords");

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

const execAsync = promisify(exec);

// ── yt-dlp thumbnail fetcher ─────────────────────────
// Uses yt-dlp to extract the highest-resolution thumbnail URL
// without downloading the video. Falls back gracefully if yt-dlp
// is not installed or the video is unavailable.
async function getYtDlpThumbnail(queryOrUrl) {
  try {
    const input = String(queryOrUrl || "").trim();
    if (!input) return null;
    // If it's not a URL, treat it as a search query
    const target = /^https?:\/\//.test(input) ? input : `ytsearch1:${input}`;

    const { stdout } = await execAsync(
      `yt-dlp --dump-json --skip-download --no-warnings --no-check-certificate --extractor-args "youtube:player_client=web" "${target}"`,
      { timeout: 15000, maxBuffer: 1024 * 1024 }
    );

    const data = JSON.parse(stdout);
    if (!data) return null;

    // yt-dlp returns a 'thumbnails' array with resolutions.
    // Sort by pixel area (width * height) and pick the best.
    if (Array.isArray(data.thumbnails) && data.thumbnails.length > 0) {
      const best = data.thumbnails
        .filter(t => t.url && t.width && t.height)
        .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
      if (best) {
        console.log(`[yt-dlp] Best thumbnail: ${best.url} (${best.width}x${best.height})`);
        return best.url;
      }
    }

    // Fallback to the single thumbnail field
    if (data.thumbnail) {
      console.log(`[yt-dlp] Fallback thumbnail: ${data.thumbnail}`);
      return data.thumbnail;
    }

    return null;
  } catch (e) {
    // Silently fail if yt-dlp is missing or video is unavailable
    if (e.code === "ENOENT" || e.message.includes("command not found") || e.message.includes("not recognized")) {
      console.log("[yt-dlp] Not installed or not in PATH. Skipping.");
    } else {
      console.error("[yt-dlp] Thumbnail fetch failed:", e.message.substring(0, 200));
    }
    return null;
  }
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

// ── Query sanitizer ──────────────────────────────────
function sanitizeSearchQuery(q) {
  return q
    .replace(/\s*-\s*by\s+/gi, " ")   // "Song - by Artist" → "Song Artist"
    .replace(/\s+by\s+/gi, " ")       // "Song by Artist" → "Song Artist"
    .replace(/\s+/g, " ")             // collapse spaces
    .trim();
}

// ── String normalizer for fuzzy matching ─────────────
// Strips diacritics, parens, brackets, punctuation
function norm(s) {
  return String(s || "")
    .normalize("NFD")                  // decompose accents: é → e + ◌́
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")       // remove (anything in parens)
    .replace(/\[.*?\]/g, " ")       // remove [anything in brackets]
    .replace(/[^\w\s]/g, " ")       // remove punctuation
    .replace(/\s+/g, " ")
    .trim();
}

// ── Fuzzy track scorer ───────────────────────────────
// Returns 0.0–1.0 score of how well a track matches a query
function scoreTrack(track, rawQuery) {
  const qNorm = norm(rawQuery);
  const qWords = qNorm.split(/\s+/).filter(w => w.length > 2);
  if (!qWords.length) return 1;

  const titleNorm  = norm(track.info?.title);
  const authorNorm = norm(track.info?.author);

  // ── 1. Title exact match ──
  const titleMatched = qWords.filter(w => titleNorm.includes(w)).length;
  const titleExact   = qWords.length > 0 ? titleMatched / qWords.length : 1;

  // ── 2. Author exact match ──
  const authorMatched = qWords.filter(w => authorNorm.includes(w)).length;
  const authorExact   = qWords.length > 0 ? authorMatched / qWords.length : 1;

  // ── 3. Combined exact ──
  const combined      = titleNorm + " " + authorNorm;
  const combinedMatched = qWords.filter(w => combined.includes(w)).length;
  const combinedExact = qWords.length > 0 ? combinedMatched / qWords.length : 1;

  // ── 4. Title fuzzy ──
  const titleWords = titleNorm.split(/\s+/).filter(w => w.length > 2);
  let titleFuzzyMatches = 0;
  for (const qw of qWords) {
    for (const tw of titleWords) {
      if (tw.includes(qw) || qw.includes(tw)) { titleFuzzyMatches++; break; }
    }
  }
  const titleFuzzy = qWords.length > 0 ? titleFuzzyMatches / qWords.length : 1;

  // ── 5. Author fuzzy ──
  const authorWords = authorNorm.split(/\s+/).filter(w => w.length > 2);
  let authorFuzzyMatches = 0;
  for (const qw of qWords) {
    for (const tw of authorWords) {
      if (tw.includes(qw) || qw.includes(tw)) { authorFuzzyMatches++; break; }
    }
  }
  const authorFuzzy = qWords.length > 0 ? authorFuzzyMatches / qWords.length : 1;

  // ── 6. VERSION PENALTY / BONUS ──
  // Uses keywords from ./public/keywords.js
  // Tier 1 (official mv, official music video): +20% each
  // Tier 2 (official, original, mv): +12% each
  // Tier 3 (music video, audio, studio, etc): +6% each
  // Penalty (remix, cover, acoustic, etc): -12% each
  const tLower = titleNorm;
  let penalty = 0;
  let bonus = 0;
  for (const p of PENALTY_WORDS) if (tLower.includes(p)) penalty += 0.12;
  for (const b of TIER1_BONUS)   if (tLower.includes(b)) bonus += 0.20;
  for (const b of TIER2_BONUS)   if (tLower.includes(b)) bonus += 0.12;
  for (const b of TIER3_BONUS)   if (tLower.includes(b)) bonus += 0.06;
  const versionMod = Math.max(-0.30, Math.min(0.40, bonus - penalty));

  // Weighted blend
  const baseScore = titleExact * 0.30 + authorExact * 0.30 + combinedExact * 0.20 + titleFuzzy * 0.10 + authorFuzzy * 0.10;
  const score = Math.max(0, Math.min(1, baseScore + versionMod));

  console.log(`    scoreTrack: "${track.info?.title}" by "${track.info?.author}" | base=${(baseScore*100).toFixed(1)}% versionMod=${(versionMod>=0?"+":"")}${(versionMod*100).toFixed(0)}% → total=${(score*100).toFixed(1)}%`);

  return score;
}

// ── Reorder tracks by relevance ──────────────────────
function sortByRelevance(tracks, rawQuery) {
  if (!tracks?.length || !rawQuery) return tracks;
  const scored = tracks.map(t => ({ track: t, score: scoreTrack(t, rawQuery) }));
  scored.sort((a, b) => b.score - a.score);
  // Log what we did
  console.log(`[Dashboard] Reordered ${scored.length} results by relevance:`);
  scored.slice(0, 3).forEach((s, i) => {
    console.log(`  [${i}] "${s.track.info?.title}" by "${s.track.info?.author}" — score ${(s.score*100).toFixed(1)}%`);
  });
  return scored.map(s => s.track);
}

function lastfmTrackToJSON(track) {
  if (!track || typeof track !== "object") return null;
  const artist = typeof track.artist === "string" ? track.artist : (track.artist?.name || track.artist?.["#text"] || "Unknown");
  // Start with no artwork — enrichTracksWithArtwork will fill this in via Lavalink/yt-dlp
  const artwork = null;
  // Build clean ytmsearch query — NO encodeURIComponent here (lavalink-client handles it)
  const rawQuery = (artist + " " + (track.name || "")).trim();
  const cleanQuery = sanitizeSearchQuery(rawQuery);

  return {
    title: track.name || "Unknown",
    artist: artist,
    artwork: artwork,
    uri: "ytmsearch:" + cleanQuery,
    durationFmt: track.duration && !isNaN(Number(track.duration)) ? formatDuration(Number(track.duration) * 1000) : "3:45",
    listeners: Number(track.listeners || 0),
    playcount: Number(track.playcount || 0),
  };
}

// ── Artwork enrichment via Lavalink + yt-dlp fallback ─
// Only the first `limit` tracks get artwork fetched; the rest pass through as-is.
async function enrichTracksWithArtwork(client, tracks, limit = 10) {
  const node = client.lavalink.nodeManager.nodes.get("main");
  if (!node || !node.connected) {
    console.log("[Dashboard] No Lavalink node available for artwork enrichment");
  }
  const enriched = [];
  let enrichCount = 0;
  for (const track of tracks) {
    // Only enrich up to `limit` tracks (saves Lavalink from getting hammered)
    if (enrichCount >= limit || (track.artwork && isValidHttpUrl(track.artwork))) {
      enriched.push(track);
      continue;
    }

    let found = false;

    // Try 1: Lavalink search
    if (node && node.connected) {
      try {
        const query = track.artist + " " + track.title;
        const result = await node.search({ query, source: "ytmsearch" }, { username: "Dashboard", tag: "Dashboard" });
        if (result?.tracks?.[0]?.info?.artworkUrl) {
          track.artwork = result.tracks[0].info.artworkUrl;
          console.log("[Dashboard] Got artwork via Lavalink for", track.title);
          found = true;
        } else if (result?.tracks?.[0]?.info?.identifier) {
          track.artwork = `https://img.youtube.com/vi/${result.tracks[0].info.identifier}/hqdefault.jpg`;
          console.log("[Dashboard] Got YT thumbnail via Lavalink for", track.title);
          found = true;
        }
      } catch (e) {
        console.error("[Dashboard] Lavalink artwork search failed for", track.title, ":", e.message);
      }
    }

    // Try 2: yt-dlp for best-resolution thumbnail
    if (!found) {
      try {
        const query = track.artist + " " + track.title;
        const ytDlpUrl = await getYtDlpThumbnail(query);
        if (ytDlpUrl) {
          track.artwork = ytDlpUrl;
          console.log("[Dashboard] Got artwork via yt-dlp for", track.title, ":", ytDlpUrl.substring(0, 60) + "...");
          found = true;
        }
      } catch (e) {
        console.error("[Dashboard] yt-dlp artwork fetch failed for", track.title, ":", e.message);
      }
    }

    if (!found) {
      console.log("[Dashboard] No artwork found for", track.title);
    }

    enrichCount++;
    enriched.push(track);
  }
  return enriched;
}

// Simple helper — reused in enrichTracksWithArtwork
function isValidHttpUrl(url) {
  return typeof url === "string" && /^https?:\/\//.test(url) && url.length > 10;
}

// ── Artist artwork enrichment ─────────────────────────
// Uses the artist's name alone as the search query to grab a representative
// thumbnail (Lavalink first, yt-dlp as fallback), same pattern as track artwork.
async function enrichArtistsWithArtwork(client, artists) {
  const node = client.lavalink.nodeManager.nodes.get("main");
  const enriched = [];
  for (const artist of artists) {
    let found = false;

    if (node && node.connected) {
      try {
        const result = await node.search({ query: artist.name, source: "ytmsearch" }, { username: "Dashboard", tag: "Dashboard" });
        if (result?.tracks?.[0]?.info?.artworkUrl) {
          artist.artwork = result.tracks[0].info.artworkUrl;
          found = true;
        } else if (result?.tracks?.[0]?.info?.identifier) {
          artist.artwork = `https://img.youtube.com/vi/${result.tracks[0].info.identifier}/hqdefault.jpg`;
          found = true;
        }
      } catch (e) {
        console.error("[Dashboard] Lavalink artwork search failed for artist", artist.name, ":", e.message);
      }
    }

    if (!found) {
      try {
        const ytDlpUrl = await getYtDlpThumbnail(artist.name);
        if (ytDlpUrl) {
          artist.artwork = ytDlpUrl;
          found = true;
        }
      } catch (e) {
        console.error("[Dashboard] yt-dlp artwork fetch failed for artist", artist.name, ":", e.message);
      }
    }

    enriched.push(artist);
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
    artwork:     track.info.artworkUrl?.trim() || (track.info.identifier ? `https://img.youtube.com/vi/${track.info.identifier}/hqdefault.jpg` : null),
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
    const mode = String(req.body?.mode || "").toLowerCase();
    if (!VALID_LOOP_MODES.has(mode)) return res.status(400).json({ error: "mode must be off, track, or queue." });
    await p.setRepeatMode(mode); res.json({ ok: true, mode });
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
    const rawQuery = (req.query.query || "").toString().trim();
    if (!rawQuery) return res.status(400).json({ error: "query is required." });
    const requester = { username: "Dashboard", tag: "Dashboard" };

    // Sanitize query before searching
    const query = sanitizeSearchQuery(rawQuery);
    console.log(`[Dashboard] Search raw: "${rawQuery}" | sanitized: "${query}"`);

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

      console.log(`[Dashboard] Search returned ${tracks.length} results for "${query}"`);
      tracks.slice(0, 3).forEach((t, i) => {
        console.log(`  [${i}] "${t.info?.title}" by "${t.info?.author}" | ${t.info?.uri}`);
      });

      // Reorder by relevance so best match appears first
      const reordered = sortByRelevance(tracks, query);
      res.json({ results: reordered.slice(0, 8).map(t => trackToSearchJSON(req.params.guildId, t)) });
    } catch (err) {
      console.error("[Dashboard] Search error:", err.message);
      res.status(500).json({ error: "Search failed." });
    }
  });

  app.post("/api/players/:guildId/queue", requireAuth, async (req, res) => {
    const player = getPlayerOr404(client, res, req.params.guildId);
    if (!player) return;
    const token = req.body?.token;
    let uri     = req.body?.uri;
    let track = null;

    // Try cached token first
    if (typeof token === "string") {
      track = takeSearchResult(req.params.guildId, token);
      if (track) console.log("[Dashboard] Queue from token cache:", track.info?.title);
    }

    // Fallback: search by URI
    if (!track && typeof uri === "string") {
      // Sanitize the URI/query before searching
      const cleanUri = sanitizeSearchQuery(uri);
      console.log("[Dashboard] Queue search URI:", cleanUri);

      const r = await player.search({ query: cleanUri }, { username: "Dashboard", tag: "Dashboard" }).catch((e) => {
        console.error("[Dashboard] Queue search error:", e.message);
        return null;
      });

      if (r?.tracks?.length) {
        const rawQuery = cleanUri.toLowerCase().replace(/^ytmsearch:/, "").trim();
        const reordered = sortByRelevance(r.tracks, rawQuery);
        track = reordered[0];

        // If top result is still weak, warn but still use it
        const topScore = scoreTrack(track, rawQuery);
        if (topScore < 0.25) {
          console.warn(`[Dashboard] WARNING: Best match score only ${(topScore*100).toFixed(1)}% for "${rawQuery}" — result may be wrong.`);
        }
      } else {
        console.warn("[Dashboard] Search returned no results for URI:", cleanUri);
      }
    }

    if (!track) return res.status(400).json({ error: "Track not found or expired." });

    player.queue.add(track);
    if (!player.playing && !player.paused) {
      await player.play().catch(err => console.error("[Dashboard] play() error:", err.message));
    }
    res.json({ ok: true, title: track.info.title });
  });

  // ─── Last.fm Discovery ──────────────────────────────
  // Paginates at the Last.fm API level (10 tracks per page) so each page
  // only fetches/enriches artwork for the 10 tracks it actually needs.
  const DISCOVER_PAGE_SIZE = 10;
  const MAX_DISCOVER_PAGES = 5; // sanity cap — Last.fm can report huge totals

  app.get("/api/lastfm/trending", requireAuth, async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      console.log("[Dashboard] Fetching Last.fm trending, page", page);
      const data = await lastfmFetch("chart.gettoptracks", { limit: String(DISCOVER_PAGE_SIZE), page: String(page) });
      const raw = data.tracks?.track || [];
      const attr = data.tracks?.["@attr"] || {};
      console.log("[Dashboard] Last.fm returned", raw.length, "tracks");
      let tracks = raw.map(lastfmTrackToJSON).filter(Boolean);
      console.log("[Dashboard] Parsed", tracks.length, "valid tracks");
      tracks = await enrichTracksWithArtwork(client, tracks, DISCOVER_PAGE_SIZE);
      console.log("[Dashboard] Enriched", tracks.length, "tracks with artwork for page", page);
      const totalPages = Math.min(MAX_DISCOVER_PAGES, Math.max(1, parseInt(attr.totalPages, 10) || 1));
      res.json({ tracks, page, totalPages });
    } catch (err) {
      console.error("[Dashboard] Last.fm trending error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lastfm/tag", requireAuth, async (req, res) => {
    try {
      const tag = (req.query.tag || "").toString().trim();
      if (!tag) return res.status(400).json({ error: "tag is required" });
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      console.log("[Dashboard] Fetching Last.fm tag:", tag, "page", page);
      const data = await lastfmFetch("tag.gettoptracks", { tag, limit: String(DISCOVER_PAGE_SIZE), page: String(page) });
      const raw = data.tracks?.track || [];
      const attr = data.tracks?.["@attr"] || {};
      console.log("[Dashboard] Last.fm tag returned", raw.length, "tracks");
      let tracks = raw.map(lastfmTrackToJSON).filter(Boolean);
      console.log("[Dashboard] Parsed", tracks.length, "valid tracks");
      tracks = await enrichTracksWithArtwork(client, tracks, DISCOVER_PAGE_SIZE);
      console.log("[Dashboard] Enriched", tracks.length, "tracks with artwork for page", page);
      const totalPages = Math.min(MAX_DISCOVER_PAGES, Math.max(1, parseInt(attr.totalPages, 10) || 1));
      res.json({ tracks, page, totalPages });
    } catch (err) {
      console.error("[Dashboard] Last.fm tag error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  const ARTIST_PAGE_SIZE = 8;

  app.get("/api/lastfm/top-artists", requireAuth, async (req, res) => {
    try {
      const tag = (req.query.tag || "").toString().trim();
      const method = tag ? "tag.gettopartists" : "chart.gettopartists";
      const params = tag ? { tag, limit: String(ARTIST_PAGE_SIZE) } : { limit: String(ARTIST_PAGE_SIZE) };
      console.log("[Dashboard] Fetching Last.fm top artists" + (tag ? " for tag: " + tag : " (global)"));
      const data = await lastfmFetch(method, params);
      const root = data.artists || data.topartists || {};
      const raw = root.artist || [];
      let artists = raw.slice(0, ARTIST_PAGE_SIZE).map(a => ({
        name: (typeof a === "string" ? a : a.name) || "Unknown",
        listeners: Number(a.listeners || 0),
        artwork: null,
      })).filter(a => a.name && a.name !== "Unknown");
      artists = await enrichArtistsWithArtwork(client, artists);
      console.log("[Dashboard] Returning", artists.length, "top artists");
      res.json({ artists });
    } catch (err) {
      console.error("[Dashboard] Last.fm top artists error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lastfm/artist-tracks", requireAuth, async (req, res) => {
    try {
      const artist = (req.query.artist || "").toString().trim();
      if (!artist) return res.status(400).json({ error: "artist is required" });
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      console.log("[Dashboard] Fetching top tracks for artist:", artist, "page", page);
      const data = await lastfmFetch("artist.gettoptracks", { artist, limit: String(DISCOVER_PAGE_SIZE), page: String(page) });
      const root = data.toptracks || data.tracks || {};
      const raw = root.track || [];
      const attr = root["@attr"] || {};
      console.log("[Dashboard] Last.fm returned", raw.length, "tracks for artist");
      let tracks = raw.map(lastfmTrackToJSON).filter(Boolean);
      tracks = await enrichTracksWithArtwork(client, tracks, DISCOVER_PAGE_SIZE);
      console.log("[Dashboard] Enriched", tracks.length, "artist tracks for page", page);
      const totalPages = Math.min(MAX_DISCOVER_PAGES, Math.max(1, parseInt(attr.totalPages, 10) || 1));
      res.json({ tracks, page, totalPages, artist });
    } catch (err) {
      console.error("[Dashboard] Last.fm artist tracks error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Artist "Songs" (full discography, sorted by official release date) ──
  // Last.fm's artist.getTopTracks has no release-date data, so this uses the
  // Spotify Web API (client-credentials, same creds as /play's Spotify support)
  // to pull the artist's albums+singles, flatten their tracks, sort newest-first,
  // and cache the result in-memory per artist for a few minutes.
  const artistSongsCache = new Map(); // key: lowercased artist name -> { songs, fetchedAt }
  const ARTIST_SONGS_CACHE_TTL_MS = 10 * 60 * 1000;
  const ARTIST_SONGS_PAGE_SIZE = 10;
  const ARTIST_SONGS_MAX_ALBUMS = 25; // bound how many albums we fetch full tracklists for

  async function fetchArtistSongsByDate(artistName) {
    const cacheKey = artistName.toLowerCase();
    const cached = artistSongsCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < ARTIST_SONGS_CACHE_TTL_MS) {
      return cached.songs;
    }

    const token = await getSpotifyToken();
    const headers = { Authorization: `Bearer ${token}` };

    // 1. Find the artist on Spotify
    const searchRes = await fetch(
      "https://api.spotify.com/v1/search?type=artist&limit=1&q=" + encodeURIComponent(artistName),
      { headers }
    );
    if (!searchRes.ok) throw new Error(`Spotify artist search failed (${searchRes.status})`);
    const searchData = await searchRes.json();
    const spotifyArtist = searchData.artists?.items?.[0];
    if (!spotifyArtist) return [];

    // 2. Get their albums + singles (up to 50, Spotify's per-request max)
    const albumsRes = await fetch(
      `https://api.spotify.com/v1/artists/${spotifyArtist.id}/albums?include_groups=album,single&limit=50&market=US`,
      { headers }
    );
    if (!albumsRes.ok) throw new Error(`Spotify albums fetch failed (${albumsRes.status})`);
    const albumsData = await albumsRes.json();
    let albums = albumsData.items || [];

    // Newest release first
    albums.sort((a, b) => new Date(b.release_date).getTime() - new Date(a.release_date).getTime());
    albums = albums.slice(0, ARTIST_SONGS_MAX_ALBUMS);

    // 3. Pull full tracklists for each album (has release date attached)
    const seenTitles = new Set();
    const songs = [];
    for (const album of albums) {
      try {
        const albumRes = await fetch(`https://api.spotify.com/v1/albums/${album.id}?market=US`, { headers });
        if (!albumRes.ok) continue;
        const albumData = await albumRes.json();
        const artwork = albumData.images?.[0]?.url || album.images?.[0]?.url || null;
        for (const t of albumData.tracks?.items || []) {
          const dedupeKey = t.name.toLowerCase().replace(/\s*\(.*?\)\s*/g, "").trim();
          if (seenTitles.has(dedupeKey)) continue; // skip deluxe/remaster dupes, keep newest version
          seenTitles.add(dedupeKey);
          const artistNames = (t.artists || []).map(a => a.name).join(", ") || artistName;
          const cleanQuery = sanitizeSearchQuery(`${artistNames} ${t.name}`.trim());
          songs.push({
            title: t.name,
            artist: artistNames,
            artwork,
            uri: "ytmsearch:" + cleanQuery,
            durationFmt: formatDuration(t.duration_ms || 0),
            releaseDate: album.release_date,
            releaseDatePrecision: album.release_date_precision,
            albumName: album.name,
          });
        }
      } catch (e) {
        console.error("[Dashboard] Failed to fetch album tracks for", album.name, ":", e.message);
      }
    }

    artistSongsCache.set(cacheKey, { songs, fetchedAt: Date.now() });
    return songs;
  }

  app.get("/api/lastfm/artist-songs", requireAuth, async (req, res) => {
    try {
      const artist = (req.query.artist || "").toString().trim();
      if (!artist) return res.status(400).json({ error: "artist is required" });
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      console.log("[Dashboard] Fetching full discography for artist:", artist, "page", page);
      const allSongs = await fetchArtistSongsByDate(artist);
      const totalPages = Math.max(1, Math.ceil(allSongs.length / ARTIST_SONGS_PAGE_SIZE));
      const start = (page - 1) * ARTIST_SONGS_PAGE_SIZE;
      const songs = allSongs.slice(start, start + ARTIST_SONGS_PAGE_SIZE);
      console.log("[Dashboard] Returning", songs.length, "of", allSongs.length, "songs, page", page, "/", totalPages);
      res.json({ songs, page, totalPages, totalSongs: allSongs.length, artist });
    } catch (err) {
      console.error("[Dashboard] Artist songs-by-date error:", err.message);
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
      const data = await lastfmFetch("track.search", { track: q, limit: "20" });
      const raw = data.results?.trackmatches?.track || [];
      let tracks = raw.slice(0, 20).map(lastfmTrackToJSON).filter(Boolean);
      tracks = await enrichTracksWithArtwork(client, tracks, 10);
      res.json({ tracks });
    } catch (err) {
      console.error("[Dashboard] Last.fm search error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── YouTube Music Search (Global) ──────────────────
  app.get("/api/search", requireAuth, async (req, res) => {
    try {
      const q = (req.query.q || "").toString().trim();
      if (!q) return res.status(400).json({ error: "q is required" });

      const node = client.lavalink.nodeManager.nodes.get("main");
      if (!node || !node.connected) {
        return res.status(503).json({ error: "Lavalink node not available" });
      }

      console.log("[Dashboard] ytmsearch:", q);
      const result = await node.search({ query: q, source: "ytmsearch" }, { username: "Dashboard", tag: "Dashboard" }).catch((e) => {
        console.error("[Dashboard] ytmsearch node error:", e.message);
        return null;
      });

      const rawTracks = result?.tracks || [];
      if (!rawTracks.length) {
        return res.json({ tracks: [] });
      }

      // Enhance thumbnails with yt-dlp for highest resolution (first 10 only to avoid overload)
      const tracks = [];
      for (let i = 0; i < rawTracks.length; i++) {
        const t = rawTracks[i];
        let artwork = t.info?.artworkUrl || null;
        const identifier = t.info?.identifier;

        // Only run yt-dlp for the first 10 tracks — it's slow; the rest use the YT fallback
        if (i < 10 && (!artwork || artwork.includes("mqdefault")) && identifier) {
          const ytDlpUrl = await getYtDlpThumbnail(`https://www.youtube.com/watch?v=${identifier}`);
          if (ytDlpUrl) artwork = ytDlpUrl;
        }

        // Final fallback: standard YouTube thumbnail
        if (!artwork && identifier) {
          artwork = `https://img.youtube.com/vi/${identifier}/hqdefault.jpg`;
        }

        tracks.push({
          title:       t.info?.title || "Unknown",
          artist:      t.info?.author || "Unknown",
          artwork:     artwork,
          uri:         t.info?.uri || `ytmsearch:${t.info?.title || ""} ${t.info?.author || ""}`.trim(),
          durationFmt: t.info?.isStream ? "LIVE" : formatDuration(t.info?.duration || 0),
          listeners:   0,
          playcount:   0,
        });
      }

      res.json({ tracks });
    } catch (err) {
      console.error("[Dashboard] ytmsearch error:", err.message);
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
