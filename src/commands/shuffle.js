"use strict";

const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("shuffle")
    .setDescription("Shuffle the current queue"),

  async execute(interaction, client) {
    await interaction.deferReply();

    const player = client.lavalink.getPlayer(interaction.guildId);
    if (!player || !player.queue.current)
      return interaction.editReply("Nothing is currently playing.");

    if (!player.queue.tracks.length)
      return interaction.editReply("The queue only has the current track — nothing to shuffle.");

    const count = await player.queue.shuffle();
    await interaction.editReply(`🔀 Shuffled **${count}** track${count !== 1 ? "s" : ""} in the queue.`);
  },
};
