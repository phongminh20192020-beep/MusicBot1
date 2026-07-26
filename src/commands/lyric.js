const { SlashCommandBuilder, EmbedBuilder, escapeMarkdown } = require("discord.js");
const { getLyrics, resolveArtistTitle } = require("../utils/lyrics");

// guildId -> { interval, trackKey, message }
// Keeps track of the one live session per guild so a re-run (or a track
// change) cleanly replaces the previous one instead of stacking timers.
const liveSessions = new Map();

function trackKeyOf(track) {
  return track ? `${track.info.identifier || track.info.uri || track.info.title}` : null;
}

function findLineIndex(lines, positionMs) {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= positionMs) idx = i;
    else break;
  }
  return idx;
}

function renderWindow(lines, idx) {
  const WINDOW_BEFORE = 4;
  const WINDOW_AFTER = 4;
  const start = Math.max(0, idx - WINDOW_BEFORE);
  const end = Math.min(lines.length, idx + WINDOW_AFTER + 1);

  let out = "";
  for (let i = start; i < end; i++) {
    const text = escapeMarkdown(lines[i].text || "♪");
    out += i === idx ? `**▶ ${text}**\n` : `${text}\n`;
  }
  return out.trim() || "*(instrumental)*";
}

function stopSession(guildId) {
  const session = liveSessions.get(guildId);
  if (session) {
    clearInterval(session.interval);
    liveSessions.delete(guildId);
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lyric")
    .setDescription("Show live, time-synced lyrics for what's currently playing"),

  async execute(interaction, client) {
    await interaction.deferReply();

    const player = client.lavalink.getPlayer(interaction.guildId);
    if (!player || !player.queue.current) {
      return interaction.editReply("Nothing is playing right now.");
    }

    const track = player.queue.current;
    const { artist, title } = resolveArtistTitle(track);
    const durationSec = track.info.duration ? track.info.duration / 1000 : undefined;

    const { synced, plain } = await getLyrics(artist, title, durationSec);

    if (!synced || synced.length < 2) {
      // No timestamp data available anywhere — fall back to a static dump,
      // same behavior as /lyrics, rather than failing outright.
      const text = plain;
      if (!text) {
        return interaction.editReply(`Could not find lyrics for **${artist ? `${artist} — ` : ""}${title}**.`);
      }
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xC4A484)
            .setTitle(`🎵 ${artist ? `${artist} — ` : ""}${title}`)
            .setDescription(text.slice(0, 4000))
            .setFooter({ text: "Live sync unavailable for this track — showing full lyrics." }),
        ],
      });
    }

    // Replace any previous live session running in this guild.
    stopSession(interaction.guildId);

    const key = trackKeyOf(track);
    let lastIndex = findLineIndex(synced, player.position || 0);

    const embed = () =>
      new EmbedBuilder()
        .setColor(0xC4A484)
        .setTitle(`🎤 ${artist ? `${artist} — ` : ""}${title}`)
        .setDescription(renderWindow(synced, lastIndex))
        .setFooter({ text: "Synced via LRCLIB · updates live" });

    const message = await interaction.editReply({ embeds: [embed()] });

    const interval = setInterval(async () => {
      const currentPlayer = client.lavalink.getPlayer(interaction.guildId);

      // Track changed, player died, or bot left — stop cleanly.
      if (!currentPlayer || !currentPlayer.queue.current || trackKeyOf(currentPlayer.queue.current) !== key) {
        return stopSession(interaction.guildId);
      }
      if (currentPlayer.paused) return; // don't advance while paused

      const idx = findLineIndex(synced, currentPlayer.position || 0);
      if (idx === lastIndex) return;
      lastIndex = idx;

      try {
        await message.edit({ embeds: [embed()] });
      } catch {
        stopSession(interaction.guildId); // message deleted or channel gone
      }
    }, 1000);

    liveSessions.set(interaction.guildId, { interval, trackKey: key, message });

    // Safety net: auto-stop shortly after the track should have ended,
    // in case the queueEnd/trackStart events don't fire as expected.
    const safetyMs = (track.info.duration || 5 * 60 * 1000) + 10_000;
    setTimeout(() => {
      const session = liveSessions.get(interaction.guildId);
      if (session && session.trackKey === key) stopSession(interaction.guildId);
    }, safetyMs);
  },
};
