const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { getLyrics, resolveArtistTitle } = require("../utils/lyrics");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lyrics")
    .setDescription("Get lyrics for the current or a specific track")
    .addStringOption((o) =>
      o.setName("query").setDescription("Song name (defaults to current track)").setRequired(false)
    ),

  async execute(interaction, client) {
    await interaction.deferReply();

    let title, artist;

    const query = interaction.options.getString("query");
    if (query) {
      const parts = query.split(" - ");
      if (parts.length >= 2) {
        artist = parts[0].trim();
        title = parts.slice(1).join(" - ").trim();
      } else {
        title = query.trim();
        artist = "";
      }
    } else {
      const player = client.lavalink.getPlayer(interaction.guildId);
      if (!player || !player.queue.current)
        return interaction.editReply("Nothing is playing and no query was provided.");
      ({ artist, title } = resolveArtistTitle(player.queue.current));
    }

    const { plain, synced } = await getLyrics(artist, title);
    const lyrics = plain || (synced ? synced.map((l) => l.text).join("\n") : null);
    if (!lyrics) {
      return interaction.editReply(`Could not find lyrics for **${artist ? `${artist} — ` : ""}${title}**.`);
    }

    const MAX = 4000;
    if (lyrics.length <= MAX) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xC4A484)
            .setTitle(`🎵 ${artist ? `${artist} — ` : ""}${title}`)
            .setDescription(lyrics),
        ],
      });
    }

    const chunks = splitLyrics(lyrics, MAX);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xC4A484)
          .setTitle(`🎵 ${artist ? `${artist} — ` : ""}${title}`)
          .setDescription(chunks[0])
          .setFooter({ text: `Page 1 of ${chunks.length}` }),
      ],
    });

    for (let i = 1; i < Math.min(chunks.length, 3); i++) {
      await interaction.followUp({
        embeds: [
          new EmbedBuilder()
            .setColor(0xC4A484)
            .setDescription(chunks[i])
            .setFooter({ text: `Page ${i + 1} of ${chunks.length}` }),
        ],
      });
    }
  },
};

function splitLyrics(text, maxLen) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + "\n" + line).length > maxLen) {
      if (current) chunks.push(current.trim());
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
