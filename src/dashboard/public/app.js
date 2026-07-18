"use strict";

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

// ── Elements ─────────────────────────────────────────
const loginScreen   = $("#login-screen");
const loginForm     = $("#login-form");
const loginCard     = $(".login-card");
const loginError    = $("#login-error");
const passwordInput = $("#password-input");
const dashboard     = $("#dashboard");
const toastStack    = $("#toast-stack");
const contentEl     = $("#content");

const statusLabel   = $("#status-label");
const onlineLed     = $("#online-led");
const onlineRing    = $("#online-ring");
const statPing      = $("#stat-ping");
const statGuilds    = $("#stat-guilds");
const statLive      = $("#stat-live");
const statUptime    = $("#stat-uptime");

const bottomPlayer  = $("#bottom-player");
const bpBody        = $("#bp-body");
const bpArt         = $("#bp-art");
const bpTitle       = $("#bp-title");
const bpArtist      = $("#bp-artist");
const bpElapsed     = $("#bp-elapsed");
const bpDuration    = $("#bp-duration");
const bpFill        = $("#bp-fill");
const bpGuild       = $("#bp-guild");
const bpPlaypause   = $("#bp-playpause");
const bpVol         = $("#bp-vol");

const viewHome      = $("#view-home");
const viewQueue     = $("#view-queue");
const viewHistory   = $("#view-history");
const genresScroll  = $("#genres-scroll");
const featuredGrid  = $("#featured-grid");
const discoverList  = $("#discover-list");

const FALLBACK_ART = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='100%25' height='100%25' fill='%231e1e24' rx='8'/%3E%3C/svg%3E";

// ── State ────────────────────────────────────────────
let socket = null;
let currentPlayers = [];
let activeGuildId = null;
let currentView = "home";
let marqueeCache = new Map();

// ── Genre Data ─────────────────────────────────────
const GENRES = [
  { name: "Lofi",        color: "#6b8cae", query: "lofi hip hop radio" },
  { name: "Phonk",       color: "#8b5a2b", query: "phonk music" },
  { name: "Chillhop",    color: "#4a7c59", query: "chillhop beats" },
  { name: "Britpop",     color: "#c4a35a", query: "britpop best" },
  { name: "K-Pop",       color: "#e85d75", query: "kpop hits 2024" },
  { name: "Pop",         color: "#8e7cc3", query: "pop hits 2024" },
  { name: "Reggaeton",   color: "#d4a373", query: "reggaeton 2024" },
  { name: "Rock",        color: "#7a3e3e", query: "rock classics" },
  { name: "Electronic",  color: "#3d8b8b", query: "electronic dance" },
  { name: "Jazz",        color: "#b8860b", query: "jazz classics" },
];

// ── Helpers ────────────────────────────────────────
function formatTime(ms) {
  if (!ms || ms < 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m + ":" + sec.toString().padStart(2, "0");
}

function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const c = (hash & 0x00FFFFFF).toString(16).padStart(6, "0");
  return "#" + c;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + "d " + h + "h";
  if (h > 0) return h + "h " + m + "m";
  return m + "m";
}

function toast(message, opts) {
  opts = opts || {};
  const type = opts.type || "success";
  const el = document.createElement("div");
  el.className = "toast" + (type === "error" ? " toast-error" : "");
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
    let resolved = false;
    const cleanup = result => {
      if (resolved) return;
      resolved = true;
      confirmModal.classList.add("hidden");
      confirmOk.removeEventListener("click", onOk);
      confirmCancel.removeEventListener("click", onCancel);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    confirmOk.addEventListener("click", onOk);
    confirmCancel.addEventListener("click", onCancel);
  });
}

async function apiFetch(url, opts) {
  opts = opts || {};
  try {
    const res = await fetch(url, Object.assign({}, opts, { credentials: "same-origin" }));
    if (res.status === 401) { showLogin(); throw new Error("unauthenticated"); }
    return res;
  } catch (err) {
    if (err.message === "unauthenticated") throw err;
    throw new Error("Network error");
  }
}

// ── Auth ─────────────────────────────────────────────
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
  renderGenres();
  loadDiscovery();
}

