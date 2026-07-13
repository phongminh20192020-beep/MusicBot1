"use strict";

/**
 * MV (video) streaming module.
 *
 * IMPORTANT: Discord's official Bot API blocks bots from sending video/camera
 * data — only real user connections can "Go Live". Because of that, this
 * module logs in a SECOND, separate client using discord.js-selfbot-v13 and
 * a real Discord user account token (STREAM_USER_TOKEN), completely apart
 * from your normal bot (DISCORD_TOKEN). Your slash commands still go through
 * your normal bot; this module is only invoked internally to do the actual
 * broadcast.
 *
 * Running a self-bot is against Discord's Terms of Service and the account
 * used for STREAM_USER_TOKEN can be disabled for it. Use a throwaway/alt
 * account you don't mind losing — never your main account.
 */

const fs = require("fs");
const path = require("path");

let Streamer, prepareStream, playStream, Utils, SelfbotClient;
let streamer = null;
let ready = false;
let activeCommand = null; // current ffmpeg command, so we can stop it

function loadDeps() {
  ({ Streamer, prepareStream, playStream, Utils } = require("@dank074/discord-video-stream"));
  ({ Client: SelfbotClient } = require("discord.js-selfbot-v13"));
}

async function init() {
  const token = process.env.STREAM_USER_TOKEN;
  if (!token) {
    console.warn("[MVStream] STREAM_USER_TOKEN not set — /mv commands will be disabled.");
    return;
  }

  loadDeps();
  streamer = new Streamer(new SelfbotClient());

  streamer.client.once("ready", () => {
    ready = true;
    console.log(`[MVStream] Self-bot logged in as ${streamer.client.user.tag} ✅`);
  });

  streamer.client.on("error", (err) => console.error("[MVStream] Client error:", err.message));

  await streamer.client.login(token);
}

function isReady() {
  return ready;
}

async function playMV(guildId, voiceChannelId, filePath) {
  if (!ready) throw new Error("MV streaming isn't set up (STREAM_USER_TOKEN missing or not logged in yet).");
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  await stopMV(); // only one stream at a time for this self-bot connection

  await streamer.joinVoice(guildId, voiceChannelId);

  const { command, output } = prepareStream(filePath, {
    height: parseInt(process.env.MV_STREAM_HEIGHT || "1080"),
    frameRate: parseInt(process.env.MV_STREAM_FPS || "30"),
    bitrateVideo: parseInt(process.env.MV_STREAM_BITRATE || "5000"),
    bitrateVideoMax: parseInt(process.env.MV_STREAM_BITRATE_MAX || "7500"),
    videoCodec: Utils.normalizeVideoCodec(process.env.MV_STREAM_CODEC || "H264"),
    h26xPreset: process.env.MV_STREAM_PRESET || "veryfast",
  });

  activeCommand = command;
  command.on("error", (err, stdout, stderr) => {
    console.error("[MVStream] ffmpeg error:", err.message);
  });

  // playStream resolves when playback finishes (or is stopped)
  const donePromise = playStream(output, streamer, { type: "go-live" })
    .then(() => console.log("[MVStream] Playback finished."))
    .catch((e) => console.error("[MVStream] Playback error:", e.message))
    .finally(() => { activeCommand = null; });

  return donePromise;
}

async function stopMV() {
  if (activeCommand) {
    try { activeCommand.kill("SIGKILL"); } catch { /* already dead */ }
    activeCommand = null;
  }
  if (streamer?.voiceConnection) {
    try { await streamer.leaveVoice(); } catch { /* ignore */ }
  }
}

module.exports = { init, isReady, playMV, stopMV };
