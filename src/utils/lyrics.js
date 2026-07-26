"use strict";

/**
 * Shared lyrics lookup used by /lyrics, /lyric, and the dashboard's lyrics
 * panel. Tries LRCLIB first (free, keyless, purpose-built for time-synced
 * LRC lyrics) and falls back to lyrics.ovh for plain text only when no
 * synced (or even unsynced) match exists there.
 */

const https = require("https");

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const cache = new Map(); // key -> { at, data }

function cacheKey(artist, title) {
  return `${(artist || "").toLowerCase().trim()}|${(title || "").toLowerCase().trim()}`;
}

function httpsGetJson(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "GET", headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("Parse error"));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

/** Parses standard LRC-format text ("[mm:ss.xx]line") into [{time, text}] in ms, sorted. */
function parseLrc(lrcText) {
  const lines = [];
  for (const raw of lrcText.split("\n")) {
    const match = raw.match(/^\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\](.*)$/);
    if (!match) continue;
    const minutes = parseInt(match[1], 10);
    const seconds = parseFloat(match[2]);
    const text = match[3].trim();
    lines.push({ time: Math.round((minutes * 60 + seconds) * 1000), text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

/** Cleans a title/author the same way across every caller, so lookups match consistently. */
function resolveArtistTitle(track) {
  const title = (track.info.title || "").replace(/\(.*?\)|\[.*?\]/g, "").trim();
  const artist = (track.info.author || "").replace(/\s*-\s*Topic$/, "").trim();
  return { artist, title };
}

async function fetchFromLrclib(artist, title, durationSec) {
  const qs = new URLSearchParams({ track_name: title, artist_name: artist || "" });
  if (durationSec) qs.set("duration", String(Math.round(durationSec)));

  // Exact-match endpoint first (best quality match when it hits).
  try {
    const exact = await httpsGetJson("lrclib.net", `/api/get?${qs.toString()}`, { "User-Agent": "DiscordMusicBot/1.0" });
    if (exact && (exact.syncedLyrics || exact.plainLyrics)) {
      return {
        synced: exact.syncedLyrics ? parseLrc(exact.syncedLyrics) : null,
        plain: exact.plainLyrics || null,
      };
    }
  } catch {
    // fall through to fuzzy search
  }

  // Fuzzy search fallback — take the first result that actually has synced lyrics.
  try {
    const results = await httpsGetJson(
      "lrclib.net",
      `/api/search?${new URLSearchParams({ track_name: title, artist_name: artist || "" }).toString()}`,
      { "User-Agent": "DiscordMusicBot/1.0" }
    );
    if (Array.isArray(results)) {
      const withSync = results.find((r) => r.syncedLyrics) || results.find((r) => r.plainLyrics);
      if (withSync) {
        return {
          synced: withSync.syncedLyrics ? parseLrc(withSync.syncedLyrics) : null,
          plain: withSync.plainLyrics || null,
        };
      }
    }
  } catch {
    // nothing found
  }

  return { synced: null, plain: null };
}

function fetchFromLyricsOvh(artist, title) {
  return new Promise((resolve, reject) => {
    const slug = (str) => encodeURIComponent((str || "").replace(/[^\w\s'-]/gi, "").trim());
    const path = artist ? `/v1/${slug(artist)}/${slug(title)}` : `/v1/unknown/${slug(title)}`;

    https.get({ hostname: "api.lyrics.ovh", path, headers: { "User-Agent": "DiscordMusicBot/1.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("Not found"));
        try {
          const json = JSON.parse(data);
          json.lyrics ? resolve(json.lyrics.trim()) : reject(new Error("No lyrics field"));
        } catch {
          reject(new Error("Parse error"));
        }
      });
    }).on("error", reject);
  });
}

/**
 * Returns { synced: [{time,text}]|null, plain: string|null, source: string|null }.
 * `synced` is only present when real timestamp data was found (LRCLIB).
 */
async function getLyrics(artist, title, durationSec) {
  const key = cacheKey(artist, title);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  let result = { synced: null, plain: null, source: null };

  try {
    const lrclib = await fetchFromLrclib(artist, title, durationSec);
    if (lrclib.synced || lrclib.plain) {
      result = { synced: lrclib.synced, plain: lrclib.plain, source: "lrclib" };
    }
  } catch {
    // ignore, try next source
  }

  if (!result.plain && !result.synced) {
    try {
      const plain = await fetchFromLyricsOvh(artist, title);
      result = { synced: null, plain, source: "lyrics.ovh" };
    } catch {
      // no lyrics anywhere
    }
  }

  cache.set(key, { at: Date.now(), data: result });
  return result;
}

module.exports = { getLyrics, resolveArtistTitle, parseLrc };
