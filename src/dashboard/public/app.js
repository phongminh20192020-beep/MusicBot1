"use strict";

const $ = sel => document.querySelector(sel);

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

const FALLBACK_ART =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='100%25' height='100%25' fill='%231e1e24' rx='8'/%3E%3C/svg%3E";

const SOURCE_COLORS = {
  spotify:      "#22d3a3",
  youtube:      "#f87171",
  youtubemusic: "#f59e0b",
  default:      "#6c63ff",
};

let socket = null;
const cards = new Map();
const lastTrackTitles = new Map();

// ── Toasts ────────────────────────────────────────────────────
function toast(message, { type = "success" } = {}) {
  const el = document.createElement("div");
  el.className = `toast${type === "error" ? " toast-error" : ""}`;
  el.textContent = message;
  toastStack.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast-leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, 2800);
}

// ── Confirm modal ──────────────────────────────────────────────
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

// ── Burst particles on track change ───────────────────────────
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
  requestAnimationFrame(() => {
    const overflow = el.scrollWidth > el.clientWidth + 2;
    el.classList.toggle("marquee", overflow);
    if (overflow && !el.querySelector("span")) {
      el.innerHTML = `<span>${el.textContent}</span>`;
    } else if (!overflow) {
      el.textContent = el.textContent;
    }
  });
}

// ── Spotlight canvas ring ──────────────────────────────────────
const spotlightViz  = $("#spotlight-viz");
const vizCtx        = spotlightViz.getContext("2d");
let vizPlaying = false;
let vizColor   = SOURCE_COLORS.default;

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
    }
  }
  requestAnimationFrame(drawViz);
}
requestAnimationFrame(drawViz);

