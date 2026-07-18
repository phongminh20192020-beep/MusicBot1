"use strict";

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

const loginScreen   = $("#login-screen");
const loginForm     = $("#login-form");
const loginCard     = $(".login-card");
const loginError    = $("#login-error");
const passwordInput = $("#password-input");
const dashboard     = $("#dashboard");
const channelsEl    = $("#channels");
const emptyStateEl  = $("#empty-state");
const template      = $("#channel-template");
const toastStack    = $("#toast-stack");
const spotlightEl   = $("#spotlight");
const contentEl     = $("#content");
const recsPanel     = $("#spotify-recs");
const recsGrid      = $("#recs-grid");

const statusLabel   = $("#status-label");
const onlineLed     = $("#online-led");
const onlineRing    = $("#online-ring");
const statPing      = $("#stat-ping");
const statGuilds    = $("#stat-guilds");
const statLive      = $("#stat-live");
const statUptime    = $("#stat-uptime");

const spotlightBg   = $("#spotlight-bg");
const spotlightArt  = $("#spotlight-art");
const spotlightViz  = $("#spotlight-viz");
const spotlightGuild = $("#spotlight-guild");
const spotlightTitle = $("#spotlight-title");
const spotlightAuthor = $("#spotlight-author");
const spotlightElapsed = $("#spotlight-elapsed");
const spotlightDuration = $("#spotlight-duration");
const spotlightFill = $("#spotlight-fill");

const FALLBACK_ART = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='100%25' height='100%25' fill='%231e1e24' rx='8'/%3E%3C/svg%3E";

const SOURCE_COLORS = {
  spotify:      "#22d3a3",
  youtube:      "#f87171",
  youtubemusic: "#f59e0b",
  soundcloud:   "#ff8800",
  default:      "#6c63ff",
};

let socket = null;
const cards = new Map();
const lastTrackTitles = new Map();
let vizPlaying = false;
let vizColor = SOURCE_COLORS.default;
let currentPlayers = [];
let activeGuildId = null;

