"use strict";

const { formatDuration } = require("../utils/helpers");

function trackToJSON(track) {
  if (!track) return null;
  return {
    title:       track.info.title,
    author:      track.info.author || "Unknown",
    uri:         track.info.uri || null,
    duration:    track.info.duration || 0,
    durationFmt: track.info.isStream ? "LIVE" : formatDuration(track.info.duration || 0),
    isStream:    !!track.info.isStream,
    source:      track.info.sourceName || "unknown",
    artwork:
      track.info.artworkUrl?.trim() ||
      (track.info.identifier ? `https://img.youtube.com/vi/${track.info.identifier}/hqdefault.jpg` : null),
    requester: track.requester?.username || track.requester?.tag || "Unknown",
  };
}

function playerToJSON(client, player) {
  const guild   = client.guilds.cache.get(player.guildId);
  const channel = guild?.channels.cache.get(player.voiceChannelId);

  return {
    guildId:      player.guildId,
    guildName:    guild?.name || "Unknown server",
    guildIcon:    guild?.iconURL?.({ size: 64 }) || null,
    channelName:  channel?.name || "Unknown channel",
    listeners:    channel?.members ? [...channel.members.values()].filter(m => !m.user?.bot).length : 0,
    playing:      !!player.playing,
    paused:       !!player.paused,
    connected:    !!player.connected,
    volume:       typeof player.volume === "number" ? player.volume : 100,
    position:     player.position || 0,
    positionFmt:  formatDuration(player.position || 0),
    repeatMode:   player.repeatMode || "off",
    afk:          !!player.get?.("afk"),
    current:      trackToJSON(player.queue?.current),
    previous:     (player.queue?.previous || []).slice(0, 50).map(trackToJSON),
    queue:        (player.queue?.tracks || []).slice(0, 50).map(trackToJSON),
    queueLength:  player.queue?.tracks?.length || 0,
  };
}

function statsToJSON(client) {
  const players = [...client.lavalink.players.values()];
  return {
    botTag:        client.user?.tag || null,
    botAvatar:     client.user?.displayAvatarURL?.({ size: 64 }) || null,
    online:        client.isReady(),
    ping:          Number.isFinite(client.ws?.ping) ? Math.round(client.ws.ping) : -1,
    guildCount:    client.guilds.cache.size,
    activePlayers: players.filter(p => p.playing).length,
    totalPlayers:  players.length,
    uptimeMs:      client.uptime || 0,
    nodeConnected: client.lavalink.nodeManager.nodes.get("main")?.connected ?? false,
  };
}

module.exports = { trackToJSON, playerToJSON, statsToJSON };
