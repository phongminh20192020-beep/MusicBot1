"use strict";

const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { loadQueue, deleteQueue }            = require("../utils/queueStore");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("restore")
    .setDescription("Restore the previously saved queue"),

  async execute(interaction, client) {
    await interaction.deferReply();

    const voiceChannel = interaction.member.voice?.channel;
    if (!voiceChannel)
      return interaction.editReply("You must be in a voice channel.");

    const perms = voiceChannel.permissionsFor(interaction.guild.members.me);
    if (!perms.has("Connect") || !perms.has("Speak"))
      return interaction.editReply("I need permission to join and speak in your channel.");

    const saved = loadQueue(interaction.guildId);
    if (!saved)
      return interaction.editReply("❌ No saved queue found for this server. Queues expire after 3 days.");

    let player = client.lavalink.getPlayer(interaction.guildId);
    const isNew = !player;

    if (!player) {
      player = client.lavalink.createPlayer({
        guildId:        interaction.guildId,
        voiceChannelId: voiceChannel.id,
        textChannelId:  interaction.channelId,
        selfDeaf:       true,
        selfMute:       false,
      });
    }

    if (!player.connected) {
      await player.connect();
      if (isNew) await new Promise(r => setTimeout(r, 1000));
    }

    // Restore volume + repeat mode
    if (saved.volume     !== undefined) await player.setVolume(saved.volume).catch(() => {});
    if (saved.repeatMode !== undefined) player.repeatMode = saved.repeatMode;

    // Add current track first, then the rest
    const allTracks = [
      ...(saved.current ? [saved.current] : []),
      ...saved.tracks,
    ];

    for (const t of allTracks) player.queue.add(t);

    deleteQueue(interaction.guildId);

    await player.play().catch(err => console.error("[Restore] play() error:", err.message));

    const savedDate = new Date(saved.savedAt).toLocaleString();

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x1db954)
          .setTitle("✅ Queue Restored")
          .setDescription(
            `Restored **${allTracks.length}** track${allTracks.length !== 1 ? "s" : ""}.\n` +
            `Starting with **${allTracks[0]?.info?.title || "Unknown"}**`
          )
          .addFields({ name: "Originally saved", value: savedDate, inline: true })
          .setFooter({ text: "Use /loop to restore your loop mode if needed." }),
      ],
    });
  },
};
