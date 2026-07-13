const { REST, Routes } = require("discord.js");
const fs = require("fs");
const path = require("path");

const commands = [];
const commandFiles = fs
  .readdirSync(path.join(__dirname, "commands"))
  .filter((f) => f.endsWith(".js"));

for (const file of commandFiles) {
  const cmd = require(path.join(__dirname, "commands", file));
  if (cmd.data) commands.push(cmd.data.toJSON());
}

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  console.log(`Registering ${commands.length} slash commands globally...`);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log("Done.");
})().catch(console.error);