function formatTime(ms) {
  if (!ms || ms < 0) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function toast(message, { type = "success" } = {}) {
  const el = document.createElement("div");
  el.className = `toast${type === "error" ? " toast-error" : ""}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.textContent = message;
  toastStack.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast-leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, 2800);
}

const confirmModal   = $("#confirm-modal");
const confirmMessage = $("#confirm-message");
const confirmOk      = $("#confirm-ok");
const confirmCancel  = $("#confirm-cancel");

function askConfirm(message) {
  confirmMessage.textContent = message;
  confirmModal.classList.remove("hidden");
  return new Promise(resolve => {
    const cleanup = () => {
      confirmModal.classList.add("hidden");
      confirmOk.removeEventListener("click", onOk);
      confirmCancel.removeEventListener("click", onCancel);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    confirmOk.addEventListener("click", onOk, { once: true });
    confirmCancel.addEventListener("click", onCancel, { once: true });
  });
}

async function apiFetch(url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, credentials: "same-origin" });
    if (res.status === 401) { showLogin(); throw new Error("unauthenticated"); }
    return res;
  } catch (err) {
    if (err.message === "unauthenticated") throw err;
    throw new Error("Network error");
  }
}

function showLogin() {
  if (socket) { socket.disconnect(); socket = null; }
  dashboard.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  passwordInput.focus();
}

function showDashboard() {
  loginScreen.classList.add("hidden");
  dashboard.classList.remove("hidden");
  connectSocket();
}

loginForm.addEventListener("submit", async e => {
  e.preventDefault();
  loginError.textContent = "";
  const btn = $("#login-btn");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: passwordInput.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      loginError.textContent = data.error || "Incorrect password.";
      loginCard.classList.remove("shake");
      void loginCard.offsetWidth;
      loginCard.classList.add("shake");
      passwordInput.value = "";
      return;
    }
    passwordInput.value = "";
    showDashboard();
  } catch (err) {
    loginError.textContent = "Network error. Try again.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});

$("#logout-btn").addEventListener("click", async () => {
  try {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    showLogin();
  } catch (err) {
    toast("Logout failed.", { type: "error" });
  }
});

function connectSocket() {
  if (socket) return;
  socket = io({ withCredentials: true });
  socket.on("connect", () => console.log("Socket connected"));
  socket.on("stats", renderStats);
  socket.on("players", renderPlayers);
  socket.on("recommendations", renderRecs);
  socket.on("connect_error", err => {
    console.error("Socket connection error:", err);
    toast("Connection lost. Please refresh.", { type: "error" });
    showLogin();
  });
  socket.on("disconnect", () => console.log("Socket disconnected"));
}

function renderStats(stats) {
  if (!stats) return;
  const isOnline = stats.online === true;
  onlineLed.className = "online-dot " + (isOnline ? "on" : "off");
  onlineRing.classList.toggle("pulsing", isOnline);
  statusLabel.textContent = isOnline ? "Online" : "Offline";
  statPing.textContent = stats.ping >= 0 ? `${stats.ping}ms` : "—";
  statGuilds.textContent = stats.guildCount || "—";
  statLive.textContent = `${stats.activePlayers || 0}/${stats.totalPlayers || 0}`;
  statUptime.textContent = stats.uptimeMs ? formatUptime(stats.uptimeMs) : "—";
}

function pickSpotlight(players) {
  const live = players.filter(p => p.playing && !p.paused);
  return live.reduce((best, p) => (p.listeners > (best?.listeners ?? -1) ? p : best), null);
}

function renderSpotlight(players) {
  const top = pickSpotlight(players);
  if (!top?.current) { spotlightEl.classList.add("hidden"); vizPlaying = false; return; }
  spotlightEl.classList.remove("hidden");
  vizPlaying = true;
  const track = top.current;
  vizColor = SOURCE_COLORS[track.source] || SOURCE_COLORS.default;
  spotlightBg.style.background = `radial-gradient(ellipse at 30% 50%, ${vizColor}, transparent 65%)`;
  spotlightArt.src = track.artwork || FALLBACK_ART;
  spotlightGuild.textContent = top.guildName || "Unknown";
  spotlightTitle.textContent = track.title || "Unknown track";
  applyMarquee(spotlightTitle);
  spotlightAuthor.textContent = track.author || "Unknown artist";
  const pct = track.duration ? Math.min(100, (top.position / track.duration) * 100) : 0;
  spotlightFill.style.width = `${pct}%`;
  spotlightElapsed.textContent = top.positionFmt || "0:00";
  spotlightDuration.textContent = track.durationFmt || "0:00";
}

function renderPlayers(players) {
  currentPlayers = players || [];
  renderSpotlight(currentPlayers);
  const hasActive = players.some(p => p.playing || p.paused);
  emptyStateEl.classList.toggle("hidden", hasActive);
  const existingIds = new Set(cards.keys());
  const incomingIds = new Set(players.map(p => p.guildId));
  for (const id of existingIds) {
    if (!incomingIds.has(id)) { const card = cards.get(id); if (card) card.remove(); cards.delete(id); }
  }
  for (const player of players) {
    if (cards.has(player.guildId)) {
      updateCard(cards.get(player.guildId), player);
    } else {
      const card = createCard(player);
      cards.set(player.guildId, card);
      channelsEl.appendChild(card);
      wireCard(card, player.guildId);
    }
  }
  if (players.length && !activeGuildId) activeGuildId = players[0].guildId;
}

function createCard(player) {
  const clone = template.content.cloneNode(true);
  const card = clone.querySelector(".channel-card");
  card.setAttribute("data-guild-id", player.guildId);
  card.querySelector(".cc-track-title").textContent = "Nothing playing";
  card.querySelector(".cc-track-author").textContent = "";
  card.querySelector(".cc-guild-name").textContent = player.guildName || "Unknown";
  return card;
}

function updateCard(card, player) {
  const badge = card.querySelector(".cc-badge");
  badge.className = "cc-badge";
  if (player.playing && !player.paused) { badge.className = "cc-badge badge-playing"; badge.textContent = "On Air"; }
  else if (player.paused) { badge.className = "cc-badge badge-paused"; badge.textContent = "Paused"; }
  else if (player.afk) { badge.className = "cc-badge badge-afk"; badge.textContent = "AFK"; }
  else { badge.className = "cc-badge badge-idle"; badge.textContent = "Idle"; }

  const track = player.current;
  card.querySelector(".cc-art").src = track?.artwork || FALLBACK_ART;

  const titleEl = card.querySelector(".cc-track-title");
  const newTitle = track?.title || "Nothing playing";
  const prevTitle = lastTrackTitles.get(player.guildId);
  if (track && prevTitle !== undefined && prevTitle !== newTitle) {
    const artEl = card.querySelector(".cc-art");
    const rect = artEl.getBoundingClientRect();
    burstAt(rect.left + rect.width / 2, rect.top + rect.height / 2, SOURCE_COLORS[track.source] || SOURCE_COLORS.default);
  }
  lastTrackTitles.set(player.guildId, newTitle);
  titleEl.textContent = newTitle;
  applyMarquee(titleEl);

  card.querySelector(".cc-track-author").textContent = track?.author || "";
  card.querySelector(".cc-guild-name").textContent = player.guildName || "Unknown";

  const pct = track?.duration ? Math.min(100, (player.position / track.duration) * 100) : 0;
  card.querySelector(".cc-prog .prog-fill").style.width = `${pct}%`;
  card.querySelector(".prog-elapsed").textContent = player.positionFmt || "0:00";
  card.querySelector(".prog-duration").textContent = track?.durationFmt || "0:00";

  // FIX: Don't replace innerHTML — just swap SVG path to preserve listener
  const ppBtn = card.querySelector(".act-playpause");
  const isPaused = player.paused;
  const newSvg = isPaused
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>';
  if (ppBtn.dataset.paused !== String(isPaused)) {
    ppBtn.innerHTML = newSvg;
    ppBtn.dataset.paused = String(isPaused);
    ppBtn.title = isPaused ? "Resume" : "Pause";
  }

  const volSlider = card.querySelector(".act-volume");
  if (document.activeElement !== volSlider) volSlider.value = player.volume;
  card.querySelector(".vol-val").textContent = player.volume;

  for (const btn of card.querySelectorAll(".act-loop")) {
    btn.classList.toggle("is-active", btn.dataset.mode === player.repeatMode);
  }

  const qList = card.querySelector(".queue-list");
  const qTracks = player.queue || [];
  qList.innerHTML = qTracks.length
    ? qTracks.slice(0, 10).map((t, i) => \`<li><span class="q-num">${i+1}</span><span class="q-title">${t.title}</span><span class="q-dur">${t.durationFmt}</span></li>\`).join("")
    : '<li class="queue-empty">Queue is empty</li>';
}

function wireCard(card, guildId) {
  const post = async (action, body, { successMessage } = {}) => {
    try {
      const res = await apiFetch(`/api/players/${guildId}/${action}`, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(data.error || \`Couldn't ${action}.\`, { type: "error" });
        return;
      }
      if (successMessage) toast(successMessage);
    } catch (err) {
      console.error(\`Action error (${action}):\`, err);
      toast(\`Connection issue.\`, { type: "error" });
    }
  };

  card.querySelector(".act-playpause").addEventListener("click", () => {
    const btn = card.querySelector(".act-playpause");
    const isPaused = btn.dataset.paused === "true";
    post(isPaused ? "resume" : "pause", null, {
      successMessage: isPaused ? "Resumed ▶" : "Paused ⏸"
    });
  });

  card.querySelector(".act-skip").addEventListener("click", () => post("skip", null, { successMessage: "Skipped ⏭" }));
  card.querySelector(".act-shuffle").addEventListener("click", () => post("shuffle", null, { successMessage: "Queue shuffled 🔀" }));
  card.querySelector(".act-stop").addEventListener("click", () => post("stop", null, { successMessage: "Stopped ⏹" }));
  card.querySelector(".act-disconnect").addEventListener("click", async () => {
    if (await askConfirm("Disconnect from voice and clear the queue?")) {
      post("disconnect", null, { successMessage: "Disconnected" });
    }
  });

  const volSlider = card.querySelector(".act-volume");
  volSlider.addEventListener("input", () => { card.querySelector(".vol-val").textContent = volSlider.value; });
  volSlider.addEventListener("change", () => {
    post("volume", { level: Number(volSlider.value) }, { successMessage: \`Volume → ${volSlider.value}\` });
  });

  for (const btn of card.querySelectorAll(".act-loop")) {
    btn.addEventListener("click", () => post("loop", { mode: btn.dataset.mode }, { successMessage: \`Loop: ${btn.dataset.mode}\` }));
  }

  wireSearch(card, guildId);
}

function wireSearch(card, guildId) {
  const input   = card.querySelector(".search-input");
  const btn     = card.querySelector(".act-search");
  const results = card.querySelector(".search-results");
  let reqId = 0;
  let debounce = null;

  function setResults(html) { results.innerHTML = html; results.classList.remove("hidden"); }

  function buildItem(track) {
    const li = document.createElement("li");
    li.className = "search-result";
    li.innerHTML = \`
      <img class="sr-art" src="${track.artwork || FALLBACK_ART}" alt="">
      <div class="sr-info"><div class="sr-title">${track.title}</div><div class="sr-meta">${track.author} · ${track.durationFmt || "0:00"}</div></div>
      <button class="sr-add" title="Add to queue">+</button>
    \`;
    li.querySelector(".sr-add").addEventListener("click", () => enqueue(track.token, track.title));
    return li;
  }

  async function enqueue(token, title) {
    try {
      const res = await apiFetch(`/api/players/${guildId}/queue`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
      });
      if (!res.ok) { const data = await res.json().catch(() => ({})); toast(data.error || "Couldn't add track.", { type: "error" }); return; }
      toast(\`Added: ${title}\`);
      results.classList.add("hidden"); results.innerHTML = ""; input.value = "";
    } catch (err) { toast("Connection issue.", { type: "error" }); }
  }

  async function search() {
    const query = input.value.trim();
    if (!query) { results.classList.add("hidden"); results.innerHTML = ""; return; }
    const id = ++reqId;
    setResults(\`<li class="search-status">Searching…</li>\`);
    try {
      const res = await apiFetch(`/api/players/${guildId}/search?query=${encodeURIComponent(query)}`);
      if (id !== reqId) return;
      if (!res.ok) { const data = await res.json().catch(() => ({})); setResults(\`<li class="search-status">${data.error || "Search failed."}</li>\`); return; }
      const data = await res.json();
      const tracks = data.results || [];
      if (id !== reqId) return;
      if (!tracks.length) { setResults(\`<li class="search-status">No results found.</li>\`); return; }
      results.innerHTML = ""; results.classList.remove("hidden");
      for (const track of tracks) results.appendChild(buildItem(track));
    } catch (err) { if (id !== reqId) return; setResults(\`<li class="search-status">Connection issue — try again.</li>\`); }
  }

  input.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(search, 300); });
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(debounce); search(); } });
  btn.addEventListener("click", () => { clearTimeout(debounce); search(); });
  document.addEventListener("click", e => { if (!card.contains(e.target)) results.classList.add("hidden"); });
}

// ══════════════════════════════════════════════════════
// GLOBAL SEARCH (topbar)
// ══════════════════════════════════════════════════════
const globalSearchInput = $("#global-search");
let globalDebounce = null;

globalSearchInput.addEventListener("input", () => {
  clearTimeout(globalDebounce);
  globalDebounce = setTimeout(() => {
    const query = globalSearchInput.value.trim();
    if (!query || !activeGuildId) return;
    const card = cards.get(activeGuildId);
    if (!card) return;
    const input = card.querySelector(".search-input");
    const btn = card.querySelector(".act-search");
    if (input) { input.value = query; btn?.click(); }
  }, 300);
});

globalSearchInput.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(globalDebounce);
    const query = globalSearchInput.value.trim();
    if (!query || !activeGuildId) return;
    const card = cards.get(activeGuildId);
    if (!card) return;
    const input = card.querySelector(".search-input");
    const btn = card.querySelector(".act-search");
    if (input) { input.value = query; btn?.click(); }
  }
});

// ══════════════════════════════════════════════════════
// RECOMMENDATIONS
// ══════════════════════════════════════════════════════
function renderRecs(data) {
  if (!data?.tracks?.length) {
    recsPanel?.classList.add("hidden");
    return;
  }
  recsPanel?.classList.remove("hidden");
  recsGrid.innerHTML = data.tracks.map(t => \`
    <div class="rec-card" data-uri="${t.uri}">
      <img src="${t.artwork || FALLBACK_ART}" alt="" class="rec-art">
      <div class="rec-info"><div class="rec-name">${t.title}</div><div class="rec-artist">${t.artist}</div></div>
    </div>
  \`).join("");
  recsGrid.querySelectorAll(".rec-card").forEach(el => {
    el.addEventListener("click", () => {
      if (!activeGuildId) return toast("No active player", {type:"error"});
      apiFetch(\`/api/players/${activeGuildId}/queue\`, {
        method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({uri: el.dataset.uri})
      }).then(() => toast("Added recommendation")).catch(() => toast("Failed to add", {type:"error"}));
    });
  });
}

// ══════════════════════════════════════════════════════
// MARQUEE & VISUALS
// ══════════════════════════════════════════════════════
function applyMarquee(el) {
  el.classList.remove("marquee");
  void el.offsetWidth;
  if (el.scrollWidth > el.clientWidth) el.classList.add("marquee");
}

function burstAt(x, y, color) {
  const count = 12;
  for (let i = 0; i < count; i++) {
    const p = document.createElement("div");
    p.style.cssText = \`position:fixed;left:${x}px;top:${y}px;width:6px;height:6px;border-radius:50%;background:${color};pointer-events:none;z-index:9999;\`;
    document.body.appendChild(p);
    const angle = (Math.PI * 2 * i) / count;
    const dist = 40 + Math.random() * 30;
    const tx = Math.cos(angle) * dist;
    const ty = Math.sin(angle) * dist;
    p.animate([{ transform: "translate(0,0) scale(1)", opacity: 1 }, { transform: \`translate(${tx}px,${ty}px) scale(0)\`, opacity: 0 }], { duration: 600, easing: "cubic-bezier(0, .9, .57, 1)" }).onfinish = () => p.remove();
  }
}

// ══════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════
(async function init() {
  try {
    const res = await fetch("/api/me");
    const data = await res.json();
    if (data.authenticated) showDashboard(); else showLogin();
  } catch (err) { console.error("Init error:", err); showLogin(); }
})();
