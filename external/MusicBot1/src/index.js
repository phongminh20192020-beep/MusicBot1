"use strict";

const { Client, GatewayIntentBits, Collection, EmbedBuilder } = require("discord.js");
const { LavalinkManager } = require("lavalink-client");
const fs   = require("fs");
const path = require("path");
const { formatDuration, progressBar, resolveSpotify, getSpotifyRecommendations, extractSpotifyId, setVoiceStatus, clearVoiceStatus } = require("./utils/helpers");
const { purgeExpired } = require("./utils/queueStore");
const mvStreamer = require("./stream/mvStreamer");
const { startDashboard } = require("./dashboard/server");

// Purge expired saved queues on startup
purgeExpired();

// Bring up the MV self-bot streaming connection (no-op if STREAM_USER_TOKEN unset)
mvStreamer.init().catch(err => console.error("[MVStream] init failed:", err.message));

// ─── Discord client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

client.commands      = new Collection();
client.npIntervals   = new Map();
client.errorCounts   = new Map();
client.retriedTracks = new Map();

// ─── Load commands ────────────────────────────────────────────────────────────
for (const file of fs.readdirSync(path.join(__dirname, "commands")).filter(f => f.endsWith(".js"))) {
  const cmd = require(path.join(__dirname, "commands", file));
  if (cmd.data && cmd.execute) client.commands.set(cmd.data.name, cmd);
}

// ─── Lavalink ─────────────────────────────────────────────────────────────────
client.lavalink = new LavalinkManager({
  nodes: [
    {
      id:                     "main",
      host:                   process.env.LAVALINK_HOST || "reseau.proxy.rlwy.net",
      port:                   parseInt(process.env.LAVALINK_PORT || "17693"),
      authorization:          process.env.LAVALINK_PASS || "Minh@2013",
      secure:                 false,
      retryAmount:            20,
      retryDelay:             2500,
      requestSignalTimeoutMS: 30000,
      heartBeatInterval:      30000,
      enablePingOnStatsCheck: true,
    },
  ],
  sendToShard: (guildId, payload) => {
    const guild = client.guilds.cache.get(guildId);
    if (guild) guild.shard.send(payload);
  },
  client: {
    id:       process.env.CLIENT_ID,
    username: "MusicBot",
  },
  playerOptions: {
    defaultSearchPlatform:             "ytmsearch",
    onDisconnect:                      { autoReconnect: true, destroyPlayer: false },
    onEmptyQueue:                      { destroyAfterMs: 30000 },
    applyVolumeAsFilter:               false,
    clientBasedPositionUpdateInterval: 100,
  },
  queueOptions:    { maxPreviousTracks: 10 },
  advancedOptions: {
    enableDebugEvents:    true,
    maxFilterFixDuration: 600,
    debugOptions:         { noAudio: { toggleSleepOnInactivity: false } },
  },
});

