"use strict";

const { SlashCommandBuilder } = require("discord.js");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const mvStreamer = require("../stream/mvStreamer");

const VIDEOS_DIR = process.env.MV_VIDEOS_DIR || "./videos";
const YTDLP_COOKIES_PATH = process.env.MV_YTDLP_COOKIES_PATH || "";

function ensureVideosDir() {
  if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });
}

/**
 * Downloads a URL into VIDEOS_DIR using yt-dlp (handles YouTube and most
 * other video sites, plus plain direct file links). Returns the resulting
 * filename on success.
 */
function downloadVideo(url, customName) {
  return new Promise((resolve, reject) => {
    ensureVideosDir();

    const outputTemplate = customName
      ? path.join(VIDEOS_DIR, `${customName}.%(ext)s`)
      : path.join(VIDEOS_DIR, "%(title)s.%(ext)s");

    const args = [
      url,
      "-o", outputTemplate,
      "--no-playlist",
      "-f", "mp4/bestvideo+bestaudio/best",
      "--merge-output-format", "mp4",
      "--print", "after_move:filepath",
    ];

    if (YTDLP_COOKIES_PATH && fs.existsSync(YTDLP_COOKIES_PATH)) {
      args.push("--cookies", YTDLP_COOKIES_PATH);
    }

    const proc = spawn("yt-dlp", args);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("error", (err) => reject(new Error(`yt-dlp not available: ${err.message}`)));

    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim().split("\n").pop() || `yt-dlp exited with code ${code}`));
      const filePath = stdout.trim().split("\n").pop();
      if (!filePath || !fs.existsSync(filePath)) return reject(new Error("Download finished but output file wasn't found."));
      resolve(path.basename(filePath));
    });
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("mv")
    .setDescription("Stream a music video into your voice channel")
    .addSubcommand((sub) =>
      sub
        .setName("play")
        .setDescription("Play a music video file")
        .addStringOption((opt) =>
          opt.setName("file").setDescription("Filename in the videos folder").setRequired(true).setAutocomplete(true)
        )
    )
    .addSubcommand((sub) => sub.setName("stop").setDescription("Stop the current MV stream"))
    .addSubcommand((sub) =>
      sub
        .setName("download")
        .setDescription("Download a video (YouTube or direct link) into the videos folder")
        .addStringOption((opt) =>
          opt.setName("url").setDescription("YouTube URL or direct video link").setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName("name").setDescription("Optional filename to save as (no extension)").setRequired(false)
        )
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    let files = [];
    try {
      files = fs.readdirSync(VIDEOS_DIR).filter((f) => /\.(mp4|mkv|webm|mov)$/i.test(f));
    } catch { /* dir may not exist yet */ }

    const filtered = files.filter((f) => f.toLowerCase().includes(focused)).slice(0, 25);
    await interaction.respond(filtered.map((f) => ({ name: f, value: f })));
  },

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();

    if (sub === "download") {
      const url = interaction.options.getString("url");
      const name = interaction.options.getString("name");

      // Basic sanity check — must be an http(s) URL
      if (!/^https?:\/\//i.test(url)) {
        return interaction.reply({ content: "That doesn't look like a valid URL.", ephemeral: true });
      }

      await interaction.deferReply();
      await interaction.editReply(`⬇️ Downloading from \`${url}\`... this can take a bit for longer videos.`);

      try {
        const filename = await downloadVideo(url, name);
        await interaction.editReply(`✅ Saved as \`${filename}\`. Use \`/mv play\` and pick it from the list.`);
      } catch (err) {
        console.error("[mv download] failed:", err.message);
        const hint = /sign in to confirm/i.test(err.message)
          ? "\n💡 YouTube is blocking this server's IP. Set `MV_YTDLP_COOKIES_PATH` to a cookies file (see bot owner)."
          : "";
        await interaction.editReply(`❌ Download failed: ${err.message}${hint}`);
      }
      return;
    }

    if (!mvStreamer.isReady()) {
      return interaction.reply({
        content: "MV streaming isn't configured (missing `STREAM_USER_TOKEN`). Ask the bot owner to set it up.",
        ephemeral: true,
      });
    }

    if (sub === "stop") {
      await interaction.deferReply();
      await mvStreamer.stopMV();
      return interaction.editReply("⏹️ Stopped the MV stream.");
    }

    // sub === "play"
    const voiceChannel = interaction.member.voice?.channel;
    if (!voiceChannel) return interaction.reply({ content: "Join a voice channel first.", ephemeral: true });

    const filename = interaction.options.getString("file");
    const filePath = path.join(VIDEOS_DIR, filename);

    if (!fs.existsSync(filePath)) {
      return interaction.reply({ content: `Couldn't find \`${filename}\` in the videos folder.`, ephemeral: true });
    }

    await interaction.deferReply();
    await interaction.editReply(`🎬 Starting **${filename}** in **${voiceChannel.name}**...`);

    mvStreamer.playMV(interaction.guildId, voiceChannel.id, filePath).catch((err) => {
      console.error("[mv] playMV failed:", err.message);
      interaction.followUp(`⚠️ Streaming failed: ${err.message}`).catch(() => {});
    });
  },
};
