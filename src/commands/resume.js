"use strict";

const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume the paused track"),

  async execute(interaction, client) {
    await interaction.deferReply();

    const player = client.lavalink.getPlayer(interaction.guildId);
    if (!player)        return interaction.editReply("No active player.");
    if (!player.paused) return interaction.editReply("Already playing — nothing to resume.");

    await player.resume();
    await interaction.editReply("Resumed ▶️");
  },
};
