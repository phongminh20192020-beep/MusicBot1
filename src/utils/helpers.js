"use strict";

/**
 * Format milliseconds into h:mm:ss or m:ss
 */
function formatDuration(ms) {
  const s   = Math.floor(ms / 1000);
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Build a playback progress bar string
 */
function progressBar(position, duration, length = 12) {
  const LINE     = "<:ProgessBarLine:1529472129697845378>";
  const DOT_LINE = "<:ProgessBarDotandLine:1529472131417505912>";

  const dotIndex = Math.min(length - 1, Math.max(0, Math.round((position / duration) * (length - 1))));

  let bar = "";
  for (let i = 0; i < length; i++) {
    bar += i === dotIndex ? DOT_LINE : LINE;
  }
  return bar;
}

// ─── Spotify Client Credentials token ────────────────────────────────────────
// Uses SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET env vars (official API).
// Falls back gracefully if credentials are missing.
let _spotifyTokenCache = null;

async function getSpotifyToken() {
  if (_spotifyTokenCache && _spotifyTokenCache.expiresAt > Date.now() + 60_000) {
    return _spotifyTokenCache.token;
  }

  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw new Error("SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET env vars are not set.");

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/x-www-form-urlencoded",
      "Authorization": "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) throw new Error(`Spotify token request failed (${res.status})`);

  const data = await res.json();
  if (!data.access_token) throw new Error("Spotify returned no access_token");

  _spotifyTokenCache = {
    token:     data.access_token,
    // expires_in is in seconds; subtract 60 s safety margin
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };

  return data.access_token;
}

/**
 * Resolve a Spotify URL into { type, name, tracks[] }.
 * Each track is { query, title, artist }.
 * Supports track, playlist, and album URLs.
 */
async function resolveSpotify(url) {
  const token   = await getSpotifyToken();
  const headers = { Authorization: `Bearer ${token}` };

  const trackMatch    = url.match(/spotify\.com\/track\/([a-zA-Z0-9]+)/);
  const playlistMatch = url.match(/spotify\.com\/playlist\/([a-zA-Z0-9]+)/);
  const albumMatch    = url.match(/spotify\.com\/album\/([a-zA-Z0-9]+)/);

  if (trackMatch) {
    const res = await fetch(`https://api.spotify.com/v1/tracks/${trackMatch[1]}`, { headers });
    if (!res.ok) throw new Error(`Spotify track fetch failed (${res.status})`);
    const d      = await res.json();
    const artist = d.artists?.[0]?.name ?? "";
    return {
      type:   "track",
      name:   d.name,
      tracks: [{ query: `${artist} ${d.name}`.trim(), title: d.name, artist, duration: d.duration_ms || 0 }],
    };
  }

  if (playlistMatch) {
    // Paginate through all tracks (Spotify returns max 100 per page)
    const id     = playlistMatch[1];
    let   url    = `https://api.spotify.com/v1/playlists/${id}?fields=name,tracks.items(track(name,artists,duration_ms)),tracks.next,tracks.total`;
    const res    = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Spotify playlist fetch failed (${res.status})`);
    const d      = await res.json();

    const items  = [...(d.tracks?.items ?? [])];
    let   next   = d.tracks?.next;
    while (next) {
      const page = await fetch(next, { headers });
      if (!page.ok) break;
      const pd = await page.json();
      items.push(...(pd.items ?? []));
      next = pd.next;
    }

    const tracks = items
      .map(i => i.track)
      .filter(Boolean)
      .map(t => {
        const artist = t.artists?.[0]?.name ?? "";
        return { query: `${artist} ${t.name}`.trim(), title: t.name, artist, duration: t.duration_ms || 0 };
      });

    return { type: "playlist", name: d.name, tracks };
  }

  if (albumMatch) {
    const res = await fetch(
      `https://api.spotify.com/v1/albums/${albumMatch[1]}?market=US`,
      { headers }
    );
    if (!res.ok) throw new Error(`Spotify album fetch failed (${res.status})`);
    const d      = await res.json();
    const tracks = (d.tracks?.items ?? []).map(t => {
      const artist = t.artists?.[0]?.name ?? "";
      return { query: `${artist} ${t.name}`.trim(), title: t.name, artist, duration: t.duration_ms || 0 };
    });
    return { type: "album", name: d.name, tracks };
  }

  return null;
}

// ─── Spotify Recommendations ──────────────────────────────────────────────
/**
 * Get track recommendations from Spotify based on seed tracks
 * Returns array of recommended tracks with { id, name, artists, uri }
 */
async function getSpotifyRecommendations(spotifyTrackIds, limit = 5) {
  try {
    const token = await getSpotifyToken();
    const headers = { Authorization: `Bearer ${token}` };

    if (!Array.isArray(spotifyTrackIds)) spotifyTrackIds = [spotifyTrackIds];
    
    // Limit to 5 seed tracks (Spotify API limitation)
    const seedIds = spotifyTrackIds.slice(0, 5).join(",");
    if (!seedIds) return [];

    const url = `https://api.spotify.com/v1/recommendations?seed_tracks=${seedIds}&limit=${limit}`;
    const res = await fetch(url, { headers });

    if (!res.ok) {
      console.error(`[Spotify] Recommendations API error (${res.status})`);
      return [];
    }

    const data = await res.json();
    return data.tracks || [];
  } catch (err) {
    console.error("[Spotify] Recommendations fetch error:", err.message);
    return [];
  }
}

/**
 * Extract Spotify track ID from URI or URL
 */
function extractSpotifyId(spotifyUri) {
  if (!spotifyUri) return null;
  const match = spotifyUri.match(/spotify:track:([a-zA-Z0-9]+)|\/track\/([a-zA-Z0-9]+)/);
  return match ? (match[1] || match[2]) : null;
}

// ─── Voice channel status ─────────────────────────────────────────────────────

async function setVoiceStatus(client, channelId, status) {
  if (!channelId) return;
  await client.rest
    .put(`/channels/${channelId}/voice-status`, { body: { status } })
    .catch(() => {});
}

async function clearVoiceStatus(client, channelId) {
  if (!channelId) return;
  await client.rest
    .put(`/channels/${channelId}/voice-status`, { body: { status: "" } })
    .catch(() => {});
}

/**
 * Pick the best match from a list of Lavalink search results for a given
 * target duration (ms). Prefers the closest duration within a 5s tolerance;
 * falls back to the top search result if nothing is close enough. This
 * avoids blindly trusting the #1 YouTube Music result, which is frequently
 * a full album, a live version, a sped-up reupload, or otherwise the wrong
 * track — the same duration-matching logic already used for error retries.
 */
function pickBestTrackMatch(tracks, targetDurationMs) {
  if (!tracks?.length) return null;
  if (!targetDurationMs) return tracks[0];

  let best = null;
  let bestDiff = Infinity;
  for (const t of tracks) {
    const diff = Math.abs((t.info?.duration || 0) - targetDurationMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = t;
    }
  }

  return bestDiff <= 5000 ? best : tracks[0];
}

module.exports = {
  formatDuration,
  progressBar,
  getSpotifyToken,
  resolveSpotify,
  pickBestTrackMatch,
  getSpotifyRecommendations,
  extractSpotifyId,
  setVoiceStatus,
  clearVoiceStatus,
};
