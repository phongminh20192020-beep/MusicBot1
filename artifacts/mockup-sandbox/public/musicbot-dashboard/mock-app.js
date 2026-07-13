"use strict";
/*
 * Preview-only stand-in for the real dashboard's app.js.
 * Fabricates realistic Socket.IO-style "stats"/"players" payloads on an
 * interval so the exact same markup/CSS can be reviewed on canvas without a
 * live Discord bot, Lavalink node, or real credentials behind it. The DOM
 * rendering logic here is intentionally a 1:1 copy of the real app.js so
 * what you see is what ships.
 */

const $ = sel => document.querySelector(sel);

const loginScreen  = $("#login-screen");
const loginForm    = $("#login-form");
const loginCard    = $(".login-card");
const loginError   = $("#login-error");
const passwordInput = $("#password-input");
const dashboard     = $("#dashboard");
const channelsEl    = $("#channels");
const emptyStateEl  = $("#empty-state");
const template       = $("#channel-template");
const toastStack     = $("#toast-stack");
const spotlightEl    = $("#spotlight");

const FALLBACK_ART =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='72'%3E%3Crect width='100%25' height='100%25' fill='%23191f16'/%3E%3C/svg%3E";

const SOURCE_COLORS = {
  spotify:      "#43d17a",
  youtube:      "#ff5c5c",
  youtubemusic: "#f2a93b",
  default:      "#a78bfa",
};

const cards = new Map();
const lastTrackTitles = new Map();

// ─── Toasts ────────────────────────────────────────────────────────────
function toast(message, { type = "success" } = {}) {
  const el = document.createElement("div");
  el.className = `toast ${type === "error" ? "toast-error" : ""}`;
  el.textContent = message;
  toastStack.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast-leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, 2600);
}

// ─── Confirm modal ──────────────────────────────────────────────────────
const confirmModal   = $("#confirm-modal");
const confirmMessage = $("#confirm-message");
const confirmOk      = $("#confirm-ok");
const confirmCancel  = $("#confirm-cancel");

function askConfirm(message) {
  confirmMessage.textContent = message;
  confirmModal.classList.remove("hidden");
  return new Promise(resolve => {
    const cleanup = result => {
      confirmModal.classList.add("hidden");
      confirmOk.removeEventListener("click", onOk);
      confirmCancel.removeEventListener("click", onCancel);
      confirmModal.removeEventListener("click", onVeil);
      resolve(result);
    };
    const onOk     = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onVeil   = e => { if (e.target === confirmModal) cleanup(false); };
    confirmOk.addEventListener("click", onOk);
    confirmCancel.addEventListener("click", onCancel);
    confirmModal.addEventListener("click", onVeil);
  });
}

// ─── Button glow-follow + ripple ────────────────────────────────────────
document.addEventListener("pointermove", e => {
  const btn = e.target.closest?.(".btn");
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  btn.style.setProperty("--x", `${e.clientX - rect.left}px`);
  btn.style.setProperty("--y", `${e.clientY - rect.top}px`);
});

document.addEventListener("click", e => {
  const btn = e.target.closest?.(".btn");
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 1.4;
  const ripple = document.createElement("span");
  ripple.className = "ripple";
  ripple.style.width = ripple.style.height = `${size}px`;
  ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
  ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
  btn.appendChild(ripple);
  ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
});

document.addEventListener("pointermove", e => {
  const card = e.target.closest?.(".channel");
  if (!card) return;
  const rect = card.getBoundingClientRect();
  const px = (e.clientX - rect.left) / rect.width - 0.5;
  const py = (e.clientY - rect.top) / rect.height - 0.5;
  card.style.transform = `perspective(700px) rotateX(${(-py * 4).toFixed(2)}deg) rotateY(${(px * 4).toFixed(2)}deg)`;
});
document.addEventListener("pointerleave", e => {
  const card = e.target.closest?.(".channel");
  if (card) card.style.transform = "";
}, true);

function burstAt(x, y, color) {
  const count = 14;
  for (let i = 0; i < count; i++) {
    const p = document.createElement("span");
    p.className = "burst-particle";
    const angle = Math.random() * Math.PI * 2;
    const dist = 40 + Math.random() * 50;
    p.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    p.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
    const size = 3 + Math.random() * 4;
    p.style.width = p.style.height = `${size}px`;
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    p.style.background = color;
    document.body.appendChild(p);
    p.addEventListener("animationend", () => p.remove(), { once: true });
  }
}

function applyMarquee(el) {
  requestAnimationFrame(() => {
    const overflowing = el.scrollWidth > el.clientWidth + 2;
    el.classList.toggle("marquee", overflowing);
    if (overflowing && !el.querySelector("span")) {
      el.innerHTML = `<span>${el.textContent}</span>`;
    } else if (!overflowing) {
      el.textContent = el.textContent;
    }
  });
}