loginForm.addEventListener("submit", async e => {
  e.preventDefault();
  loginError.textContent = "";
  const btn = $("#login-btn");
  btn.disabled = true;
  btn.textContent = "Signing in...";
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
      btn.disabled = false;
      btn.textContent = "Sign in";
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

// ── Sidebar Nav ──────────────────────────────────────
const navItems = $$('.sidebar-nav .nav-item');

function switchView(view) {
  currentView = view;
  navItems.forEach(item => {
    item.classList.toggle('active', item.dataset.view === view);
  });
  viewHome.classList.add('hidden');
  viewQueue.classList.add('hidden');
  viewHistory.classList.add('hidden');

  if (view === 'home') {
    viewHome.classList.remove('hidden');
  } else if (view === 'queue') {
    viewQueue.classList.remove('hidden');
    renderQueueView();
  } else if (view === 'history') {
    viewHistory.classList.remove('hidden');
    renderHistoryView();
  }
}

navItems.forEach(item => {
  item.addEventListener('click', e => {
    e.preventDefault();
    switchView(item.dataset.view);
  });
});

// ── Discovery Page ─────────────────────────────────
function renderGenres() {
  if (!genresScroll) return;
  genresScroll.innerHTML = GENRES.map(g =>
    '<div class="genre-card" data-query="' + g.query + '" style="background:' + g.color + '">' +
    '<div class="genre-name">' + g.name + '</div>' +
    '</div>'
  ).join('');
  genresScroll.querySelectorAll('.genre-card').forEach(card => {
    card.addEventListener('click', async () => {
      try {
        const res = await apiFetch("/api/lastfm/genre/" + encodeURIComponent(card.dataset.query));
        if (!res.ok) throw new Error("Genre fetch failed");
        const data = await res.json();
        renderFeatured(data.tracks.slice(0, 3));
        renderDiscover(data.tracks);
        toast("Loaded " + card.dataset.query + " tracks");
      } catch (e) {
        toast("Could not load genre: " + e.message, {type:"error"});
      }
    });
  });
}

function showSkeletons() {
  if (featuredGrid) {
    featuredGrid.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';
  }
  if (discoverList) {
    discoverList.innerHTML = Array(6).fill('<div class="skeleton-row"></div>').join('');
  }
}

async function loadDiscovery() {
  showSkeletons();
  try {
    const res = await apiFetch("/api/lastfm/trending");
    if (res.ok) {
      const data = await res.json();
      const tracks = data.tracks || [];
      renderFeatured(tracks.slice(0, 3));
      renderDiscover(tracks);
    } else {
      throw new Error("API error " + res.status);
    }
  } catch (e) {
    console.error("Last.fm load failed:", e);
    toast("Could not load Last.fm. Check LASTFM_API_KEY.", {type:"error"});
    if (featuredGrid) featuredGrid.innerHTML = '<div class="discover-empty">Unable to load tracks</div>';
    if (discoverList) discoverList.innerHTML = '<div class="discover-empty">Unable to load tracks</div>';
  }
}

function renderFeatured(tracks) {
  if (!featuredGrid) return;
  if (!tracks.length) {
    featuredGrid.innerHTML = '<div class="discover-empty">No featured tracks available</div>';
    return;
  }
  featuredGrid.innerHTML = tracks.slice(0, 3).map((t, i) => {
    const bg = t.artwork ? 'background-image:url(' + t.artwork + ')' : 'background:' + stringToColor(t.title + t.artist);
    return '<div class="featured-card" data-uri="' + (t.uri || '') + '" style="' + bg + ';background-size:cover;background-position:center;">' +
    '<div class="feat-overlay"></div>' +
    '<div class="feat-info"><div class="feat-title">' + escapeHtml(t.title) + '</div><div class="feat-artist">' + escapeHtml(t.artist) + '</div></div>' +
    '</div>';
  }).join('');
  featuredGrid.querySelectorAll('.featured-card').forEach(card => {
    card.addEventListener('click', () => playUri(card.dataset.uri, card.querySelector('.feat-title').textContent));
  });
}

function renderDiscover(tracks) {
  if (!discoverList) return;
  if (!tracks.length) {
    discoverList.innerHTML = '<div class="discover-empty">No tracks found</div>';
    return;
  }
  discoverList.innerHTML = tracks.map((t, i) => {
    const artBg = t.artwork ? 'background-image:url(' + t.artwork + ')' : 'background:' + stringToColor(t.title + t.artist);
    return '<div class="discover-row" data-uri="' + (t.uri || '') + '">' +
    '<div class="dr-art" style="' + artBg + ';background-size:cover;background-position:center;"></div>' +
    '<div class="dr-info"><div class="dr-title">' + escapeHtml(t.title) + '</div><div class="dr-artist">' + escapeHtml(t.artist) + '</div></div>' +
    '<div class="dr-actions">' +
    '<span class="dr-dur">' + (t.durationFmt || "3:45") + '</span>' +
    '<button class="dr-btn dr-like" title="Like">♡</button>' +
    '<button class="dr-btn dr-more" title="Add to queue">+</button>' +
    '</div></div>';
  }).join('');
  discoverList.querySelectorAll('.discover-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.dr-btn')) return;
      playUri(row.dataset.uri, row.querySelector('.dr-title').textContent);
    });
    const moreBtn = row.querySelector('.dr-more');
    if (moreBtn) moreBtn.addEventListener('click', () => playUri(row.dataset.uri, row.querySelector('.dr-title').textContent));
  });
}

