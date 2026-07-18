"use strict";

// ══════════════════════════════════════════════════════
// DOM SELECTORS
// ══════════════════════════════════════════════════════

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

// Core elements
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

// Status elements
const statusLabel   = $("#status-label");
const onlineLed     = $("#online-led");
const onlineRing    = $("#online-ring");
const statPing      = $("#stat-ping");
const statGuilds    = $("#stat-guilds");
const statLive      = $("#stat-live");
const statUptime    = $("#stat-uptime");

// Spotlight elements
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

// ══════════════════════════════════════════════════════
// STATE MANAGEMENT
// ══════════════════════════════════════════════════════

let socket = null;
const cards = new Map();
const lastTrackTitles = new Map();
let vizPlaying = false;
let vizColor = SOURCE_COLORS.default;
let currentPlayers = [];

// ══════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ══════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════
// TOAST NOTIFICATIONS
// ══════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════
// CONFIRM MODAL
// ══════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════
// ANIMATIONS & VISUAL EFFECTS
// ══════════════════════════════════════════════════════

function burstAt(x, y, color) {
  for (let i = 0; i < 12; i++) {
    const p = document.createElement("span");
    p.className = "burst-particle";
    const angle = Math.random() * Math.PI * 2;
    const dist  = 35 + Math.random() * 45;
    p.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    p.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
    const size = 3 + Math.random() * 4;
    p.style.cssText += `width:${size}px;height:${size}px;left:${x}px;top:${y}px;background:${color}`;
    document.body.appendChild(p);
    p.addEventListener("animationend", () => p.remove(), { once: true });
  }
}

function applyMarquee(el) {
  if (!el) return;
  requestAnimationFrame(() => {
    const overflow = el.scrollWidth > el.clientWidth + 2;
    el.classList.toggle("marquee", overflow);
    if (overflow && !el.querySelector("span")) {
      el.innerHTML = `<span>${el.textContent}</span>`;
    } else if (!overflow && el.querySelector("span")) {
      el.textContent = el.textContent;
    }
  });
}

// Spotlight visualization
const vizCtx = spotlightViz.getContext("2d");

function drawViz(t) {
  const { width: w, height: h } = spotlightViz;
  vizCtx.clearRect(0, 0, w, h);
  
  if (vizPlaying) {
    const cx = w / 2, cy = h / 2, bars = 36;
    for (let i = 0; i < bars; i++) {
      const a = (i / bars) * Math.PI * 2;
      const wobble = Math.sin(t / 280 + i * 0.85) * 0.5 + 0.5;
      const r1 = 56, r2 = r1 + 8 + wobble * 14;
      
      vizCtx.beginPath();
      vizCtx.strokeStyle = vizColor;
      vizCtx.globalAlpha = 0.5;
      vizCtx.lineWidth = 2;
      vizCtx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      vizCtx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      vizCtx.stroke();
      vizCtx.globalAlpha = 1;
    }
  }
  
  requestAnimationFrame(drawViz);
}

requestAnimationFrame(drawViz);

// ══════════════════════════════════════════════════════
// AUTHENTICATION
// ══════════════════════════════════════════════════════

async function apiFetch(url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, credentials: "same-origin" });
    if (res.status === 401) {
      showLogin();
      throw new Error("unauthenticated");
    }
    return res;
  } catch (err) {
    if (err.message === "unauthenticated") throw err;
    throw new Error("Network error");
  }
}

function showLogin() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  dashboard.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  passwordInput.focus();
}

function showDashboard() {
  loginScreen.classList.add("hidden");
  dashboard.classList.remove("hidden");
  connectSocket();
}

// Login form submission
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
      void loginCard.offsetWidth; // Trigger reflow
      loginCard.classList.add("shake");
      passwordInput.value = "";
      return;
    }
    
    passwordInput.value = "";
    showDashboard();
  } catch (err) {
    loginError.textContent = "Connection error. Please try again.";
    console.error("Login error:", err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});

// Logout
$("#logout-btn").addEventListener("click", async () => {
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch (err) {
    console.error("Logout error:", err);
  } finally {
    showLogin();
  }
});

