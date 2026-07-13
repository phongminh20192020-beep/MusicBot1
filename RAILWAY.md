# Deploying to Railway

This repo deploys as **two separate Railway services** from the same GitHub
repo: the Discord bot (root directory) and your own Lavalink node
(`/lavalink` directory). They talk to each other over Railway's private
network, so neither one needs a public domain.

## 1. Create the project and connect the repo

1. Railway dashboard -> **New Project** -> **Deploy from GitHub repo** -> select this repo.
2. Railway will create one service from the repo root. This becomes the **bot** service — rename it (e.g. "bot") in Settings if you like.

## 2. Add the Lavalink service

1. In the same project, **New** -> **GitHub Repo** -> select this repo again (yes, the same repo, as a second service).
2. Open the new service's **Settings**, set:
   - **Root Directory**: `lavalink`
   - Railway will auto-detect `lavalink/Dockerfile`.
3. Rename this service to something like "Lavalink" — you'll reference its name below.
4. **Do not** click "Generate Domain" for this service. It only needs to be reachable privately by the bot.

## 3. Set the Lavalink service's variables

Go to the Lavalink service -> **Variables**, and add (see `lavalink/.env.example` for details):

| Variable | Value |
|---|---|
| `PORT` | `2333` |
| `SERVER_PORT` | `${{PORT}}` |
| `LAVALINK_SERVER_PASSWORD` | a long random string (not `youshallnotpass`) |
| `SPOTIFY_CLIENT_ID` | your Spotify app client ID |
| `SPOTIFY_CLIENT_SECRET` | your Spotify app client secret |
| `_JAVA_OPTIONS` | `-Xmx512m` (raise this if your Railway plan has more RAM) |

Deploy this service first and watch its logs.

## 4. Set up YouTube OAuth login (the "cookies" fix)

With `oauth.enabled: true` already set in `lavalink/application.yml`, the deploy logs for the Lavalink service will print a URL (`https://www.google.com/device`) and a short code the first time it starts.

1. Open that URL in any browser, enter the code.
2. Sign in with a **burner Google/YouTube account** — not your main one.
3. The logs will then print a `refreshToken`.
4. Open `lavalink/application.yml` in this repo, uncomment `refreshToken:` and `skipInitialization: true`, paste the token in, commit, and push. Railway will redeploy automatically and skip the device-login flow from then on.

## 5. Set the bot service's variables

Go to the bot service -> **Variables**, and add (see `.env.example` for details):

| Variable | Value |
|---|---|
| `DISCORD_TOKEN` | your bot token |
| `CLIENT_ID` | your bot's application ID |
| `LAVALINK_HOST` | `${{Lavalink.RAILWAY_PRIVATE_DOMAIN}}` |
| `LAVALINK_PORT` | `${{Lavalink.PORT}}` |
| `LAVALINK_PASS` | `${{Lavalink.LAVALINK_SERVER_PASSWORD}}` |

Replace `Lavalink` in the `${{...}}` references with whatever you actually named that service in step 2.

The bot doesn't need a public domain either — it only makes outbound connections (Discord gateway, Lavalink).

## 6. Deploy and verify

1. Deploy the bot service.
2. Check both services' logs: Lavalink should log `Lavalink is ready to accept connections`, and the bot should log `Node "custom" connected ✅`.
3. Run `/play` in Discord with a queue of 2+ songs and confirm playback advances past the first track — that's the bug this setup + the `trackError` fix in `src/index.js` resolves.

## Notes

- `src/index.js` still also defines two public fallback Lavalink nodes (`jirayu`, `serenetia`). Those aren't affected by anything here — they're third-party nodes you don't control, so the OAuth fix above only guarantees better YouTube reliability when playback happens to land on your `custom` node.
- Local testing: `docker compose up --build` at the repo root runs both services together using the same Dockerfiles Railway will use.
