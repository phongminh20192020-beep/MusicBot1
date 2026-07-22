"use strict";

const { resetPresence } = require("../utils/helpers");
const { printLoginBanner } = require("../utils/banner");

module.exports = {
  name: "clientReady",
  once: true,
  async execute(client) {
    printLoginBanner(client);
    resetPresence(client);
    await client.lavalink.init({ id: client.user.id, username: client.user.username });
    console.log("[Lavalink] Init called — waiting for node connection...");
  },
};