// ══════════════════════════════════════════════════════
// WEBSOCKET CONNECTION
// ══════════════════════════════════════════════════════

function connectSocket() {
  if (socket) return;
  
  socket = io({ withCredentials: true });
  
  socket.on("connect", () => {
    console.log("Socket connected");
  });
  
  socket.on("stats", renderStats);
  socket.on("players", renderPlayers);
  
  socket.on("connect_error", err => {
    console.error("Socket connection error:", err);
    toast("Connection lost. Please refresh.", { type: "error" });
    showLogin();
  });
  
  socket.on("disconnect", () => {
    console.log("Socket disconnected");
  });
}

// ══════════════════════════════════════════════════════
// STATS RENDERING
// ══════════════════════════════════════════════════════

function renderStats(stats) {
  if (!stats) return;
  
  // Online status
  const isOnline = stats.online === true;
  onlineLed.className = "online-dot " + (isOnline ? "on" : "off");
  onlineRing.classList.toggle("pulsing", isOnline);
  statusLabel.textContent = isOnline ? "Online" : "Offline";
  
  // Stats
  statPing.textContent = stats.ping >= 0 ? `${stats.ping}ms` : "—";
  statGuilds.textContent = stats.guildCount || "—";
  statLive.textContent = `${stats.activePlayers || 0}/${stats.totalPlayers || 0}`;
  statUptime.textContent = stats.uptimeMs ? formatUptime(stats.uptimeMs) : "—";
}

// ══════════════════════════════════════════════════════
// SPOTLIGHT RENDERING
// ══════════════════════════════════════════════════════

function pickSpotlight(players) {
  const live = players.filter(p => p.playing && !p.paused);
  return live.reduce((best, p) => (p.listeners > (best?.listeners ?? -1) ? p : best), null);
}

