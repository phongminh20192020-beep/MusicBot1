"use strict";

const { SlashCommandBuilder } = require("discord.js");
const { clearVoiceStatus }    = require("../utils/helpers");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("afk")
    .setDescription("Stop music and keep the bot in the voice channel indefinitely"),

  async execute(interaction, client) {
    await interaction.deferReply();

    const voiceChannel = interaction.member.voice?.channel;
    if (!voiceChannel)
      return interaction.editReply("You must be in a voice channel.");

    let player = client.lavalink.getPlayer(interaction.guildId);

    if (!player) {
      player = client.lavalink.createPlayer({
        guildId:        interaction.guildId,
        voiceChannelId: voiceChannel.id,
        textChannelId:  interaction.channelId,
        selfDeaf:       true,
        selfMute:       false,
      });
      await player.connect();
    }

    if (player.playing || player.paused)
      await player.stopPlaying(true).catch(() => {});

    await clearVoiceStatus(client, player.voiceChannelId);

    player.set("afk", true);
    player.set("autoplay", false);

    await interaction.editReply("💤 AFK mode active — staying in the channel. Use `/disconnect` to leave or `/play` to resume music.");
  },
};