// ─── Ambient particle background ──────────────────────────────────────
(function initBgCanvas() {
  const canvas = $("#bg-canvas");
  const ctx = canvas.getContext("2d");
  let particles = [];
  let w, h;
  function resize() { w = canvas.width = window.innerWidth; h = canvas.height = window.innerHeight; }
  window.addEventListener("resize", resize);
  resize();
  const COUNT = Math.min(70, Math.floor((window.innerWidth * window.innerHeight) / 22000));
  for (let i = 0; i < COUNT; i++) {
    particles.push({ x: Math.random() * w, y: Math.random() * h, r: Math.random() * 1.6 + 0.4,
      vx: (Math.random() - 0.5) * 0.12, vy: (Math.random() - 0.5) * 0.12, a: Math.random() * 0.5 + 0.15 });
  }
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function tick() {
    ctx.clearRect(0, 0, w, h);
    for (const p of particles) {
      if (!reduceMotion) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = w; if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h; if (p.y > h) p.y = 0;
      }
      ctx.beginPath();
      ctx.fillStyle = `rgba(232, 238, 226, ${p.a})`;
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(tick);
  }
  tick();
})();

// ─── Spotlight audio-reactive ring ─────────────────────────────────────
const spotlightViz = $("#spotlight-viz");
const vizCtx = spotlightViz.getContext("2d");
let vizPlaying = false;
let vizColor = SOURCE_COLORS.default;

function drawSpotlightViz(t) {
  const cx = spotlightViz.width / 2;
  const cy = spotlightViz.height / 2;
  vizCtx.clearRect(0, 0, spotlightViz.width, spotlightViz.height);
  if (vizPlaying) {
    const bars = 40;
    for (let i = 0; i < bars; i++) {
      const angle = (i / bars) * Math.PI * 2;
      const wobble = Math.sin(t / 260 + i * 0.7) * 0.5 + 0.5;
      const len = 10 + wobble * 16;
      const r1 = 62, r2 = r1 + len;
      vizCtx.beginPath();
      vizCtx.strokeStyle = vizColor;
      vizCtx.globalAlpha = 0.55;
      vizCtx.lineWidth = 2.5;
      vizCtx.moveTo(cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1);
      vizCtx.lineTo(cx + Math.cos(angle) * r2, cy + Math.sin(angle) * r2);
      vizCtx.stroke();
    }
  }
  requestAnimationFrame(drawSpotlightViz);
}
requestAnimationFrame(drawSpotlightViz);

// ─── Fake auth flow ─────────────────────────────────────────────────────
function showLogin() {
  dashboard.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  passwordInput.focus();
}
function showDashboard() {
  loginScreen.classList.add("hidden");
  dashboard.classList.remove("hidden");
  startMockFeed();
}

loginForm.addEventListener("submit", e => {
  e.preventDefault();
  loginError.textContent = "";
  passwordInput.value = "";
  showDashboard();
});

$("#logout-btn").addEventListener("click", () => {
  stopMockFeed();
  showLogin();
});

// ─── Rendering (identical to production app.js) ─────────────────────────
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function renderStats(stats) {
  $("#online-led").className = "led " + (stats.online ? "on" : "off");
  $("#online-ring").classList.toggle("pulsing", !!stats.online);
  $("#stat-ping").textContent   = stats.ping >= 0 ? `${stats.ping}ms` : "—";
  $("#stat-guilds").textContent = stats.guildCount;
  $("#stat-live").textContent   = `${stats.activePlayers}/${stats.totalPlayers}`;
  $("#stat-uptime").textContent = formatUptime(stats.uptimeMs);
  const bars = $("#signal-bars");
  bars.className = "signal-bars " + (stats.ping < 0 ? "" : stats.ping < 100 ? "good" : stats.ping < 250 ? "ok" : "bad");
}

function pickSpotlight(players) {
  const playing = players.filter(p => p.playing && !p.paused);
  if (!playing.length) return null;
  return playing.reduce((best, p) => (p.listeners > (best?.listeners ?? -1) ? p : best), null);
}

