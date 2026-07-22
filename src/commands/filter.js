"use strict";

const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("filter")
    .setDescription("Apply an audio filter or reset all filters")
    .addStringOption(o =>
      o.setName("preset")
        .setDescription("Filter preset to apply")
        .setRequired(true)
        .addChoices(
          { name: "Bass Boost",  value: "bassboost" },
          { name: "Nightcore",   value: "nightcore" },
          { name: "Vaporwave",   value: "vaporwave" },
          { name: "Slowed",      value: "slowed"    },
          { name: "8D Audio",    value: "8d"        },
          { name: "Karaoke",     value: "karaoke"   },
          { name: "Tremolo",     value: "tremolo"   },
          { name: "Vibrato",     value: "vibrato"   },
          { name: "Low Pass",    value: "lowpass"   },
          { name: "Pop",         value: "pop"       },
          { name: "Off (Reset)", value: "off"       },
        )
    ),

  async execute(interaction, client) {
    await interaction.deferReply();

    const player = client.lavalink.getPlayer(interaction.guildId);
    if (!player || !player.queue.current)
      return interaction.editReply("Nothing is currently playing.");

    const fm     = player.filterManager;
    const preset = interaction.options.getString("preset");

    try {
      await fm.resetFilters();

      switch (preset) {
        case "bassboost": await fm.setEQPreset("BassboostMedium"); break;
        case "nightcore": await fm.toggleNightcore();              break;
        case "vaporwave": await fm.toggleVaporwave();              break;
        case "slowed":    await fm.setSpeed(0.80); await fm.setPitch(0.90); break;
        case "8d":        await fm.toggleRotation(0.2);            break;
        case "karaoke":   await fm.toggleKaraoke();                break;
        case "tremolo":   await fm.toggleTremolo();                break;
        case "vibrato":   await fm.toggleVibrato();                break;
        case "lowpass":   await fm.toggleLowPass();                break;
        case "pop":       await fm.setEQPreset("Pop");             break;
        case "off":       return interaction.editReply("✖ All filters have been **reset**.");
      }
    } catch (err) {
      console.error("[Filter] filterManager error:", err.message);
      return interaction.editReply(`❌ Failed to apply filter: ${err.message}`);
    }

    const labels = {
      bassboost: "🔊 Bass Boost", nightcore: "🌙 Nightcore", vaporwave: "🌊 Vaporwave",
      slowed: "🐢 Slowed", "8d": "🎧 8D Audio", karaoke: "🎤 Karaoke",
      tremolo: "〰️ Tremolo", vibrato: "🎵 Vibrato", lowpass: "🔉 Low Pass", pop: "🎵 Pop",
    };

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x8B4513)
          .setTitle("Filter Applied")
          .setDescription(`**${labels[preset]}** is now active.`)
          .setFooter({ text: 'Use "/filter Off (Reset)" to remove all filters.' }),
      ],
    });
  },
};
