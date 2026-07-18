"use strict";

// ── Track version keywords for relevance scoring ──
// Used by dashboard server.js to penalize/bonus search results

const PENALTY_WORDS = [
  "softer", "acoustic", "remix", "cover", "live",
  "8d", "slowed", "reverb", "nightcore", "tiktok",
  "edit", "extended", "radio", "bootleg", "mashup",
  "instrumental", "karaoke", "sped up", "slowed down",
  "1 hour", "10 hours", "loop", "reaction", "lyrics",
  "chipmunk", "bass boosted", "clean", "dirty",
  "pitch", "tempo", "vaporwave", "phonk", " slowed ",
  " reverb ", " 8d ", " sped ", " pitched ", " chopped ",
  " screwed ", " chopped and screwed",
];

const BONUS_WORDS = [
  "official", "original", "mv", "music video", "audio",
  "studio", "album version", "standard", "explicit",
];

module.exports = { PENALTY_WORDS, BONUS_WORDS };
