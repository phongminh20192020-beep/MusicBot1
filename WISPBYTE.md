# Deploying to Wispbyte

Wispbyte is panel-configured (no committed config file the way Discloud uses
`discloud.config` — everything below is entered through their web dashboard
when you create the server).

## 1. Create the bot's server

- Project type: **Discord Bot**
- Docker image: **Node.js** (Wispbyte also offers Bun/Python/Java/C# — pick
  Node.js since that's what this project is)
- When prompted for the main startup file via the console file picker,
  choose: `src/index.js`

## 2. Startup tab

- **Startup command:** `npm start` (runs `node -r dotenv/config src/index.js`
  per `package.json` — the `dotenv/config` require is harmless even without a
  `.env` file present, since Wispbyte injects env vars directly)
- **Additional Node Packages:** leave blank — `package.json` already lists
  everything needed (`discord.js`, `express`, `socket.io`, `lavalink-client`,
  `dotenv`, `@google/genai`), and Wispbyte installs from it automatically

## 3. Environment variables

Add all of these under the Startup tab's environment variables section
(pulled directly from every `process.env.*` reference in the codebase, so
this list is exhaustive — nothing extra, nothing missing):

| Variable | Required | Notes |
|---|---|---|
| `DISCORD_TOKEN` | Yes | From the Discord Developer Portal |
| `CLIENT_ID` | Yes | Your bot's application/client ID |
| `LAVALINK_HOST` | Yes | Host of your Lavalink instance (see step 4) |
| `LAVALINK_PORT` | Yes | Lavalink port |
| `LAVALINK_PASS` | Yes | Lavalink server password (must match `lavalink/application.yml`) |
| `DASHBOARD_PASSWORD` | Yes | Password to log into the web dashboard |
| `PORT` or `DASHBOARD_PORT` | Recommended | Wispbyte assigns a port for "Web Application" projects — set this to whatever it gives you |
| `LASTFM_API_KEY` | For Discover/artist pages | From last.fm/api |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | For Spotify link resolving | From the Spotify Developer Dashboard |
| `YOUTUBE_REFRESH_TOKEN` | Optional | Only if you're using the YouTube OAuth flow |

## 4. Lavalink — separate server

Wispbyte's own "one Discord bot per server" rule means Lavalink needs its
**own** Wispbyte server instance, not bundled with the bot. Convenient
upside: Wispbyte lists **Lavalink** as one of its explicitly supported
hosting categories, so this should be a first-class deploy there, not a
workaround:

- Create a second Wispbyte server, type **Lavalink**
- Upload `lavalink/application.yml` and `lavalink/cookies.txt` from this repo
- Once it's running, take the host/port Wispbyte gives that server and set
  them as `LAVALINK_HOST`/`LAVALINK_PORT` on the bot's server (step 3)

## 5. Register slash commands (one-time, after first deploy)

Slash commands need registering with Discord once before they show up.
Either run this locally with the same `DISCORD_TOKEN`/`CLIENT_ID`:

```
npm run register
```

or run it from Wispbyte's console on the bot's server after the first
deploy, using the same command.

## 6. Start it

Start the server from the Console tab and watch the logs. If
`DISCORD_TOKEN`/`LAVALINK_*` are correct, the bot should come online within
a few seconds; the dashboard (if you set `PORT`) should be reachable at
whatever URL/port Wispbyte assigns to a "Web Application" project.