function renderSpotlight(players) {
  const top = pickSpotlight(players);
  if (!top || !top.current) { spotlightEl.classList.add("hidden"); vizPlaying = false; return; }
  spotlightEl.classList.remove("hidden");
  vizPlaying = true;
  vizColor = SOURCE_COLORS[top.current.source] || SOURCE_COLORS.default;
  $("#spotlight-glow").style.background = `radial-gradient(circle, ${vizColor}, transparent 70%)`;
  $("#spotlight-art").src = top.current.artwork || FALLBACK_ART;
  $("#spotlight-guild").textContent = top.guildName;
  const spotlightTitleEl = $("#spotlight-title");
  spotlightTitleEl.textContent = top.current.title;
  applyMarquee(spotlightTitleEl);
  $("#spotlight-author").textContent = top.current.author;
  $("#spotlight-source").textContent = top.current.source;
  $("#spotlight-requester").textContent = `req. by ${top.current.requester}`;
  const pct = top.current.duration ? Math.min(100, (top.position / top.current.duration) * 100) : 0;
  $("#spotlight-fill").style.width = `${pct}%`;
  $("#spotlight-fill").style.background = `linear-gradient(90deg, ${vizColor}66, ${vizColor})`;
  $("#spotlight-elapsed").textContent = top.positionFmt;
  $("#spotlight-duration").textContent = top.current.durationFmt;
}

function renderPlayers(players) {
  const seen = new Set();
  for (const p of players) {
    seen.add(p.guildId);
    let card = cards.get(p.guildId);
    if (!card) {
      card = template.content.firstElementChild.cloneNode(true);
      channelsEl.appendChild(card);
      cards.set(p.guildId, card);
      wireCardControls(card, p.guildId);
    }
    updateCard(card, p);
  }
  for (const [guildId, card] of cards) {
    if (!seen.has(guildId)) { card.remove(); cards.delete(guildId); }
  }
  emptyStateEl.classList.toggle("hidden", players.length > 0);
  channelsEl.classList.toggle("hidden", players.length === 0);
  renderSpotlight(players);
  document.body.classList.toggle("has-live-audio", players.some(p => p.playing && !p.paused));
}

function updateCard(card, p) {
  card.dataset.guildId = p.guildId;
  card.classList.toggle("is-playing", p.playing && !p.paused);
  card.classList.toggle("is-paused", p.paused);
  card.querySelector(".channel-tag").textContent = p.guildId.slice(-4).padStart(4, "0");
  card.querySelector(".channel-name").textContent = p.guildName;
  card.querySelector(".channel-listeners").textContent = `${p.channelName} · ${p.listeners} listening`;

  const pill = card.querySelector(".channel-pill");
  pill.className = "channel-pill " + (p.playing && !p.paused ? "playing" : p.paused ? "paused" : "");
  pill.textContent = p.playing && !p.paused ? "on air" : p.paused ? "paused" : p.afk ? "afk" : "idle";

  const vu = card.querySelector(".vu-meter");
  vu.classList.toggle("is-live", p.playing && !p.paused);

  const t = p.current;
  card.querySelector(".artwork").src = t?.artwork || FALLBACK_ART;
  const titleEl = card.querySelector(".track-title");
  const newTitle = t ? t.title : "Nothing playing";
  const prevTitle = lastTrackTitles.get(p.guildId);
  if (t && prevTitle !== undefined && prevTitle !== newTitle) {
    const rect = card.querySelector(".artwork").getBoundingClientRect();
    burstAt(rect.left + rect.width / 2, rect.top + rect.height / 2, SOURCE_COLORS[t.source] || SOURCE_COLORS.default);
  }
  lastTrackTitles.set(p.guildId, newTitle);
  titleEl.textContent = newTitle;
  applyMarquee(titleEl);
  card.querySelector(".track-author").textContent = t ? t.author : "";
  card.querySelector(".track-source").textContent = t ? t.source : "";
  card.querySelector(".track-requester").textContent = t ? `req. by ${t.requester}` : "";

  const pct = t && t.duration ? Math.min(100, (p.position / t.duration) * 100) : 0;
  card.querySelector(".progress-fill").style.width = `${pct}%`;
  card.querySelector(".progress-elapsed").textContent = p.positionFmt;
  card.querySelector(".progress-duration").textContent = t ? t.durationFmt : "0:00";

  const playPauseBtn = card.querySelector(".act-playpause");
  playPauseBtn.textContent = p.paused ? "▶" : "⏸";
  playPauseBtn.title = p.paused ? "Resume" : "Pause";

  const volInput = card.querySelector(".act-volume");
  if (document.activeElement !== volInput) volInput.value = p.volume;
  card.querySelector(".fader-value").textContent = p.volume;

  for (const btn of card.querySelectorAll(".act-loop")) btn.classList.toggle("is-active", btn.dataset.mode === p.repeatMode);

  card.querySelector(".queue-count").textContent = p.queueLength;
  const queueList = card.querySelector(".queue-list");
  queueList.innerHTML = "";
  p.queue.forEach((track, i) => {
    const li = document.createElement("li");
    const num = document.createElement("span"); num.className = "qi-num"; num.textContent = `${i + 1}.`;
    const title = document.createElement("span"); title.className = "qi-title"; title.textContent = track.title;
    const dur = document.createElement("span"); dur.textContent = track.durationFmt;
    li.append(num, title, dur);
    queueList.appendChild(li);
  });
}