async function playUri(uri, title) {
  if (!activeGuildId) { toast("No active player. Use /play in Discord first.", {type:"error"}); return; }
  if (!uri) return;
  try {
    const res = await apiFetch("/api/players/" + activeGuildId + "/queue", {
      method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({uri: uri})
    });
    if (!res.ok) { const data = await res.json().catch(()=>({})); toast(data.error || "Could not add track.", {type:"error"}); return; }
    toast("Added: " + title);
  } catch (e) { toast("Connection issue.", {type:"error"}); }
}

// ── Queue / History Views ────────────────────────────
function renderQueueView() {
  if (!viewQueue) return;
  if (!currentPlayers.length) {
    viewQueue.innerHTML = '<div class="empty-state" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:300px;"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48"><path d="M3 18h12v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg></div><h3>No active players</h3><p>Use /play in Discord to start music.</p></div>';
    return;
  }
  let html = '<h2 class="discover-title" style="margin-bottom:16px;">Queue</h2>';
  for (const player of currentPlayers) {
    const track = player.current;
    html += '<div class="queue-view-card">';
    html += '<div class="qv-header"><span class="qv-guild">' + (player.guildName || 'Unknown') + '</span>';
    html += '<span class="cc-badge ' + (player.playing && !player.paused ? 'badge-playing' : player.paused ? 'badge-paused' : 'badge-idle') + '">' + (player.playing && !player.paused ? 'On Air' : player.paused ? 'Paused' : 'Idle') + '</span></div>';
    if (track) {
      html += '<div class="qv-now"><img src="' + (track.artwork || FALLBACK_ART) + '" class="qv-art" alt="">';
      html += '<div><div class="qv-title">' + track.title + '</div><div class="qv-author">' + track.author + '</div></div></div>';
    }
    const qTracks = player.queue || [];
    if (qTracks.length) {
      html += '<ul class="qv-list">';
      for (let i = 0; i < qTracks.length; i++) {
        html += '<li><span class="q-num">' + (i + 1) + '</span><span class="q-title">' + qTracks[i].title + '</span><span class="q-dur">' + qTracks[i].durationFmt + '</span></li>';
      }
      html += '</ul>';
    } else {
      html += '<p class="qv-empty">Queue is empty</p>';
    }
    html += '</div>';
  }
  viewQueue.innerHTML = html;
}

function renderHistoryView() {
  if (!viewHistory) return;
  if (!currentPlayers.length) {
    viewHistory.innerHTML = '<div class="empty-state" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:300px;"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48"><path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg></div><h3>No history available</h3><p>Play some music first.</p></div>';
    return;
  }
  let html = '<h2 class="discover-title" style="margin-bottom:16px;">History</h2>';
  for (const player of currentPlayers) {
    const prev = player.previous || [];
    html += '<div class="queue-view-card">';
    html += '<div class="qv-header"><span class="qv-guild">' + (player.guildName || 'Unknown') + '</span></div>';
    if (prev.length) {
      html += '<ul class="qv-list">';
      for (let i = 0; i < prev.length; i++) {
        html += '<li><span class="q-num">' + (i + 1) + '</span><span class="q-title">' + prev[i].title + '</span><span class="q-dur">' + prev[i].durationFmt + '</span></li>';
      }
      html += '</ul>';
    } else {
      html += '<p class="qv-empty">No previous tracks</p>';
    }
    html += '</div>';
  }
  viewHistory.innerHTML = html;
}

