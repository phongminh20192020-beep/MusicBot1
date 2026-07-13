"use strict";

const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join your voice channel"),

  async execute(interaction, client) {
    await interaction.deferReply();

    const voiceChannel = interaction.member.voice?.channel;
    if (!voiceChannel) return interaction.editReply("You must be in a voice channel.");

    const perms = voiceChannel.permissionsFor(interaction.guild.members.me);
    if (!perms.has("Connect") || !perms.has("Speak"))
      return interaction.editReply("I need permission to join and speak in your channel.");

    let player = client.lavalink.getPlayer(interaction.guildId);
    if (!player) {
      player = client.lavalink.createPlayer({
        guildId:        interaction.guildId,
        voiceChannelId: voiceChannel.id,
        textChannelId:  interaction.channelId,
        selfDeaf:  true,
        selfMute: false,
      });
    }

    if (player.connected)
      return interaction.editReply(`Already in **${voiceChannel.name}**.`);

    await player.connect();
    await interaction.editReply(`Joined **${voiceChannel.name}** ✅`);
  },
};
