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

// ── State ────────────────────────────────────────────
let socket = null;
let currentPlayers = [];
let activeGuildId = null;
let currentView = "home";

// ── Genre Data (Last.fm tag names) ───────────────────
const GENRES = [
  { name: "Lofi",        tag: "lofi" },
  { name: "Phonk",       tag: "phonk" },
  { name: "Chillhop",    tag: "chillhop" },
  { name: "Britpop",     tag: "britpop" },
  { name: "K-Pop",       tag: "k-pop" },
  { name: "Pop",         tag: "pop" },
  { name: "Reggaeton",   tag: "reggaeton" },
  { name: "Rock",        tag: "rock" },
  { name: "Electronic",  tag: "electronic" },
  { name: "Jazz",        tag: "jazz" },
  { name: "Hip-Hop",     tag: "hip-hop" },
  { name: "R&B",         tag: "rnb" },
];

// ── Helpers ────────────────────────────────────────
function formatTime(ms) {
  if (!ms || ms < 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m + ":" + sec.toString().padStart(2, "0");
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

function isValidImageUrl(url) {
  return url && typeof url === "string" && url.trim().length > 10 && /^https?:\/\//.test(url);
}

const FALLBACK_ARTWORK = '/fallback-artwork.png';

/**
 * PATCH FIX #1: Improved getArtworkStyle with proper CSS escaping
 * Handles URLs with special characters and ensures proper CSS quoting
 */
function getArtworkStyle(track) {
  if (isValidImageUrl(track.artwork)) {
    // Properly escape URL for use in CSS url() function
    const escapedUrl = track.artwork.replace(/['"]/g, '\\$&');
    return 'background-image:url("' + escapedUrl + '");background-size:cover;background-position:center;';
  }
  return 'background-image:url("' + FALLBACK_ARTWORK + '");background-size:cover;background-position:center;';
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
navItems.forEach(item => {
  item.addEventListener('click', e => {
    e.preventDefault();
    navItems.forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    const view = item.dataset.view;
    switchView(view);
  });
});

function switchView(view) {
  currentView = view;
  $$('.view-section').forEach(el => el.classList.add('hidden'));
  switch(view) {
    case 'queue':
      viewQueue.classList.remove('hidden');
      renderQueueView();
      break;
    case 'history':
      viewHistory.classList.remove('hidden');
      renderHistoryView();
      break;
    default:
      viewHome.classList.remove('hidden');
  }
}

// ── Genre Rendering ──────────────────────────────────
function renderGenres() {
  if (!genresScroll) return;
  genresScroll.innerHTML = GENRES.map((g, i) => {
    return '<button class="genre-btn" data-tag="' + g.tag + '">' + g.name + '</button>';
  }).join('');
  genresScroll.querySelectorAll('.genre-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      genresScroll.querySelectorAll('.genre-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadByTag(btn.dataset.tag);
    });
  });
}

// ── Discovery ────────────────────────────────────────
function showSkeletons() {
  if (featuredGrid) featuredGrid.innerHTML = Array(3).fill(0).map(() => '<div class="skeleton featured-card"></div>').join('');
  if (discoverList) discoverList.innerHTML = Array(5).fill(0).map(() => '<div class="skeleton discover-row" style="height:48px;"></div>').join('');
}

async function loadDiscovery() {
  showSkeletons();
  try {
    const res = await apiFetch("/api/lastfm/trending");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    renderFeatured(data.tracks.slice(0, 3));
    renderDiscover(data.tracks);
  } catch (e) {
    featuredGrid.innerHTML = '<div class="discover-empty">Error loading trending tracks</div>';
    discoverList.innerHTML = '';
  }
}

async function loadByTag(tag) {
  showSkeletons();
  try {
    const res = await apiFetch("/api/lastfm/tag?tag=" + encodeURIComponent(tag));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    renderFeatured(data.tracks.slice(0, 3));
    renderDiscover(data.tracks);
  } catch (e) {
    featuredGrid.innerHTML = '<div class="discover-empty">Error loading genre tracks</div>';
    discoverList.innerHTML = '';
  }
}

/**
 * PATCH FIX #2: Featured cards now properly use background-image
 * Changed from img element to div with background to match CSS structure
 */
function renderFeatured(tracks) {
  if (!featuredGrid) return;
  if (!tracks.length) {
    featuredGrid.innerHTML = '<div class="discover-empty">No featured tracks available</div>';
    return;
  }
  featuredGrid.innerHTML = tracks.slice(0, 3).map((t, i) => {
    return '<div class="featured-card" data-uri="' + escapeHtml(t.uri || '') + '" style="' + getArtworkStyle(t) + '">' +
    '<div class="feat-overlay"></div>' +
    '<div class="feat-info"><div class="feat-title">' + escapeHtml(t.title) + '</div><div class="feat-artist">' + escapeHtml(t.artist) + '</div></div>' +
    '</div>';
  }).join('');
  featuredGrid.querySelectorAll('.featured-card').forEach(card => {
    card.addEventListener('click', () => playUri(card.dataset.uri, card.querySelector('.feat-title').textContent));
  });
}

/**
 * PATCH FIX #3: Discover rows with proper HTML escaping
 */
function renderDiscover(tracks) {
  if (!discoverList) return;
  if (!tracks.length) {
    discoverList.innerHTML = '<div class="discover-empty">No tracks found</div>';
    return;
  }
  discoverList.innerHTML = tracks.map((t, i) => {
    return '<div class="discover-row" data-uri="' + escapeHtml(t.uri || '') + '">' +
    '<div class="dr-art" style="' + getArtworkStyle(t) + '"></div>' +
    '<div class="dr-info"><div class="dr-title">' + escapeHtml(t.title) + '</div><div class="dr-artist">' + escapeHtml(t.artist) + '</div></div>' +
    '<div class="dr-actions">' +
    '<span class="dr-dur">' + escapeHtml(t.durationFmt || "3:45") + '</span>' +
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
  if (!uri) { toast("No playable link for this track", {type:"error"}); return; }
  try {
    const res = await apiFetch("/api/players/" + activeGuildId + "/queue", {
      method: "POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({uri: uri})
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
    html += '<div class="qv-header"><span class="qv-guild">' + escapeHtml(player.guildName || 'Unknown') + '</span>';
    html += '<span class="cc-badge ' + (player.playing && !player.paused ? 'badge-playing' : player.paused ? 'badge-paused' : 'badge-idle') + '">' + (player.playing && !player.paused ? 'On Air' : player.paused ? 'Paused' : 'Idle') + '</span></div>';
    if (track) {
      html += '<div class="qv-now"><div class="qv-art" style="' + getArtworkStyle(track) + '"></div>';
      html += '<div><div class="qv-title">' + escapeHtml(track.title) + '</div><div class="qv-author">' + escapeHtml(track.author) + '</div></div></div>';
    }
    const qTracks = player.queue || [];
    if (qTracks.length) {
      html += '<ul class="qv-list">';
      for (let i = 0; i < qTracks.length; i++) {
        html += '<li><span class="q-num">' + (i + 1) + '</span><span class="q-title">' + escapeHtml(qTracks[i].title) + '</span><span class="q-dur">' + escapeHtml(qTracks[i].durationFmt) + '</span></li>';
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
    html += '<div class="qv-header"><span class="qv-guild">' + escapeHtml(player.guildName || 'Unknown') + '</span></div>';
    if (prev.length) {
      html += '<ul class="qv-list">';
      for (let i = 0; i < prev.length; i++) {
        html += '<li><span class="q-num">' + (i + 1) + '</span><span class="q-title">' + escapeHtml(prev[i].title) + '</span><span class="q-dur">' + escapeHtml(prev[i].durationFmt) + '</span></li>';
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

  const active = players.find(p => p.playing || p.paused) || players[0];
  if (active) {
    activeGuildId = active.guildId;
    updateBottomPlayer(active);
  } else {
    activeGuildId = null;
    collapseBottomPlayer();
  }

  if (currentView === 'queue') renderQueueView();
  if (currentView === 'history') renderHistoryView();
}

// ── Bottom Player ────────────────────────────────────
/**
 * PATCH FIX #4: Enhanced bottom player with proper image loading
 * Added error handling and loading states for artwork images
 */
function updateBottomPlayer(player) {
  if (!player || !player.current) { collapseBottomPlayer(); return; }
  const track = player.current;

  bottomPlayer.classList.remove('collapsed');
  
  // Set artwork with proper fallback handling
  const artworkUrl = isValidImageUrl(track.artwork) ? track.artwork : FALLBACK_ARTWORK;
  bpArt.src = artworkUrl;
  bpArt.style.opacity = '0';
  
  // Fade in when loaded
  bpArt.onload = function() { 
    this.style.opacity = '1'; 
    this.style.display = 'block';
  };
  
  // Use fallback if image fails to load
  bpArt.onerror = function() { 
    this.src = FALLBACK_ARTWORK;
    this.style.opacity = '1';
    this.style.display = 'block';
  };
  
  bpTitle.textContent = escapeHtml(track.title || "Unknown");
  bpArtist.textContent = escapeHtml(track.author || "Unknown artist");
  bpGuild.textContent = escapeHtml(player.guildName || "Server");
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
  bpArt.src = '';
}

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
  if (/^https?:\/\//.test(query)) {
    if (!activeGuildId) { toast("No active player. Use /play in Discord first.", {type:"error"}); return; }
    playUri(query, query);
    return;
  }
  toast("Searching: " + query);
  searchLastFm(query);
}

async function searchLastFm(query) {
  showSkeletons();
  try {
    const res = await apiFetch("/api/lastfm/search?q=" + encodeURIComponent(query));
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "HTTP " + res.status);
    }
    const data = await res.json();
    const tracks = data.tracks || [];
    if (!tracks.length) { toast("No results found", {type:"error"}); renderFeatured([]); renderDiscover([]); return; }
    renderFeatured(tracks.slice(0, 3));
    renderDiscover(tracks);
  } catch (e) {
    toast("Search error: " + e.message, {type:"error"});
    if (featuredGrid) featuredGrid.innerHTML = '<div class="discover-empty">Search error: ' + escapeHtml(e.message) + '</div>';
    if (discoverList) discoverList.innerHTML = '';
  }
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
