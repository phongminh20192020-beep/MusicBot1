"use strict";

const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Set the playback volume (0–100)")
    .addIntegerOption(o =>
      o.setName("level")
        .setDescription("Volume level (0–100)")
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(100)
    ),

  async execute(interaction, client) {
    await interaction.deferReply();

    const player = client.lavalink.getPlayer(interaction.guildId);
    if (!player) return interaction.editReply("No active player.");

    const level  = interaction.options.getInteger("level");
    await player.setVolume(level);

    const filled = Math.round(level / 10);
    const bar    = "▰".repeat(filled) + "▱".repeat(10 - filled);
    await interaction.editReply(`Volume set to **${level}%** ${bar}`);
  },
};
