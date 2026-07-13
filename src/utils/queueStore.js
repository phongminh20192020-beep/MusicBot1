"use strict";

const fs   = require("fs");
const path = require("path");

const STORE_DIR  = path.join(__dirname, "../../data/queues");
const TTL_MS     = 3 * 24 * 60 * 60 * 1000; // 3 days in ms

// Ensure the data directory exists
if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });

function filePath(guildId) {
  return path.join(STORE_DIR, `${guildId}.json`);
}

/**
 * Save the current queue for a guild.
 * Stores: current track, upcoming tracks, repeat mode, volume, timestamp.
 */
function saveQueue(player) {
  try {
    const current = player.queue.current;
    const tracks  = player.queue.tracks;

    // Nothing worth saving
    if (!current && !tracks.length) return;

    const data = {
      savedAt:    Date.now(),
      repeatMode: player.repeatMode ?? 0,
      volume:     player.volume     ?? 100,
      current:    current  ? serializeTrack(current)  : null,
      tracks:     tracks.map(serializeTrack),
    };

    fs.writeFileSync(filePath(player.guildId), JSON.stringify(data, null, 2));
    console.log(`[QueueStore] Saved ${tracks.length + (current ? 1 : 0)} tracks for guild ${player.guildId}`);
  } catch (err) {
    console.error("[QueueStore] Failed to save queue:", err.message);
  }
}

/**
 * Load a saved queue for a guild.
 * Returns null if no save exists or it has expired.
 */
function loadQueue(guildId) {
  try {
    const fp = filePath(guildId);
    if (!fs.existsSync(fp)) return null;

    const data = JSON.parse(fs.readFileSync(fp, "utf8"));

    // Check TTL
    if (Date.now() - data.savedAt > TTL_MS) {
      fs.unlinkSync(fp);
      console.log(`[QueueStore] Expired queue deleted for guild ${guildId}`);
      return null;
    }

    return data;
  } catch (err) {
    console.error("[QueueStore] Failed to load queue:", err.message);
    return null;
  }
}

/**
 * Delete a saved queue for a guild.
 */
function deleteQueue(guildId) {
  try {
    const fp = filePath(guildId);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (err) {
    console.error("[QueueStore] Failed to delete queue:", err.message);
  }
}

/**
 * Purge all saved queues older than TTL. Call this on bot startup.
 */
function purgeExpired() {
  try {
    const files = fs.readdirSync(STORE_DIR).filter(f => f.endsWith(".json"));
    let purged  = 0;
    for (const file of files) {
      const fp   = path.join(STORE_DIR, file);
      const data = JSON.parse(fs.readFileSync(fp, "utf8"));
      if (Date.now() - data.savedAt > TTL_MS) {
        fs.unlinkSync(fp);
        purged++;
      }
    }
    if (purged) console.log(`[QueueStore] Purged ${purged} expired queue(s) on startup`);
  } catch (err) {
    console.error("[QueueStore] Purge error:", err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function serializeTrack(track) {
  return {
    encoded:  track.encoded,
    info:     track.info,
    userData: track.userData ?? {},
    // Store requester as plain object so it survives JSON round-trip
    requester: track.requester
      ? { id: track.requester.id, username: track.requester.username, globalName: track.requester.globalName }
      : null,
  };
}

module.exports = { saveQueue, loadQueue, deleteQueue, purgeExpired };
