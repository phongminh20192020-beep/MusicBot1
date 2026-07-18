"use strict";

// ── Track version keywords for relevance scoring ──
// Used by dashboard server.js to penalize/bonus search results
// Edit this file to add/remove keywords without touching server.js

// ── TIER 1: Highest priority ──
// These get the biggest boost because they indicate the real track
const TIER1_BONUS = [
  "official mv",
  "official music video",
  "official video",
];

// ── TIER 2: High priority ──
const TIER2_BONUS = [
  "official",
  "original",
  "mv",
];

// ── TIER 3: Normal bonus ──
const TIER3_BONUS = [
  "music video",
  "audio",
  "studio",
  "album version",
  "standard",
  "explicit",
];

// Combine for backward compatibility
const BONUS_WORDS = [...TIER1_BONUS, ...TIER2_BONUS, ...TIER3_BONUS];

// ── PENALTY: Deprioritize these versions ──
const PENALTY_WORDS = [
  "softer", "acoustic", "remix", "cover", "live",
  "8d", "slowed", "reverb", "nightcore", "tiktok",
  "edit", "extended", "radio", "bootleg", "mashup",
  "instrumental", "karaoke", "sped up", "slowed down",
  "1 hour", "10 hours", "loop", "reaction", "lyrics",
  "chipmunk", "bass boosted", "clean", "dirty",
  "pitch", "tempo", "vaporwave", "phonk",
  " slowed ", " reverb ", " 8d ", " sped ",
  " pitched ", " chopped ", " screwed ",
  " chopped and screwed",
];

module.exports = { PENALTY_WORDS, BONUS_WORDS, TIER1_BONUS, TIER2_BONUS, TIER3_BONUS };