function wireCardControls(card, guildId) {
  const post = (action, msg) => toast(msg);
  card.querySelector(".act-playpause").addEventListener("click", () => {
    const p = mockState.find(x => x.guildId === guildId);
    if (p) p.paused = !p.paused;
    post("action", p?.paused ? "Paused" : "Resumed");
  });
  card.querySelector(".act-skip").addEventListener("click", () => {
    const p = mockState.find(x => x.guildId === guildId);
    if (p) advanceTrack(p);
    post("action", "Skipped");
  });
  card.querySelector(".act-stop").addEventListener("click", () => post("action", "Stopped & cleared queue"));
  card.querySelector(".act-disconnect").addEventListener("click", async () => {
    const ok = await askConfirm("Disconnect this player and clear its queue?");
    if (ok) post("action", "Disconnected");
  });
  const volInput = card.querySelector(".act-volume");
  volInput.addEventListener("input", () => { card.querySelector(".fader-value").textContent = volInput.value; });
  volInput.addEventListener("change", () => toast(`Volume set to ${volInput.value}`));
  for (const btn of card.querySelectorAll(".act-loop")) {
    btn.addEventListener("click", () => toast(`Loop: ${btn.dataset.mode}`));
  }
}

// ─── Synthetic data generator ───────────────────────────────────────────
function placeholderArt(hue) {
  return "data:image/svg+xml," + encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'>
      <defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
        <stop offset='0%' stop-color='hsl(${hue},70%,45%)'/>
        <stop offset='100%' stop-color='hsl(${hue + 40},70%,25%)'/>
      </linearGradient></defs>
      <rect width='100%' height='100%' fill='url(#g)'/>
    </svg>`
  );
}

const SAMPLE_TRACKS = [
  { title: "Midnight City", author: "M83", source: "spotify", duration: 244000,
    artwork: placeholderArt(150) },
  { title: "Blinding Lights", author: "The Weeknd", source: "youtube", duration: 200000,
    artwork: placeholderArt(0) },
  { title: "Redbone", author: "Childish Gambino", source: "youtubemusic", duration: 326000,
    artwork: placeholderArt(35) },
  { title: "Instant Crush", author: "Daft Punk ft. Julian Casablancas", source: "spotify", duration: 337000,
    artwork: placeholderArt(270) },
  { title: "Nights", author: "Frank Ocean", source: "youtube", duration: 307000,
    artwork: placeholderArt(190) },
];

const GUILD_NAMES = ["Late Night Lounge", "The Study Hall", "Chillhop Cafe", "Retro Arcade"];
let mockState = [];
let feedTimer = null;
let clockStart = Date.now();

function makePlayer(i) {
  const track = SAMPLE_TRACKS[i % SAMPLE_TRACKS.length];
  return {
    guildId: `10000000000000000${i}`,
    guildName: GUILD_NAMES[i % GUILD_NAMES.length],
    channelName: "General Voice",
    listeners: 2 + Math.floor(Math.random() * 6),
    playing: true,
    paused: i === 2,
    afk: false,
    volume: 70 + i * 5,
    repeatMode: i === 1 ? "queue" : "off",
    position: 4000,
    positionFmt: "0:04",
    queueLength: 3,
    queue: SAMPLE_TRACKS.slice(0, 3).map(t => ({ title: t.title, durationFmt: fmt(t.duration) })),
    current: { ...track, requester: "vinh#0001", durationFmt: fmt(track.duration) },
  };
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function advanceTrack(p) {
  const idx = (SAMPLE_TRACKS.findIndex(t => t.title === p.current.title) + 1) % SAMPLE_TRACKS.length;
  const track = SAMPLE_TRACKS[idx];
  p.current = { ...track, requester: "vinh#0001", durationFmt: fmt(track.duration) };
  p.position = 0;
}

function startMockFeed() {
  mockState = [makePlayer(0), makePlayer(1), makePlayer(2)];
  clockStart = Date.now();
  tickFeed();
  feedTimer = setInterval(tickFeed, 1200);
}
function stopMockFeed() { if (feedTimer) clearInterval(feedTimer); feedTimer = null; }

function tickFeed() {
  for (const p of mockState) {
    if (!p.paused) {
      p.position = (p.position + 1200) % p.current.duration;
      if (p.position < 1200) advanceTrack(p);
    }
    p.positionFmt = fmt(p.position);
  }
  renderStats({
    online: true,
    ping: 40 + Math.round(Math.random() * 60),
    guildCount: 12,
    activePlayers: mockState.filter(p => p.playing && !p.paused).length,
    totalPlayers: mockState.length,
    uptimeMs: Date.now() - clockStart + 1000 * 60 * 60 * 26,
  });
  renderPlayers(mockState);
}

// ─── Boot straight into the dashboard for preview purposes ──────────────
showDashboard();
