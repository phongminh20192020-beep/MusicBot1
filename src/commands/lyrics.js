const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const https = require("https");

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
      const track = player.queue.current;
      title = track.info.title.replace(/\(.*?\)|\[.*?\]/g, "").trim();
      artist = track.info.author.replace(/\s*-\s*Topic$/, "").trim();
    }

    let lyrics;
    try {
      lyrics = await fetchLyrics(artist, title);
    } catch (err) {
      return interaction.editReply(`Could not find lyrics for **${artist ? `${artist} — ` : ""}${title}**.`);
    }

    const MAX = 4000;
    if (lyrics.length <= MAX) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle(`🎵 ${artist ? `${artist} — ` : ""}${title}`)
            .setDescription(lyrics),
        ],
      });
    }

    const chunks = splitLyrics(lyrics, MAX);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xff0000)
          .setTitle(`🎵 ${artist ? `${artist} — ` : ""}${title}`)
          .setDescription(chunks[0])
          .setFooter({ text: `Page 1 of ${chunks.length}` }),
      ],
    });

    for (let i = 1; i < Math.min(chunks.length, 3); i++) {
      await interaction.followUp({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff0000)
            .setDescription(chunks[i])
            .setFooter({ text: `Page ${i + 1} of ${chunks.length}` }),
        ],
      });
    }
  },
};

function fetchLyrics(artist, title) {
  return new Promise((resolve, reject) => {
    const slug = (str) => encodeURIComponent(str.replace(/[^\w\s'-]/gi, "").trim());
    const path = artist
      ? `/v1/${slug(artist)}/${slug(title)}`
      : `/v1/unknown/${slug(title)}`;

    const options = {
      hostname: "api.lyrics.ovh",
      path,
      method: "GET",
      headers: { "User-Agent": "DiscordMusicBot/1.0" },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("Not found"));
        try {
          const json = JSON.parse(data);
          if (json.lyrics) resolve(json.lyrics.trim());
          else reject(new Error("No lyrics field"));
        } catch {
          reject(new Error("Parse error"));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

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
