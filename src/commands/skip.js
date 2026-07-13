"use strict";

const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current track"),

  async execute(interaction, client) {
    await interaction.deferReply();

    const player = client.lavalink.getPlayer(interaction.guildId);
    if (!player || !player.playing)
      return interaction.editReply("Nothing is currently playing.");

    const current = player.queue.current;
    await player.skip();
    await interaction.editReply(`Skipped **${current?.info?.title || "the current track"}** ⏭`);
  },
};