function renderSpotlight(players) {
  const top = pickSpotlight(players);
  
  if (!top?.current) {
    spotlightEl.classList.add("hidden");
    vizPlaying = false;
    return;
  }
  
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

// ══════════════════════════════════════════════════════
// PLAYERS RENDERING
// ══════════════════════════════════════════════════════

function renderPlayers(players = []) {
  if (!players) return;
  
  currentPlayers = players;
  renderSpotlight(players);
  
  // Show/hide empty state
  const hasActive = players.some(p => p.playing || p.paused);
  emptyStateEl.classList.toggle("hidden", hasActive);
  
  // Update or create cards
  const existingIds = new Set(cards.keys());
  const incomingIds = new Set(players.map(p => p.guildId));
  
  // Remove cards for disconnected guilds
  for (const id of existingIds) {
    if (!incomingIds.has(id)) {
      const card = cards.get(id);
      if (card) card.remove();
      cards.delete(id);
    }
  }
  
  // Update or create cards
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
}

// ══════════════════════════════════════════════════════
// CARD CREATION & UPDATING
// ══════════════════════════════════════════════════════

function createCard(player) {
  const clone = template.content.cloneNode(true);
  const card = clone.querySelector(".channel-card");
  card.setAttribute("data-guild-id", player.guildId);
  
  // Initialize empty state
  card.querySelector(".cc-track-title").textContent = "Nothing playing";
  card.querySelector(".cc-track-author").textContent = "";
  card.querySelector(".cc-guild-name").textContent = player.guildName || "Unknown";
  
  return card;
}

function updateCard(card, player) {
  // Update badge
  const badge = card.querySelector(".cc-badge");
  badge.className = "cc-badge";
  if (player.playing && !player.paused) {
    badge.className = "cc-badge badge-playing";
    badge.textContent = "On Air";
  } else if (player.paused) {
    badge.className = "cc-badge badge-paused";
    badge.textContent = "Paused";
  } else if (player.afk) {
    badge.className = "cc-badge badge-afk";
    badge.textContent = "AFK";
  } else {
    badge.className = "cc-badge badge-idle";
    badge.textContent = "Idle";
  }
  
  // Track info
  const track = player.current;
  card.querySelector(".cc-art").src = track?.artwork || FALLBACK_ART;
  
  const titleEl = card.querySelector(".cc-track-title");
  const newTitle = track?.title || "Nothing playing";
  const prevTitle = lastTrackTitles.get(player.guildId);
  
  if (track && prevTitle !== undefined && prevTitle !== newTitle) {
    const artEl = card.querySelector(".cc-art");
    const rect = artEl.getBoundingClientRect();
    burstAt(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      SOURCE_COLORS[track.source] || SOURCE_COLORS.default
    );
  }
  
  lastTrackTitles.set(player.guildId, newTitle);
  titleEl.textContent = newTitle;
  applyMarquee(titleEl);
  
  card.querySelector(".cc-track-author").textContent = track?.author || "";
  card.querySelector(".cc-guild-name").textContent = player.guildName || "Unknown";
  
  // Progress
  const pct = track?.duration ? Math.min(100, (player.position / track.duration) * 100) : 0;
  card.querySelector(".cc-prog .prog-fill").style.width = `${pct}%`;
  card.querySelector(".prog-elapsed").textContent = player.positionFmt || "0:00";
  card.querySelector(".prog-duration").textContent = track?.durationFmt || "0:00";
  
  // Play/pause button
  const ppBtn = card.querySelector(".act-playpause");
  if (player.paused) {
    ppBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    ppBtn.title = "Resume";
  } else {
    ppBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>';
    ppBtn.title = "Pause";
  }
  
  // Volume
  const volSlider = card.querySelector(".act-volume");
  if (document.activeElement !== volSlider) {
    volSlider.value = player.volume;
  }
  card.querySelector(".vol-val").textContent = player.volume;
  
  // Loop buttons
  for (const btn of card.querySelectorAll(".act-loop")) {
    btn.classList.toggle("is-active", btn.dataset.mode === player.repeatMode);
  }
  
  // Queue
  card.querySelector(".queue-count").textContent = player.queueLength || 0;
  const queueList = card.querySelector(".queue-list");
  queueList.innerHTML = "";
  
  if (player.queue && player.queue.length > 0) {
    player.queue.forEach((track, i) => {
      const li = document.createElement("li");
      const num = document.createElement("span");
      num.className = "qi-num";
      num.textContent = `${i + 1}.`;
      const title = document.createElement("span");
      title.className = "qi-title";
      title.textContent = track.title;
      const dur = document.createElement("span");
      dur.className = "qi-dur";
      dur.textContent = track.durationFmt || "0:00";
      li.append(num, title, dur);
      queueList.appendChild(li);
    });
  }
}

// ══════════════════════════════════════════════════════
// CARD CONTROL WIRING
// ══════════════════════════════════════════════════════

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
        toast(data.error || `Couldn't ${action}.`, { type: "error" });
        return;
      }
      
      if (successMessage) toast(successMessage);
    } catch (err) {
      console.error(`Action error (${action}):`, err);
      toast(`Connection issue.`, { type: "error" });
    }
  };
  
  // Play/Pause
  card.querySelector(".act-playpause").addEventListener("click", () => {
    const isPaused = card.querySelector(".act-playpause").title === "Resume";
    post(isPaused ? "resume" : "pause", null, {
      successMessage: isPaused ? "Resumed ▶" : "Paused ⏸"
    });
  });
  
  // Skip
  card.querySelector(".act-skip").addEventListener("click", () =>
    post("skip", null, { successMessage: "Skipped ⏭" }));
  
  // Shuffle
  card.querySelector(".act-shuffle").addEventListener("click", () =>
    post("shuffle", null, { successMessage: "Queue shuffled 🔀" }));
  
  // Stop
  card.querySelector(".act-stop").addEventListener("click", () =>
    post("stop", null, { successMessage: "Stopped ⏹" }));
  
  // Disconnect
  card.querySelector(".act-disconnect").addEventListener("click", async () => {
    if (await askConfirm("Disconnect from voice and clear the queue?")) {
      post("disconnect", null, { successMessage: "Disconnected" });
    }
  });
  
  // Volume
  const volSlider = card.querySelector(".act-volume");
  volSlider.addEventListener("input", () => {
    card.querySelector(".vol-val").textContent = volSlider.value;
  });
  volSlider.addEventListener("change", () => {
    post("volume", { level: Number(volSlider.value) }, {
      successMessage: `Volume → ${volSlider.value}`
    });
  });
  
  // Loop
  for (const btn of card.querySelectorAll(".act-loop")) {
    btn.addEventListener("click", () =>
      post("loop", { mode: btn.dataset.mode }, {
        successMessage: `Loop: ${btn.dataset.mode}`
      }));
  }
  
  // Wire search
  wireSearch(card, guildId);
}

