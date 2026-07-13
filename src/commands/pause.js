"use strict";

const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause the current track"),

  async execute(interaction, client) {
    await interaction.deferReply();

    const player = client.lavalink.getPlayer(interaction.guildId);
    if (!player || !player.playing)
      return interaction.editReply("Nothing is currently playing.");
    if (player.paused)
      return interaction.editReply("Already paused. Use `/resume` to continue.");

    await player.pause(true);
    await interaction.editReply("Paused ⏸");
  },
};