// ── Auth ───────────────────────────────────────────────────────
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, credentials: "same-origin" });
  if (res.status === 401) { showLogin(); throw new Error("unauthenticated"); }
  return res;
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
  try {
    const res  = await fetch("/api/login", {
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
  } catch {
    loginError.textContent = "Can't reach the server.";
  } finally {
    btn.disabled = false;
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

// ── Socket / live updates ─────────────────────────────────────
function connectSocket() {
  if (socket) return;
  socket = io({ withCredentials: true });
  socket.on("stats", renderStats);
  socket.on("players", renderPlayers);
  socket.on("connect_error", () => showLogin());
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

function renderStats(stats) {
  $("#online-led").className = "online-dot " + (stats.online ? "on" : "off");
  $("#online-ring").classList.toggle("pulsing", !!stats.online);
  $("#stat-ping").textContent   = stats.ping >= 0 ? `${stats.ping}ms` : "—";
  $("#stat-guilds").textContent = stats.guildCount;
  $("#stat-live").textContent   = `${stats.activePlayers}/${stats.totalPlayers}`;
  $("#stat-uptime").textContent = formatUptime(stats.uptimeMs);
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
  vizColor = SOURCE_COLORS[top.current.source] || SOURCE_COLORS.default;
  $("#spotlight-bg").style.background =
    `radial-gradient(ellipse at 30% 50%, ${vizColor}, transparent 65%)`;

  $("#spotlight-art").src = top.current.artwork || FALLBACK_ART;
  $("#spotlight-guild").textContent = top.guildName;

  const titleEl = $("#spotlight-title");
  titleEl.textContent = top.current.title;
  applyMarquee(titleEl);

  $("#spotlight-author").textContent    = top.current.author;
  $("#spotlight-source").textContent    = top.current.source;
  $("#spotlight-requester").textContent = `req. ${top.current.requester}`;

  const pct = top.current.duration
    ? Math.min(100, (top.position / top.current.duration) * 100) : 0;
  const fill = $("#spotlight-fill");
  fill.style.width = `${pct}%`;
  fill.style.background = `linear-gradient(90deg, ${vizColor}88, ${vizColor})`;
  $("#spotlight-elapsed").textContent  = top.positionFmt;
  $("#spotlight-duration").textContent = top.current.durationFmt;
}

// ── Render players ─────────────────────────────────────────────
function renderPlayers(players) {
  const seen = new Set();
  for (const p of players) {
    seen.add(p.guildId);
    let card = cards.get(p.guildId);
    if (!card) {
      card = template.content.firstElementChild.cloneNode(true);
      channelsEl.appendChild(card);
      cards.set(p.guildId, card);
      wireCard(card, p.guildId);
    }
    updateCard(card, p);
  }
  for (const [guildId, card] of cards) {
    if (!seen.has(guildId)) { card.remove(); cards.delete(guildId); }
  }
  emptyStateEl.classList.toggle("hidden", players.length > 0);
  channelsEl.classList.toggle("hidden", players.length === 0);
  renderSpotlight(players);
}

function updateCard(card, p) {
  card.dataset.guildId = p.guildId;
  card.classList.toggle("is-playing", p.playing && !p.paused);
  card.classList.toggle("is-paused",  p.paused);

  card.querySelector(".card-guild-name").textContent = p.guildName;
  card.querySelector(".card-location").textContent   =
    `${p.channelName} · ${p.listeners} listening`;

  const badge = card.querySelector(".card-badge");
  badge.className = "card-badge" + (p.playing && !p.paused ? " playing" : p.paused ? " paused" : "");
  badge.textContent = p.playing && !p.paused ? "On Air" : p.paused ? "Paused" : p.afk ? "AFK" : "Idle";

  // Track info
  const t = p.current;
  card.querySelector(".card-art").src = t?.artwork || FALLBACK_ART;

  const titleEl = card.querySelector(".card-track-title");
  const newTitle = t?.title || "Nothing playing";
  const prevTitle = lastTrackTitles.get(p.guildId);
  if (t && prevTitle !== undefined && prevTitle !== newTitle) {
    const rect = card.querySelector(".card-art").getBoundingClientRect();
    burstAt(rect.left + rect.width / 2, rect.top + rect.height / 2,
      SOURCE_COLORS[t.source] || SOURCE_COLORS.default);
  }
  lastTrackTitles.set(p.guildId, newTitle);
  titleEl.textContent = newTitle;
  applyMarquee(titleEl);

  card.querySelector(".meta-author").textContent  = t?.author  || "";
  card.querySelector(".meta-source").textContent  = t?.source  || "";

  // Progress
  const pct = t?.duration ? Math.min(100, (p.position / t.duration) * 100) : 0;
  card.querySelector(".card-prog .prog-fill").style.width = `${pct}%`;
  card.querySelector(".prog-elapsed").textContent  = p.positionFmt;
  card.querySelector(".prog-duration").textContent = t?.durationFmt || "0:00";

  // Play/pause icon
  const ppBtn = card.querySelector(".act-playpause");
  ppBtn.innerHTML = p.paused
    ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>`;
  ppBtn.title = p.paused ? "Resume" : "Pause";

  // Volume
  const volSlider = card.querySelector(".act-volume");
  if (document.activeElement !== volSlider) volSlider.value = p.volume;
  card.querySelector(".vol-val").textContent = p.volume;

  // Loop buttons
  for (const btn of card.querySelectorAll(".act-loop")) {
    btn.classList.toggle("is-active", btn.dataset.mode === p.repeatMode);
  }

  // Queue
  card.querySelector(".queue-count").textContent = p.queueLength;
  const queueList = card.querySelector(".queue-list");
  queueList.innerHTML = "";
  p.queue.forEach((track, i) => {
    const li   = document.createElement("li");
    const num  = document.createElement("span");
    num.className = "qi-num"; num.textContent = `${i + 1}.`;
    const title = document.createElement("span");
    title.className = "qi-title"; title.textContent = track.title;
    const dur  = document.createElement("span");
    dur.className = "qi-dur"; dur.textContent = track.durationFmt;
    li.append(num, title, dur);
    queueList.appendChild(li);
  });
}

// ── Wire card controls ─────────────────────────────────────────
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
    } catch {
      toast(`Connection issue.`, { type: "error" });
    }
  };

  card.querySelector(".act-playpause").addEventListener("click", () => {
    const paused = card.querySelector(".act-playpause").title === "Resume";
    post(paused ? "resume" : "pause", null, { successMessage: paused ? "Resumed" : "Paused" });
  });
  card.querySelector(".act-skip").addEventListener("click", () =>
    post("skip", null, { successMessage: "Skipped" }));
  card.querySelector(".act-shuffle").addEventListener("click", () =>
    post("shuffle", null, { successMessage: "Queue shuffled 🔀" }));
  card.querySelector(".act-stop").addEventListener("click", () =>
    post("stop", null, { successMessage: "Stopped" }));
  card.querySelector(".act-disconnect").addEventListener("click", async () => {
    if (await askConfirm("Disconnect from voice and clear the queue?"))
      post("disconnect", null, { successMessage: "Disconnected" });
  });

  const volSlider = card.querySelector(".act-volume");
  volSlider.addEventListener("input", () => {
    card.querySelector(".vol-val").textContent = volSlider.value;
  });
  volSlider.addEventListener("change", () =>
    post("volume", { level: Number(volSlider.value) }, { successMessage: `Volume → ${volSlider.value}` }));

  for (const btn of card.querySelectorAll(".act-loop")) {
    btn.addEventListener("click", () =>
      post("loop", { mode: btn.dataset.mode }, { successMessage: `Loop: ${btn.dataset.mode}` }));
  }

  wireSearch(card, guildId);
}

// ── Search ─────────────────────────────────────────────────────
function wireSearch(card, guildId) {
  const input   = card.querySelector(".search-input");
  const btn     = card.querySelector(".act-search");
  const results = card.querySelector(".search-results");

  let reqId = 0, debounce = null;

  function setResults(html) {
    results.innerHTML = html;
    results.classList.remove("hidden");
  }

  function buildItem(r) {
    const li = document.createElement("li");
    li.className = "search-result";

    const img = document.createElement("img");
    img.className = "sr-art"; img.src = r.artwork || FALLBACK_ART; img.alt = "";

    const info  = document.createElement("div"); info.className = "sr-info";
    const title = document.createElement("div"); title.className = "sr-title"; title.textContent = r.title;
    const meta  = document.createElement("div"); meta.className = "sr-meta";
    meta.textContent = `${r.author} · ${r.durationFmt}`;
    info.append(title, meta);

    const add = document.createElement("button");
    add.className = "sr-add"; add.title = "Add to queue"; add.textContent = "+";
    add.addEventListener("click", () => enqueue(r.token, r.title));

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
        const d = await res.json().catch(() => ({}));
        toast(d.error || "Couldn't add track.", { type: "error" });
        return;
      }
      toast(`Added: ${title}`);
      results.classList.add("hidden");
      results.innerHTML = "";
      input.value = "";
    } catch {
      toast("Connection issue.", { type: "error" });
    }
  }

  async function search() {
    const q = input.value.trim();
    if (!q) { results.classList.add("hidden"); results.innerHTML = ""; return; }

    const id = ++reqId;
    setResults(`<li class="search-status">Searching…</li>`);

    try {
      const res = await apiFetch(`/api/players/${guildId}/search?query=${encodeURIComponent(q)}`);
      if (id !== reqId) return;

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setResults(`<li class="search-status">${d.error || "Search failed."}</li>`);
        return;
      }

      const { results: tracks = [] } = await res.json();
      if (id !== reqId) return;

      if (!tracks.length) { setResults(`<li class="search-status">No results found.</li>`); return; }

      results.innerHTML = "";
      results.classList.remove("hidden");
      for (const r of tracks) results.appendChild(buildItem(r));
    } catch {
      if (id !== reqId) return;
      setResults(`<li class="search-status">Connection issue — try again.</li>`);
    }
  }

  input.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(search, 380); });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); clearTimeout(debounce); search(); }
  });
  btn.addEventListener("click", () => { clearTimeout(debounce); search(); });

  document.addEventListener("click", e => {
    if (!card.contains(e.target)) results.classList.add("hidden");
  });
}

// ── Boot ───────────────────────────────────────────────────────
(async function init() {
  try {
    const res  = await fetch("/api/me");
    const data = await res.json();
    if (data.authenticated) showDashboard();
    else showLogin();
  } catch {
    showLogin();
  }
})();