// ══════════════════════════════════════════════════════
// SEARCH FUNCTIONALITY
// ══════════════════════════════════════════════════════

function wireSearch(card, guildId) {
  const input   = card.querySelector(".search-input");
  const btn     = card.querySelector(".act-search");
  const results = card.querySelector(".search-results");
  
  let reqId = 0;
  let debounce = null;
  
  function setResults(html) {
    results.innerHTML = html;
    results.classList.remove("hidden");
  }
  
  function buildItem(track) {
    const li = document.createElement("li");
    li.className = "search-result";
    
    const img = document.createElement("img");
    img.className = "sr-art";
    img.src = track.artwork || FALLBACK_ART;
    img.alt = "Album art";
    
    const info  = document.createElement("div");
    info.className = "sr-info";
    const title = document.createElement("div");
    title.className = "sr-title";
    title.textContent = track.title;
    const meta  = document.createElement("div");
    meta.className = "sr-meta";
    meta.textContent = `${track.author} · ${track.durationFmt || "0:00"}`;
    info.append(title, meta);
    
    const add = document.createElement("button");
    add.type = "button";
    add.className = "sr-add";
    add.title = "Add to queue";
    add.textContent = "+";
    add.addEventListener("click", () => enqueue(track.token, track.title));
    
    li.append(img, info, add);
    return li;
  }
  
  async function enqueue(token, title) {
    try {
      const res = await apiFetch(`/api/players/${guildId}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(data.error || "Couldn't add track.", { type: "error" });
        return;
      }
      
      toast(`Added: ${title}`);
      results.classList.add("hidden");
      results.innerHTML = "";
      input.value = "";
    } catch (err) {
      console.error("Enqueue error:", err);
      toast("Connection issue.", { type: "error" });
    }
  }
  
  async function search() {
    const query = input.value.trim();
    if (!query) {
      results.classList.add("hidden");
      results.innerHTML = "";
      return;
    }
    
    const id = ++reqId;
    setResults(`<li class="search-status">Searching…</li>`);
    
    try {
      const res = await apiFetch(
        `/api/players/${guildId}/search?query=${encodeURIComponent(query)}`
      );
      
      if (id !== reqId) return;
      
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setResults(`<li class="search-status">${data.error || "Search failed."}</li>`);
        return;
      }
      
      const data = await res.json();
      const tracks = data.results || [];
      
      if (id !== reqId) return;
      
      if (!tracks.length) {
        setResults(`<li class="search-status">No results found.</li>`);
        return;
      }
      
      results.innerHTML = "";
      results.classList.remove("hidden");
      for (const track of tracks) {
        results.appendChild(buildItem(track));
      }
    } catch (err) {
      if (id !== reqId) return;
      console.error("Search error:", err);
      setResults(`<li class="search-status">Connection issue — try again.</li>`);
    }
  }
  
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(search, 300);
  });
  
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(debounce);
      search();
    }
  });
  
  btn.addEventListener("click", () => {
    clearTimeout(debounce);
    search();
  });
  
  document.addEventListener("click", e => {
    if (!card.contains(e.target)) {
      results.classList.add("hidden");
    }
  });
}

// ══════════════════════════════════════════════════════
// INITIALIZATION
// ══════════════════════════════════════════════════════

(async function init() {
  try {
    const res = await fetch("/api/me");
    const data = await res.json();
    
    if (data.authenticated) {
      showDashboard();
    } else {
      showLogin();
    }
  } catch (err) {
    console.error("Init error:", err);
    showLogin();
  }
})();