// ─── Push YouTube OAuth token to youtube-source plugin ───────────────────────
async function pushYouTubeOAuth(node) {
  const token = process.env.YOUTUBE_REFRESH_TOKEN;
  if (!token) {
    console.warn("[Lavalink] YOUTUBE_REFRESH_TOKEN not set — YouTube may fall back to unauthenticated requests.");
    return;
  }
  try {
    const protocol = node.options.secure ? "https" : "http";
    const base     = `${protocol}://${node.options.host}:${node.options.port}`;

    const res = await fetch(`${base}/youtube`, {
      method:  "POST",
      headers: {
        "Authorization": node.options.authorization,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({ refreshToken: token }),
    });

    if (res.status === 204) {
      console.log(`[Lavalink] YouTube OAuth token accepted by node "${node.id}" ✅`);
    } else {
      const text = await res.text();
      console.error(`[Lavalink] YouTube OAuth push failed (${res.status}): ${text}`);
    }
  } catch (err) {
    console.error("[Lavalink] YouTube OAuth push error:", err.message);
  }
}

// ─── Lavalink node events ─────────────────────────────────────────────────────
client.lavalink.nodeManager
  .on("connect", async (node) => {
    console.log(`[Lavalink] Node "${node.id}" connected ✅`);
    await pushYouTubeOAuth(node);
  })
  .on("error",        (node, err)    => console.error(`[Lavalink] Node "${node.id}" error:`, err.message))
  .on("disconnect",   (node, reason) => console.warn(`[Lavalink] Node "${node.id}" disconnected:`, JSON.stringify(reason)))
  .on("reconnecting", (node)         => console.log(`[Lavalink] Node "${node.id}" reconnecting...`));

// ─── Now-playing embed ────────────────────────────────────────────────────────
function buildNowPlayingEmbed(player, track) {
  const pos = player.position;
  const dur = track.info.duration || 0;
  const bar = track.info.isStream || !dur ? "🔴 LIVE" : progressBar(pos, dur);

  const sourceName = track.info.sourceName || "unknown";
  const sourceBadge =
    sourceName === "spotify"      ? "🟢 Spotify"  :
    sourceName === "youtube"      ? "🔴 YouTube"  :
    sourceName === "youtubemusic" ? "🎵 YT Music" :
    `📻 ${sourceName}`;

  return new EmbedBuilder()
    .setColor(sourceName === "spotify" ? 0x1db954 : 0xff0000)
    .setTitle("Now Playing")
    .setDescription(`**[${track.info.title}](${track.info.uri})**`)
    .addFields(
      { name: "Author",       value: track.info.author || "Unknown",                                                       inline: true },
      { name: "Duration",     value: track.info.isStream ? "🔴 LIVE" : `${formatDuration(pos)} / ${formatDuration(dur)}`, inline: true },
      { name: "Requested By", value: track.requester?.username || "Unknown",                                               inline: true },
      { name: "Source",       value: sourceBadge,                                                                          inline: true },
      { name: "Progress",     value: bar }
    )
    .setThumbnail(
      track.info.artworkUrl?.trim() ||
      (track.info.identifier ? `https://img.youtube.com/vi/${track.info.identifier}/mqdefault.jpg` : null)
    );
}

function clearNpInterval(guildId) {
  const iv = client.npIntervals.get(guildId);
  if (iv) { clearInterval(iv); client.npIntervals.delete(guildId); }
}

// ─── Autoplay with Spotify Recommendations ────────────────────────────────────
async function handleAutoplay(player, lastTrack) {
  try {
    const requester = lastTrack.requester || client.user;
    const id = lastTrack.info.identifier;
    const sourceName = lastTrack.info.sourceName || "unknown";
    
    console.log(`[Autoplay] Seeding from: "${lastTrack.info.title}" (id=${id}) source=${sourceName}`);

    let recommendations = [];

    // ─── Try Spotify Recommendations first ─────────────────────────────────────
    if (sourceName === "spotify" && process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
      try {
        const spotifyId = extractSpotifyId(lastTrack.info.uri);
        if (spotifyId) {
          console.log(`[Autoplay] Fetching Spotify recommendations for track ID: ${spotifyId}`);
          const spotifyTracks = await getSpotifyRecommendations(spotifyId, 10);
          
          if (spotifyTracks.length > 0) {
            console.log(`[Autoplay] Got ${spotifyTracks.length} Spotify recommendations`);
            const played = new Set((player.queue.previous || []).map(t => t.info.identifier));
            
            // Search for each recommendation on YouTube/YTMusic
            for (const spotTrack of spotifyTracks) {
              try {
                const query = `${spotTrack.artists?.[0]?.name || ""} ${spotTrack.name}`.trim();
                const res = await player.search({ query, source: "ytmsearch" }, requester);
                
                if (res?.tracks?.[0]) {
                  const track = res.tracks[0];
                  if (!played.has(track.info.identifier)) {
                    recommendations.push(track);
                    played.add(track.info.identifier);
                    if (recommendations.length >= 5) break;
                  }
                }
              } catch (e) {
                console.warn(`[Autoplay] Failed to resolve Spotify recommendation: ${spotTrack.name}`, e.message);
              }
            }
          }
        }
      } catch (err) {
        console.warn("[Autoplay] Spotify recommendations failed:", err.message);
      }
    }

    // ─── Fallback: YouTube Related Videos ──────────────────────────────────────
    if (recommendations.length === 0) {
      console.log(`[Autoplay] Using YouTube fallback for: "${lastTrack.info.title}"`);
      const res = await player.search(
        { query: `https://www.youtube.com/watch?v=${id}&list=RD${id}`, source: "youtube" },
        requester
      );

      if (res?.tracks?.length) {
        const played = new Set((player.queue.previous || []).map(t => t.info.identifier));
        recommendations = res.tracks.filter(t => t.info.identifier !== id && !played.has(t.info.identifier));
      }
    }

    if (!recommendations.length) {
      console.warn("[Autoplay] No recommendations found — queue will end.");
      return;
    }

    console.log(`[Autoplay] Adding ${recommendations.length} tracks to queue`);
    await player.queue.add(recommendations.slice(0, 5));
    if (!player.playing) await player.play();
  } catch (err) {
    console.error("[Autoplay] Error:", err.message);
  }
}

// ─── Track error retry helper ─────────────────────────────────────────────────
async function searchReplacement(player, failedTrack, sources) {
  const query          = `${failedTrack.info.title} ${failedTrack.info.author || ""}`.trim();
  const targetDuration = failedTrack.info.duration || 0;

  for (const source of sources) {
    try {
      const res = await player.search({ query, source }, failedTrack.requester);
      if (!res?.tracks?.length) continue;
      return (
        res.tracks.find(t => Math.abs((t.info.duration || 0) - targetDuration) < 5000) ||
        res.tracks[0]
      );
    } catch (err) {
      console.error(`[Lavalink] Replacement search failed on ${source}:`, err.message);
    }
  }
  return null;
}

// ─── Lavalink player events ───────────────────────────────────────────────────
client.lavalink

  .on("trackStart", async (player, track) => {
    console.log(`[Lavalink] trackStart: "${track.info.title}" source=${track.info.sourceName} guild=${player.guildId}`);
    clearNpInterval(player.guildId);
    client.errorCounts.set(player.guildId, 0);
    client.retriedTracks.delete(player.guildId);

    await setVoiceStatus(client, player.voiceChannelId, `🎵 ${track.info.title}`);

    const channel = client.channels.cache.get(player.textChannelId);
    if (!channel) return;

    let npMsg;
    try { npMsg = await channel.send({ embeds: [buildNowPlayingEmbed(player, track)] }); }
    catch { return; }

    if (!track.info.isStream) {
      const iv = setInterval(async () => {
        const p = client.lavalink.getPlayer(player.guildId);
        if (!p?.queue.current || p.paused) return;
        try { await npMsg.edit({ embeds: [buildNowPlayingEmbed(p, p.queue.current)] }); }
        catch { clearNpInterval(player.guildId); }
      }, 10_000);
      client.npIntervals.set(player.guildId, iv);
    }
  })

  .on("trackEnd", (player) => {
    clearNpInterval(player.guildId);
  })

  .on("trackError", async (player, track, payload) => {
    const guildId = player.guildId;
    const reason  = payload?.exception?.message || payload?.exception?.cause || "Unknown error";
    console.error(`[Lavalink] trackError guild=${guildId}:`, reason);
    clearNpInterval(guildId);

    const channel      = client.channels.cache.get(player.textChannelId);
    const isLoginError = /sign in|login|requires login|bot|cookie|403/i.test(reason);

    const failCount = (client.errorCounts.get(guildId) || 0) + 1;
    client.errorCounts.set(guildId, failCount);
    if (failCount >= 5) {
      client.errorCounts.set(guildId, 0);
      channel?.send("⚠️ Too many tracks failed in a row. Stopping playback.").catch(() => {});
      await player.stopPlaying(true).catch(() => {});
      return;
    }

    const trackKey   = track?.info?.identifier || track?.encoded;
    let   retriedSet = client.retriedTracks.get(guildId);
    if (!retriedSet) { retriedSet = new Set(); client.retriedTracks.set(guildId, retriedSet); }

    if (track && trackKey && !retriedSet.has(trackKey)) {
      retriedSet.add(trackKey);

      if (isLoginError) {
        console.log(`[Lavalink] Login error — retrying "${track.info.title}" via youtube-source fallback`);
        channel?.send(`⚠️ **${track.info.title}** hit a login wall — trying another source...`).catch(() => {});
      }

      const sources     = isLoginError ? ["ytsearch", "ytmsearch"] : ["ytmsearch", "ytsearch"];
      const replacement = await searchReplacement(player, track, sources);

      if (replacement) {
        console.log(`[Lavalink] Replacement found via ${replacement.info.sourceName}`);
        player.queue.tracks.unshift(replacement);
        await player.skip(0, false).catch(err => console.error("[Lavalink] skip-to-retry failed:", err.message));
        return;
      }
    }

    channel?.send(`⚠️ Couldn't play **${track?.info?.title || "that track"}** — skipping.`).catch(() => {});
    await player.skip(0, false).catch(err => {
      console.error("[Lavalink] skip-after-error failed:", err.message);
      player.stopPlaying(true).catch(() => {});
    });
  })

  .on("trackStuck", (player, track) => {
    console.warn(`[Lavalink] Track stuck guild=${player.guildId}: "${track?.info?.title}"`);
    clearNpInterval(player.guildId);
    client.channels.cache.get(player.textChannelId)
      ?.send(`⚠️ **${track?.info?.title || "Track"}** got stuck and was skipped.`).catch(() => {});
  })

  .on("playerSocketClosed", (player, payload) => {
    console.warn(`[Lavalink] Player socket closed guild=${player.guildId}:`, payload);
  })

  .on("queueEnd", async (player) => {
    clearNpInterval(player.guildId);
    const guildId = player.guildId;
    const textChannelId = player.textChannelId;

    // AFK mode — stay in channel, do nothing
    if (player.get("afk")) {
      console.log(`[Autoplay] Queue ended in guild ${guildId} — staying in channel (AFK mode)`);
      return;
    }

    // BUILT-IN AUTOPLAY — Always trigger automatically
    const seed = player.queue.previous?.[0];
    console.log(`[Autoplay] queueEnd triggered — seed: "${seed?.info?.title || "NONE"}"`);
    
    if (seed) {
      console.log(`[Autoplay] Starting recommendation generation...`);
      await handleAutoplay(player, seed);
      
      // Wait a moment for queue to populate
      await new Promise(r => setTimeout(r, 500));
      
      // Check if recommendations were added
      if (player.queue.tracks.length > 0) {
        console.log(`[Autoplay] Successfully queued recommendations. Queue size: ${player.queue.tracks.length}`);
        const textChannel = client.channels.cache.get(textChannelId);
        textChannel?.send("🎵 **Autoplay activated!** Now playing recommendations based on your music...").catch(() => {});
        return;
      } else {
        console.warn("[Autoplay] No recommendations were generated");
      }
    } else {
      console.warn("[Autoplay] No previous track found to seed recommendations");
    }

    // Fallback: queue has ended, no autoplay possible
    await clearVoiceStatus(client, player.voiceChannelId);
    client.channels.cache.get(textChannelId)
      ?.send("✅ Queue finished! Use `/play` to add more tracks for non-stop music.").catch(() => {});
  });

// ─── Load events ──────────────────────────────────────────────────────────────
for (const file of fs.readdirSync(path.join(__dirname, "events")).filter(f => f.endsWith(".js"))) {
  const event = require(path.join(__dirname, "events", file));
  if (event.once) client.once(event.name, (...args) => event.execute(...args, client));
  else            client.on(  event.name, (...args) => event.execute(...args, client));
}

// ─── Forward voice updates to Lavalink ───────────────────────────────────────
client.on("raw", d => {
  if (["VOICE_STATE_UPDATE", "VOICE_SERVER_UPDATE"].includes(d.t)) {
    if (d.d && !d.d.guild_id && d.d.member?.guild_id)
      d.d.guild_id = d.d.member.guild_id;
    console.log(`[Voice] ${d.t} guild=${d.d?.guild_id ?? "UNKNOWN"}`);
  }
  client.lavalink.sendRawData(d);
});

// ─── Slash command handler ────────────────────────────────────────────────────
// Bug fix: commands were crashing (spamming DiscordAPIError[50027] "Invalid
// Webhook Token" in the logs) whenever a reply landed after the interaction's
// 15-minute webhook token had lapsed — e.g. a slow Lavalink round trip, a
// queued/backlogged event after a brief reconnect, or a long Spotify playlist
// import. editReply()/reply()/followUp() would throw, the command's own code
// had no recovery path, and the user never got a response. We now patch those
// three methods per-interaction so an expired/invalid token transparently
// falls back to a normal channel message instead of throwing.
function isExpiredInteractionError(err) {
  return err?.code === 50027 || err?.code === 10062 || err?.status === 401;
}

function attachSafeInteractionReplies(interaction, client) {
  const originalReply     = interaction.reply.bind(interaction);
  const originalEditReply = interaction.editReply.bind(interaction);
  const originalFollowUp  = interaction.followUp.bind(interaction);

  const sendToChannel = async payload => {
    const channel =
      interaction.channel || client.channels.cache.get(interaction.channelId);
    if (!channel?.send) return null;
    const { content, embeds, components } =
      typeof payload === "string" ? { content: payload } : payload || {};
    return channel.send({ content, embeds, components }).catch(() => null);
  };

  const wrap = (name, original) => async payload => {
    try {
      return await original(payload);
    } catch (err) {
      if (isExpiredInteractionError(err)) {
        console.warn(
          `[Interaction] Token expired on ${name} for /${interaction.commandName} — sending a channel message instead.`
        );
        return sendToChannel(payload);
      }
      throw err;
    }
  };

  interaction.reply     = wrap("reply", originalReply);
  interaction.editReply = wrap("editReply", originalEditReply);
  interaction.followUp  = wrap("followUp", originalFollowUp);
}

client.on("interactionCreate", async interaction => {
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (command?.autocomplete) command.autocomplete(interaction, client).catch(() => {});
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  attachSafeInteractionReplies(interaction, client);

  try {
    await command.execute(interaction, client);
  } catch (err) {
    console.error(`[Command/${interaction.commandName}]`, err);
    const payload = { content: "An error occurred.", ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

// ─── Process-level error guards ───────────────────────────────────────────────
process.on("unhandledRejection",       reason => console.error("[Process] Unhandled Rejection:", reason));
process.on("uncaughtException",        err    => console.error("[Process] Uncaught Exception:", err));
process.on("uncaughtExceptionMonitor", err    => console.error("[Process] Uncaught Exception Monitor:", err));

// ─── Web dashboard ────────────────────────────────────────────────────────────
// Purely additive: reads existing client/lavalink state and calls existing
// Player methods (pause/resume/skip/etc). Doesn't change any bot behavior above.
startDashboard(client);

client.login(process.env.DISCORD_TOKEN);