// ── Socket ───────────────────────────────────────────
function connectSocket() {
  if (socket) return;
  socket = io({ withCredentials: true });
  socket.on("connect", () => console.log("Socket connected"));
  socket.on("stats", renderStats);
  socket.on("players", renderPlayers);
  socket.on("connect_error", err => {
    console.error("Socket error:", err);
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
  statPing.textContent = stats.ping >= 0 ? stats.ping + "ms" : "—";
  statGuilds.textContent = stats.guildCount || "—";
  statLive.textContent = (stats.activePlayers || 0) + "/" + (stats.totalPlayers || 0);
  statUptime.textContent = stats.uptimeMs ? formatUptime(stats.uptimeMs) : "—";
}

function renderPlayers(players) {
  currentPlayers = players || [];
  const hasActive = players.some(p => p.playing || p.paused);

  // Pick first active player for bottom bar
  const active = players.find(p => p.playing || p.paused) || players[0];
  if (active) {
    activeGuildId = active.guildId;
    updateBottomPlayer(active);
  } else {
    activeGuildId = null;
    collapseBottomPlayer();
  }

  // Refresh current view
  if (currentView === 'queue') renderQueueView();
  if (currentView === 'history') renderHistoryView();
}

// ── Bottom Player ────────────────────────────────────
function updateBottomPlayer(player) {
  if (!player || !player.current) { collapseBottomPlayer(); return; }
  const track = player.current;

  bottomPlayer.classList.remove('collapsed');
  bpArt.src = track.artwork || FALLBACK_ART;
  bpTitle.textContent = track.title || "Unknown";
  bpArtist.textContent = track.author || "Unknown artist";
  bpGuild.textContent = player.guildName || "Server";
  bpElapsed.textContent = player.positionFmt || "0:00";
  bpDuration.textContent = track.durationFmt || "0:00";

  const pct = track.duration ? Math.min(100, (player.position / track.duration) * 100) : 0;
  bpFill.style.width = pct + "%";

  bpPlaypause.textContent = player.paused ? "▶" : "⏸";
  bpPlaypause.title = player.paused ? "Resume" : "Pause";
  bpVol.value = player.volume || 100;
}

function collapseBottomPlayer() {
  bottomPlayer.classList.add('collapsed');
  bpTitle.textContent = "Nothing playing";
  bpArtist.textContent = "Select a server to sync";
  bpGuild.textContent = "No guild";
  bpFill.style.width = "0%";
}

// Bottom player controls
bpPlaypause.addEventListener('click', () => {
  if (!activeGuildId) return;
  const player = currentPlayers.find(p => p.guildId === activeGuildId);
  if (!player) return;
  const action = player.paused ? "resume" : "pause";
  sendCmd(action);
});

$("#bp-next").addEventListener('click', () => sendCmd('skip'));
$("#bp-prev").addEventListener('click', () => toast("Previous not implemented", {type:"error"}));
$("#bp-loop").addEventListener('click', () => sendCmd('loop'));
$("#bp-shuffle").addEventListener('click', () => sendCmd('shuffle'));

bpVol.addEventListener('change', () => {
  if (!activeGuildId) return;
  sendCmd('volume', { level: Number(bpVol.value) });
});

// Click collapsed bar to expand (shows a message)
bottomPlayer.addEventListener('click', e => {
  if (bottomPlayer.classList.contains('collapsed')) {
    toast("Use /play in Discord to start music");
  }
});

async function sendCmd(action, body) {
  if (!activeGuildId) { toast("No active player", {type:"error"}); return; }
  try {
    const res = await apiFetch("/api/players/" + activeGuildId + "/" + action, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) { const data = await res.json().catch(()=>({})); toast(data.error || "Command failed", {type:"error"}); }
  } catch (e) { toast("Connection issue", {type:"error"}); }
}

// ── Global Search ────────────────────────────────────
const globalSearchInput = $("#global-search");
let globalDebounce = null;

function doGlobalSearch() {
  const query = globalSearchInput.value.trim();
  if (!query) return;
  switchView('home');
  // If it's a URL, play directly
  if (/^https?:\/\//.test(query)) {
    if (!activeGuildId) { toast("No active player. Use /play in Discord first.", {type:"error"}); return; }
    playUri(query, query);
    return;
  }
  // Otherwise search Last.fm and show results
  toast("Searching: " + query);
  searchLastFm(query);
}

async function searchLastFm(query) {
  try {
    const res = await apiFetch("/api/lastfm/search?q=" + encodeURIComponent(query));
    if (!res.ok) throw new Error("Search failed");
    const data = await res.json();
    const tracks = data.tracks || [];
    if (!tracks.length) { toast("No results found", {type:"error"}); return; }
    renderFeatured(tracks.slice(0, 3));
    renderDiscover(tracks);
  } catch (e) { toast("Search failed: " + e.message, {type:"error"}); }
}

globalSearchInput.addEventListener("input", () => {
  clearTimeout(globalDebounce);
  globalDebounce = setTimeout(doGlobalSearch, 500);
});

globalSearchInput.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); clearTimeout(globalDebounce); doGlobalSearch(); }
});

// ── Init ─────────────────────────────────────────────
(async function init() {
  try {
    const res = await fetch("/api/me");
    const data = await res.json();
    if (data.authenticated) showDashboard(); else showLogin();
  } catch (err) { console.error("Init error:", err); showLogin(); }
})();
