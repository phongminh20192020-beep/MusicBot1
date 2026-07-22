"use strict";

module.exports = {
  name: "clientReady",
  once: true,
  async execute(client) {
    console.log(`[Bot] Logged in as ${client.user.tag} (${client.user.id})`);
    client.user.setActivity("music <:NoName:1529477858307604540>", { type: 2 });
    await client.lavalink.init({ id: client.user.id, username: client.user.username });
    console.log("[Lavalink] Init called — waiting for node connection...");
  },
};
