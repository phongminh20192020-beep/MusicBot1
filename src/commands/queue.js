"use strict";

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ComponentType,
} = require("discord.js");
const { formatDuration } = require("../utils/helpers");

const PAGE_SIZE = 8;

module.exports = {
  data: new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the current queue"),

  async execute(interaction, client) {
    await interaction.deferReply();

    const player = client.lavalink.getPlayer(interaction.guildId);
    if (!player || !player.queue.current)
      return interaction.editReply("Nothing is currently playing.");

    const current    = player.queue.current;
    const tracks     = player.queue.tracks;
    const totalPages = Math.max(1, Math.ceil(tracks.length / PAGE_SIZE));
    let   page       = 0;

    const buildUpNextValue = p => {
      const slice = tracks.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);
      if (!slice.length) return "Nothing queued.";

      let result = "";
      for (let i = 0; i < slice.length; i++) {
        const t     = slice[i];
        const num   = p * PAGE_SIZE + i + 1;
        const dur   = t.info.isStream ? "🔴 LIVE" : formatDuration(t.info.duration);
        const title = t.info.title.length > 30
          ? t.info.title.slice(0, 29) + "…"
          : t.info.title;
        const line  = `\`${num}.\` **${title}** — ${dur}\n`;
        if (result.length + line.length > 1000) { result += "*...and more*"; break; }
        result += line;
      }
      return result.trim();
    };

    const buildEmbed = p => {
      const currentTitle = current.info.title.length > 40
        ? current.info.title.slice(0, 39) + "…"
        : current.info.title;
      const currentDur   = current.info.isStream
        ? "🔴 LIVE"
        : formatDuration(current.info.duration);

      return new EmbedBuilder()
        .setColor(0xC4A484)
        .setTitle("Queue")
        .addFields(
          {
            name:  "Now Playing",
            value: `**[${currentTitle}](${current.info.uri})** — ${currentDur}`,
          },
          {
            name:  `Up Next — ${tracks.length} track${tracks.length !== 1 ? "s" : ""}`,
            value: buildUpNextValue(p),
          }
        )
        .setFooter({ text: `Page ${p + 1} / ${totalPages}` });
    };

    const buildRow = p =>
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("queue_prev")
          .setLabel("◀ Prev")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(p === 0),
        new ButtonBuilder()
          .setCustomId("queue_next")
          .setLabel("Next ▶")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(p >= totalPages - 1)
      );

    const msg = await interaction.editReply({
      embeds:     [buildEmbed(page)],
      components: totalPages > 1 ? [buildRow(page)] : [],
    });

    if (totalPages <= 1) return;

    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time:          60_000,
      filter:        btn => btn.user.id === interaction.user.id,
    });

    collector.on("collect", async btn => {
      if (btn.customId === "queue_prev") page = Math.max(0, page - 1);
      if (btn.customId === "queue_next") page = Math.min(totalPages - 1, page + 1);
      await btn.update({
        embeds:     [buildEmbed(page)],
        components: [buildRow(page)],
      });
    });

    collector.on("end", () => {
      interaction.editReply({ components: [] }).catch(() => {});
    });
  },
};
