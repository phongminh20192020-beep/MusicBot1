"use strict";

const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { formatDuration, resolveSpotify } = require("../utils/helpers");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("playnow")
    .setDescription("Immediately play a track, skipping the current one")
    .addStringOption(o =>
      o.setName("query").setDescription("Song name, YouTube URL, or Spotify track URL").setRequired(true)
    ),

  async execute(interaction, client) {
    await interaction.deferReply();

    const voiceChannel = interaction.member.voice?.channel;
    if (!voiceChannel) return interaction.editReply("You must be in a voice channel.");

    const perms = voiceChannel.permissionsFor(interaction.guild.members.me);
    if (!perms.has("Connect") || !perms.has("Speak"))
      return interaction.editReply("I need permission to join and speak in your channel.");

    let player = client.lavalink.getPlayer(interaction.guildId);
    const isNew = !player;

    if (!player) {
      player = client.lavalink.createPlayer({
        guildId:        interaction.guildId,
        voiceChannelId: voiceChannel.id,
        textChannelId:  interaction.channelId,
        selfDeaf:  true,
        selfMute: false,
      });
    }

    if (!player.connected) {
      await player.connect();
      if (isNew) await new Promise(r => setTimeout(r, 1000));
    }

    let query            = interaction.options.getString("query");
    const isSpotifyTrack = /spotify\.com\/track\//.test(query);
    const isUrl          = /^https?:\/\//.test(query);

    // ── Detect if the node has LavaSrc ────────────────────────────────────────
    const nodeInfo   = player.node?.info;
    const hasLavaSrc = nodeInfo?.plugins?.some(p =>
      p.name?.toLowerCase().includes("lavasrc") ||
      p.name?.toLowerCase().includes("spotify")
    ) ?? false;

    if (isSpotifyTrack) {
      if (hasLavaSrc) {
        // Let the node resolve it natively
        const res = await player
          .search({ query, source: "spsearch" }, interaction.user)
          .catch(err => { console.error("[PlayNow] LavaSrc search error:", err.message); return null; });

        if (!res?.tracks?.length || res.loadType === "empty" || res.loadType === "error")
          return interaction.editReply("❌ No results found.");

        const track = res.tracks[0];
        player.queue.tracks.unshift(track);

        if (player.playing || player.paused) {
          await player.skip(0, false).catch(err => console.error("[PlayNow] skip failed:", err.message));
        } else {
          await player.play().catch(err => console.error("[PlayNow] play failed:", err.message));
        }

        return interaction.editReply({
          embeds: [new EmbedBuilder()
            .setColor(0x1db954)
            .setTitle("▶ Playing Now (Spotify)")
            .setDescription(`**[${track.info.title}](${track.info.uri})**`)
            .addFields(
              { name: "Author",   value: track.info.author || "Unknown", inline: true },
              { name: "Duration", value: track.info.isStream ? "🔴 LIVE" : formatDuration(track.info.duration), inline: true }
            )
            .setThumbnail(
          track.info.artworkUrl?.trim() ||
          (track.info.identifier ? `https://img.youtube.com/vi/${track.info.identifier}/mqdefault.jpg` : null)
        )],
        });
      }

      // No LavaSrc — resolve manually
      if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET)
        return interaction.editReply("❌ Spotify credentials are not configured.");
      try {
        const data = await resolveSpotify(query);
        if (!data?.tracks?.[0]) return interaction.editReply("❌ Couldn't resolve that Spotify track.");
        query = data.tracks[0].query;
      } catch (err) {
        console.error("[PlayNow] Spotify resolve error:", err.message);
        return interaction.editReply("❌ Failed to fetch Spotify data. Try again later.");
      }
    }

    const res = await player
      .search(isUrl && !isSpotifyTrack ? { query } : { query, source: "ytmsearch" }, interaction.user)
      .catch(err => { console.error("[PlayNow] search error:", err.message); return null; });

    if (!res?.tracks?.length || res.loadType === "empty" || res.loadType === "error")
      return interaction.editReply("❌ No results found.");

    const track = res.tracks[0];
    player.queue.tracks.unshift(track);

    if (player.playing || player.paused) {
      await player.skip(0, false).catch(err => console.error("[PlayNow] skip failed:", err.message));
    } else {
      await player.play().catch(err => console.error("[PlayNow] play failed:", err.message));
    }

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle("▶ Playing Now")
        .setDescription(`**[${track.info.title}](${track.info.uri})**`)
        .addFields(
          { name: "Author",   value: track.info.author || "Unknown", inline: true },
          { name: "Duration", value: track.info.isStream ? "🔴 LIVE" : formatDuration(track.info.duration), inline: true }
        )
        .setThumbnail(
          track.info.artworkUrl?.trim() ||
          (track.info.identifier ? `https://img.youtube.com/vi/${track.info.identifier}/mqdefault.jpg` : null)
        )],
    });
  },
};
