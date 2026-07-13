"use strict";

const { SlashCommandBuilder } = require("discord.js");
const { clearVoiceStatus }    = require("../utils/helpers");
const { saveQueue }           = require("../utils/queueStore");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("disconnect")
    .setDescription("Save the queue, clear and leave the voice channel"),

  async execute(interaction, client) {
    await interaction.deferReply();

    const player = client.lavalink.getPlayer(interaction.guildId);
    if (!player || !player.connected)
      return interaction.editReply("I'm not in a voice channel.");

    const current    = player.queue.current;
    const trackCount = (current ? 1 : 0) + player.queue.tracks.length;

    // Reset AFK mode
    player.set("afk", false);

    // Save queue to disk before destroying
    if (trackCount > 0) saveQueue(player);

    await clearVoiceStatus(client, player.voiceChannelId);
    await player.destroy();

    await interaction.editReply(
      trackCount > 0
        ? `Disconnected ✅ — saved **${trackCount}** track${trackCount !== 1 ? "s" : ""} to queue. Use /restore to restore.`
        : "Disconnected and cleared the queue ✅"
    );
  },
};
