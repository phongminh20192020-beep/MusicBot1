# Web dashboard

A live control panel for the bot: current track, progress, per-server queue,
and playback controls (pause/resume, skip, stop, disconnect, volume, loop
mode), all updating in real time over Socket.IO. It runs inside the same
process as the bot — `src/index.js` boots it right before `client.login()`.
Nothing about the bot's existing commands or events was changed to add it.

## Setup

1. Install the two new dependencies (already added to `package.json`):
   ```
   npm install
   ```
2. Set a password — the dashboard refuses all logins until this is set:
   ```
   DASHBOARD_PASSWORD=some-long-random-string
   ```
3. Optional — pick a port. Railway/Heroku-style platforms inject `PORT`
   automatically and that takes priority; otherwise it falls back to
   `DASHBOARD_PORT`, then `3000`:
   ```
   DASHBOARD_PORT=3000
   ```
4. Run the bot as usual (`npm start`) and open `http://localhost:3000`
   (or whatever host/port you're running on).

## Deploying on Railway

The bot service currently has no public domain (see `RAILWAY.md` — it only
makes outbound connections). To reach the dashboard from a browser:

1. Go to the bot service → **Settings** → **Networking** → **Generate Domain**.
2. Add the `DASHBOARD_PASSWORD` variable to the bot service.
3. Railway sets `PORT` automatically — the dashboard already listens on it.

## Security notes

- The dashboard has no login rate-limiting yet — use a long, random
  `DASHBOARD_PASSWORD`, not a short/guessable one.
- Sessions are stored in memory and reset whenever the bot process restarts.
- Anyone with the password can control every server the bot is in from this
  one panel — treat the password like you would the bot token itself.
