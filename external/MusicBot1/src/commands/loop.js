"use strict";

const { SlashCommandBuilder } = require("discord.js");

const LABELS = {
  off:   "✖ Off",
  track: "🔂 Track",
  queue: "🔁 Queue",
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Set the loop mode")
    .addStringOption(o =>
      o.setName("mode")
        .setDescription("Loop mode")
        .setRequired(true)
        .addChoices(
          { name: "Off",   value: "off"   },
          { name: "Track", value: "track" },
          { name: "Queue", value: "queue" },
        )
    ),

  async execute(interaction, client) {
    await interaction.deferReply();

    const player = client.lavalink.getPlayer(interaction.guildId);
    if (!player || !player.queue.current)
      return interaction.editReply("Nothing is currently playing.");

    const mode = interaction.options.getString("mode");
    await player.setRepeatMode(mode);

    await interaction.editReply(`Loop mode set to **${LABELS[mode]}**.`);
  },
};
