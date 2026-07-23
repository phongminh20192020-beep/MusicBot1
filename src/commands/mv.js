"use strict";

const { SlashCommandBuilder } = require("discord.js");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const mvStreamer = require("../stream/mvStreamer");

const VIDEOS_DIR = process.env.MV_VIDEOS_DIR || "./videos";
// Reuse the same cookies file Lavalink's YouTube plugin already uses
// (lavalink/cookies.txt) unless a different path is explicitly configured --
// otherwise yt-dlp has nothing and YouTube blocks the server as a bot.
const DEFAULT_YTDLP_COOKIES_PATH = path.join(__dirname, "..", "..", "lavalink", "cookies.txt");
const YTDLP_COOKIES_PATH = process.env.MV_YTDLP_COOKIES_PATH || DEFAULT_YTDLP_COOKIES_PATH;
// No point downloading higher than this — prepareStream() re-encodes down to
// MV_STREAM_HEIGHT anyway, so pulling a 4K/8K source just wastes minutes.
const MAX_DOWNLOAD_HEIGHT = parseInt(process.env.MV_DOWNLOAD_MAX_HEIGHT || "1080", 10);

function ensureVideosDir() {
  if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });
}

const PROGRESS_LINE_RE = /\[download\]\s+([\d.]+)% of\s+~?([\d.]+\w+)(?:\s+at\s+([\d.]+\w+\/s|Unknown speed))?(?:\s+ETA\s+(\S+))?/;

/**
 * Downloads a URL into VIDEOS_DIR using yt-dlp (handles YouTube and most
 * other video sites, plus plain direct file links). Returns the resulting
 * filename on success. Calls onProgress(text) as yt-dlp reports download
 * progress, so callers can surface live feedback instead of a silent wait.
 */
function downloadVideo(url, customName, onProgress) {
  return new Promise((resolve, reject) => {
    ensureVideosDir();

    const outputTemplate = customName
      ? path.join(VIDEOS_DIR, `${customName}.%(ext)s`)
      : path.join(VIDEOS_DIR, "%(title)s.%(ext)s");

    const heightFilter = `[height<=${MAX_DOWNLOAD_HEIGHT}]`;
    const args = [
      url,
      "-o", outputTemplate,
      "--no-playlist",
      "--newline", // one progress line per update instead of \r-overwriting (needed since stdout isn't a TTY here)
      "-f", `bv*${heightFilter}+ba/b${heightFilter}/best`,
      "--merge-output-format", "mp4",
      "--print", "after_move:filepath",
    ];

    if (YTDLP_COOKIES_PATH && fs.existsSync(YTDLP_COOKIES_PATH)) {
      args.push("--cookies", YTDLP_COOKIES_PATH);
    }

    const proc = spawn("yt-dlp", args);

    let stdout = "";
    let stderr = "";
    let leftover = "";

    proc.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;

      leftover += chunk;
      const lines = leftover.split("\n");
      leftover = lines.pop(); // keep any partial last line for the next chunk
      for (const line of lines) {
        const m = line.match(PROGRESS_LINE_RE);
        if (m && onProgress) {
          const [, pct, size, speed, eta] = m;
          onProgress(`${pct}% of ${size}` + (speed ? ` at ${speed}` : "") + (eta ? ` (ETA ${eta})` : ""));
        } else if (/\[Merger\]|Merging formats/.test(line) && onProgress) {
          onProgress("Merging video + audio...");
        }
      }
    });
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

      let lastEdit = 0;
      const reportProgress = (text) => {
        const now = Date.now();
        if (now - lastEdit < 3000) return; // Discord webhook edits: stay well under the rate limit
        lastEdit = now;
        interaction.editReply(`⬇️ Downloading from \`${url}\`...\n${text}`).catch(() => {});
      };

      try {
        const filename = await downloadVideo(url, name, reportProgress);
        await interaction.editReply(`✅ Saved as \`${filename}\`. Use \`/mv play\` and pick it from the list.`);
      } catch (err) {
        console.error("[mv download] failed:", err.message);
        let hint = "";
        if (/sign in to confirm/i.test(err.message)) {
          hint = fs.existsSync(YTDLP_COOKIES_PATH)
            ? `\n💡 Already using cookies from \`${YTDLP_COOKIES_PATH}\`, but YouTube rejected them anyway — they're likely expired/invalidated. Re-export a fresh cookies.txt and replace that file.`
            : `\n💡 YouTube is blocking this server's IP and no cookies file was found at \`${YTDLP_COOKIES_PATH}\`. Add one there, or set \`MV_YTDLP_COOKIES_PATH\` to point elsewhere.`;
        }
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
    await interaction.editReply(`🎬 Preparing **${filename}**... joining **${voiceChannel.name}**.`);

    mvStreamer.playMV(interaction.guildId, voiceChannel.id, filePath, () => {
      interaction.editReply(`📡 Live in **${voiceChannel.name}** — playing **${filename}**.`).catch(() => {});
    }).catch((err) => {
      console.error("[mv] playMV failed:", err.message);
      interaction.followUp(`⚠️ Streaming failed: ${err.message}`).catch(() => {});
    });
  },
};
