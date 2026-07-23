"use strict";

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

// ── Device detection ────────────────────────────────
// Tags <html> with data-device="mobile|desktop" and a matching class so CSS
// (and any JS that wants it) can branch on device type. Combines UA sniffing
// with a viewport check so tablets/small windows still get the mobile layout.
function isMobileDevice() {
  const uaMobile = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile|webOS/i.test(navigator.userAgent);
  const narrowViewport = window.matchMedia("(max-width: 768px)").matches;
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  return uaMobile || (narrowViewport && coarsePointer);
}

function applyDeviceClass() {
  const mobile = isMobileDevice();
  document.documentElement.classList.toggle("is-mobile", mobile);
  document.documentElement.classList.toggle("is-desktop", !mobile);
  document.documentElement.setAttribute("data-device", mobile ? "mobile" : "desktop");
}

applyDeviceClass();

let deviceCheckTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(deviceCheckTimer);
  deviceCheckTimer = setTimeout(applyDeviceClass, 200);
});
window.addEventListener("orientationchange", applyDeviceClass);

// ── Elements ─────────────────────────────────────────
const loginScreen   = $("#login-screen");
const loginForm     = $("#login-form");
const loginCard     = $(".login-card");
const loginCardFrame = $(".login-card-frame");
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
const bpLoop         = $("#bp-loop");
const loopPanel       = $("#loop-panel");
const loopOpts        = $("#loop-opts");
const loopOptIndicator = $("#loop-opt-indicator");
const loopPanelFilterBtn = $("#loop-panel-filter-btn");
const loopPanelBack   = $("#loop-panel-back");
const filterGrid       = $("#filter-grid");

const viewHome      = $("#view-home");
const viewQueue     = $("#view-queue");
const viewHistory   = $("#view-history");
const viewFavorites = $("#view-favorites");
const genresScroll  = $("#genres-scroll");
const artistsGrid    = $("#artists-grid");
const artistsLoading = $("#artists-loading");
const featuredGrid  = $("#featured-grid");
const featuredTitleText = $("#featured-title-text");
const featuredLoading = $("#featured-loading");
const discoverLoading = $("#discover-loading");
const discoverBack       = $("#discover-back");
const discoverList       = $("#discover-list");
const suggestionsSection = $("#suggestions-section");
const suggestionsList    = $("#suggestions-list");
const suggestionsSeeAll  = $("#suggestions-see-all");
const suggestionsModal     = $("#suggestions-modal");
const suggestionsModalList = $("#suggestions-modal-list");
const suggestionsModalClose = $("#suggestions-modal-close");
const discoverPagination = $("#discover-pagination");
const dpPrev             = $("#dp-prev");
const dpNext             = $("#dp-next");
const dpLabel            = $("#dp-label");

// ── State ────────────────────────────────────────────
let socket = null;
let currentPlayers = [];
let activeGuildId = null;
let currentView = "home";

// Discover pagination state
let discoverAllTracks = [];   // only used for local (search) pagination
let discoverPage = 0;         // trending/tag mode: 1-based page from server. search mode: 0-based index.
const PAGE_SIZE = 10;

// ── Genre Data (Last.fm tag names) ───────────────────
const GENRES = [
  { name: "Lofi",        tag: "lofi",       color: "#8e6bd6" },
  { name: "Phonk",       tag: "phonk",      color: "#c23b6e" },
  { name: "Chillhop",    tag: "chillhop",   color: "#3f9e7f" },
  { name: "Britpop",     tag: "britpop",    color: "#d9822b" },
  { name: "K-Pop",       tag: "k-pop",      color: "#e0518f" },
  { name: "V-Pop",       tag: "v-pop",      color: "#f2b134" },
  { name: "Pop",         tag: "pop",        color: "#4f6fd9" },
  { name: "Reggaeton",   tag: "reggaeton",  color: "#d94f4f" },
  { name: "Rock",        tag: "rock",       color: "#565a63" },
  { name: "Electronic",  tag: "electronic", color: "#2fb4c9" },
  { name: "Jazz",        tag: "jazz",       color: "#9a6b3c" },
  { name: "Hip-Hop",     tag: "hip-hop",    color: "#6c5ce7" },
  { name: "R&B",         tag: "rnb",        color: "#b13c8f" },
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

const FALLBACK_ARTWORK = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAyMDAgMjAwJz48cmVjdCB3aWR0aD0nMjAwJyBoZWlnaHQ9JzIwMCcgZmlsbD0nIzFhMWEyZScvPjxjaXJjbGUgY3g9JzEwMCcgY3k9JzEwMCcgcj0nOTAnIGZpbGw9JyMxMjEyMmEnLz48cGF0aCBkPSdNODUgNjUgTDg1IDEzMCBRODUgMTQyIDc1IDE0NSBRNTggMTUwIDU1IDEzOCBRNTIgMTI1IDY4IDEyMCBMNzUgMTE4IEw3NSA3NSBMMTI1IDYyIEwxMjUgMTA4IFExMjUgMTIwIDExNSAxMjMgUTk4IDEyOCA5NSAxMTYgUTkyIDEwMyAxMDggOTggTDExNSA5NiBMMTE1IDU4IFonIGZpbGw9JyNlMGUwZTAnLz48L3N2Zz4=';
const NO_SONG_ARTWORK = 'https://i.pinimg.com/736x/98/94/02/9894026f25ad6dac01c9b2315615e338.jpg';

// ── Favorites ─────────────────────────────────────────
let likedKeys = new Set();

function favoriteKey(t) {
  return ((t.uri || (t.artist + "::" + t.title)) || "").toLowerCase();
}

async function loadFavorites() {
  try {
    const res = await apiFetch("/api/favorites");
    if (!res.ok) return;
    const data = await res.json();
    likedKeys = new Set((data.tracks || []).map(favoriteKey));
  } catch { /* favorites are a nice-to-have, fail silently */ }
}

async function toggleFavorite(btn, track) {
  const key = favoriteKey(track);
  const nowLiked = !likedKeys.has(key);
  // Optimistic UI update with a little pop
  btn.classList.toggle('active', nowLiked);
  const svg = btn.querySelector('svg');
  if (svg) svg.setAttribute('fill', nowLiked ? 'currentColor' : 'none');
  btn.classList.add('pop');
  setTimeout(() => btn.classList.remove('pop'), 260);

  try {
    const res = await apiFetch("/api/favorites", {
      method: nowLiked ? "POST" : "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: track.title, artist: track.artist, uri: track.uri, artwork: track.artwork, durationFmt: track.durationFmt }),
    });
    if (!res.ok) throw new Error("Favorite request failed");
    if (nowLiked) likedKeys.add(key); else likedKeys.delete(key);
    toast(nowLiked ? "Added to favorites" : "Removed from favorites");
    loadSuggestions();
    if (currentView === 'favorites') renderFavoritesView();
  } catch {
    // Revert on failure
    btn.classList.toggle('active', !nowLiked);
    if (svg) svg.setAttribute('fill', !nowLiked ? 'currentColor' : 'none');
    toast("Couldn't update favorites", {type:"error"});
  }
}

let allSuggestedTracks = [];

async function loadSuggestions() {
  if (!suggestionsSection || !suggestionsList) return;
  try {
    const res = await apiFetch("/api/favorites/suggestions?limit=20");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    allSuggestedTracks = data.tracks || [];
    if (!allSuggestedTracks.length) { suggestionsSection.classList.add('hidden'); return; }
    suggestionsSection.classList.remove('hidden');
    renderDiscover(allSuggestedTracks.slice(0, 5), suggestionsList);
    if (suggestionsSeeAll) {
      suggestionsSeeAll.classList.toggle('hidden', allSuggestedTracks.length <= 5);
      suggestionsSeeAll.textContent = "See all " + allSuggestedTracks.length + " suggested songs";
    }
  } catch {
    suggestionsSection.classList.add('hidden');
  }
}

if (suggestionsSeeAll) {
  suggestionsSeeAll.addEventListener('click', () => {
    renderDiscover(allSuggestedTracks, suggestionsModalList);
    suggestionsModal.classList.remove('hidden');
  });
}

function closeSuggestionsModal() {
  suggestionsModal.classList.add('hidden');
}

if (suggestionsModalClose) suggestionsModalClose.addEventListener('click', closeSuggestionsModal);
if (suggestionsModal) {
  suggestionsModal.addEventListener('click', e => {
    if (e.target === suggestionsModal) closeSuggestionsModal();
  });
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && suggestionsModal && !suggestionsModal.classList.contains('hidden')) closeSuggestionsModal();
});


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
  loginScreen.classList.remove("hidden", "leaving");
  loginCard.classList.remove("shake", "success");
  const btn = $("#login-btn");
  btn.classList.remove("success");
  btn.disabled = false;
  const btnLabel = btn.querySelector(".login-btn-label");
  if (btnLabel) btnLabel.textContent = "Sign in";
  loginError.classList.remove("show");
  loginError.textContent = "";
  passwordInput.focus();
}

function showDashboard() {
  loginScreen.classList.add("hidden");
  dashboard.classList.remove("hidden");
  connectSocket();
  renderGenres();
  loadFavorites().then(loadSuggestions);
  loadDiscovery();
}

// ── Login screen flourish: button ripple on click ──────
$("#login-btn").addEventListener("click", e => {
  const btn = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const ripple = document.createElement("span");
  ripple.className = "btn-ripple";
  ripple.style.width = ripple.style.height = size + "px";
  ripple.style.left = (e.clientX - rect.left - size / 2) + "px";
  ripple.style.top = (e.clientY - rect.top - size / 2) + "px";
  btn.appendChild(ripple);
  setTimeout(() => ripple.remove(), 650);
});

loginForm.addEventListener("submit", async e => {
  e.preventDefault();
  loginError.classList.remove("show");
  loginError.textContent = "";
  loginCard.classList.remove("shake", "success");
  const btn = $("#login-btn");
  const btnLabel = btn.querySelector(".login-btn-label");
  btn.disabled = true;
  btnLabel.textContent = "Signing in...";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: passwordInput.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      loginError.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="9"></circle><line x1="12" y1="8" x2="12" y2="13"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg><span>' + escapeHtml(data.error || "Incorrect password.") + '</span>';
      loginError.classList.add("show");
      loginCard.classList.remove("shake");
      void loginCard.offsetWidth;
      loginCard.classList.add("shake");
      passwordInput.value = "";
      passwordInput.focus();
      btn.disabled = false;
      btnLabel.textContent = "Sign in";
      return;
    }
    // Success: morph the button into a checkmark, pulse the card green,
    // then fade the whole screen out before the dashboard mounts.
    passwordInput.value = "";
    btn.classList.add("success");
    loginCard.classList.add("success");
    await new Promise(r => setTimeout(r, 550));
    loginScreen.classList.add("leaving");
    await new Promise(r => setTimeout(r, 420));
    showDashboard();
    loginScreen.classList.remove("leaving");
    btn.classList.remove("success");
    loginCard.classList.remove("success");
    btn.disabled = false;
    btnLabel.textContent = "Sign in";
    return;
  } catch (err) {
    loginError.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="9"></circle><line x1="12" y1="8" x2="12" y2="13"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg><span>Network error. Try again.</span>';
    loginError.classList.add("show");
    btn.disabled = false;
    btnLabel.textContent = "Sign in";
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
    case 'favorites':
      viewFavorites.classList.remove('hidden');
      renderFavoritesView();
      break;
    default:
      viewHome.classList.remove('hidden');
  }
}

// ── Genre Rendering ──────────────────────────────────
function renderGenres() {
  if (!genresScroll) return;
  genresScroll.innerHTML = GENRES.map((g) => {
    const bg = 'linear-gradient(135deg, ' + g.color + ' 0%, ' + shadeColor(g.color, -25) + ' 100%)';
    return '<div class="genre-card" data-tag="' + g.tag + '" style="background:' + bg + ';">' +
      '<div class="genre-name">' + g.name + '</div>' +
      '<svg class="genre-note" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>' +
    '</div>';
  }).join('');
  genresScroll.querySelectorAll('.genre-card').forEach(card => {
    card.addEventListener('click', () => {
      genresScroll.querySelectorAll('.genre-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      loadByTag(card.dataset.tag);
    });
  });
}

// Darken/lighten a hex color by percent (negative = darker)
function shadeColor(hex, percent) {
  const num = parseInt(hex.replace('#', ''), 16);
  let r = (num >> 16) + Math.round(2.55 * percent);
  let g = ((num >> 8) & 0x00ff) + Math.round(2.55 * percent);
  let b = (num & 0x0000ff) + Math.round(2.55 * percent);
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return '#' + (0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1);
}

// ── Discovery ────────────────────────────────────────
const discoverTitleText = $("#discover-title-text");

// discoverMode: 'trending' | 'tag' | 'search'
// For 'trending'/'tag', each page is fetched fresh from the server (10 tracks + artwork),
// and the previous page's DOM (and its images) is discarded when we render the new page.
// For 'search', results come back as one batch and are paginated locally.
let discoverMode = 'trending';
let discoverTag = '';
let discoverTotalPages = 1;

function showSkeletons() {
  if (featuredGrid) featuredGrid.innerHTML = Array(3).fill(0).map(() => '<div class="skeleton featured-card"></div>').join('');
  if (discoverList) discoverList.innerHTML = Array(10).fill(0).map(() => '<div class="skeleton discover-row" style="aspect-ratio:1/1.35;"></div>').join('');
}

function setLoadingState(isLoading) {
  if (featuredLoading) featuredLoading.classList.toggle('hidden', !isLoading);
  if (discoverLoading) discoverLoading.classList.toggle('hidden', !isLoading);
}

function updateBackButton() {
  if (!discoverBack) return;
  discoverBack.classList.toggle('hidden', discoverMode === 'trending');
}

// ── Featured Artists ──────────────────────────────────
async function fetchArtists(tag = '') {
  if (!artistsGrid) return;
  if (artistsLoading) artistsLoading.classList.remove('hidden');
  artistsGrid.innerHTML = Array(8).fill(0).map(() =>
    '<div class="skeleton artist-card" style="border-radius:var(--radius-lg);"><div class="skeleton" style="border-radius:50%;aspect-ratio:1/1;width:100%;"></div></div>'
  ).join('');
  try {
    const url = "/api/lastfm/top-artists" + (tag ? "?tag=" + encodeURIComponent(tag) : "");
    const res = await apiFetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    renderArtists(data.artists || []);
  } catch (e) {
    artistsGrid.innerHTML = '<div class="discover-empty">Error loading artists</div>';
  } finally {
    if (artistsLoading) artistsLoading.classList.add('hidden');
  }
}

function renderArtists(artists) {
  if (!artistsGrid) return;
  if (!artists.length) {
    artistsGrid.innerHTML = '<div class="discover-empty">No artists found</div>';
    return;
  }
  artistsGrid.innerHTML = artists.map((a) => {
    const src = isValidImageUrl(a.artwork) ? escapeHtml(a.artwork) : FALLBACK_ARTWORK;
    return '<div class="artist-card" data-artist="' + escapeHtml(a.name) + '" data-artwork="' + src + '">' +
      '<div class="artist-avatar-wrap">' +
        '<img class="artist-avatar" src="' + src + '" alt="" loading="lazy" onerror="this.onerror=null;this.src=FALLBACK_ARTWORK;">' +
        '<div class="artist-play">' +
          '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' +
        '</div>' +
      '</div>' +
      '<div class="artist-name">' + escapeHtml(a.name) + '</div>' +
    '</div>';
  }).join('');

  artistsGrid.querySelectorAll('.artist-card').forEach(card => {
    card.addEventListener('click', () => {
      openArtistPage(card.dataset.artist, card.dataset.artwork);
    });
  });
}

// ── Artist Profile Page ────────────────────────────────
const viewArtist          = $("#view-artist");
const artistPageBack      = $("#artist-page-back");
const artistHeroAvatar    = $("#artist-hero-avatar");
const artistHeroName      = $("#artist-hero-name");
const artistHeroSub       = $("#artist-hero-sub");
const artistPageLoading   = $("#artist-page-loading");
const artistTrackList     = $("#artist-track-list");

const artistSongsLoading    = $("#artist-songs-loading");
const artistSongsList       = $("#artist-songs-list");
const artistSongsPagination = $("#artist-songs-pagination");
const artistSongsDpPrev     = $("#artist-songs-dp-prev");
const artistSongsDpNext     = $("#artist-songs-dp-next");
const artistSongsDpLabel    = $("#artist-songs-dp-label");

let currentArtistName = '';
let artistSongsPage = 1;
let artistSongsTotalPages = 1;
let previousView = 'home';

function openArtistPage(artistName, artworkUrl) {
  previousView = currentView || 'home';
  currentArtistName = artistName;
  $$('.view-section').forEach(el => el.classList.add('hidden'));
  viewArtist.classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });

  if (artistHeroName) artistHeroName.textContent = artistName;
  if (artistHeroSub) artistHeroSub.textContent = '';
  if (artistHeroAvatar) artistHeroAvatar.src = isValidImageUrl(artworkUrl) ? artworkUrl : FALLBACK_ARTWORK;

  loadArtistPopular(artistName);
  loadArtistSongs(artistName, 1);
}

function closeArtistPage() {
  $$('.view-section').forEach(el => el.classList.add('hidden'));
  if (previousView === 'queue') { viewQueue.classList.remove('hidden'); renderQueueView(); }
  else if (previousView === 'history') { viewHistory.classList.remove('hidden'); renderHistoryView(); }
  else { viewHome.classList.remove('hidden'); }
  currentView = previousView;
}

if (artistPageBack) artistPageBack.addEventListener('click', closeArtistPage);

// ── Popular: top 5 tracks by popularity, no pagination ──
async function loadArtistPopular(artistName) {
  if (artistPageLoading) artistPageLoading.classList.remove('hidden');
  if (artistTrackList) {
    artistTrackList.innerHTML = Array(5).fill(0).map(() =>
      '<div class="skeleton at-row" style="height:60px;"></div>'
    ).join('');
  }
  try {
    const res = await apiFetch("/api/lastfm/artist-tracks?artist=" + encodeURIComponent(artistName) + "&page=1");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const tracks = (data.tracks || []).slice(0, 5);
    renderArtistRowList(artistTrackList, tracks, 1);
  } catch (e) {
    if (artistTrackList) artistTrackList.innerHTML = '<div class="discover-empty">Error loading popular tracks</div>';
  } finally {
    if (artistPageLoading) artistPageLoading.classList.add('hidden');
  }
}

// ── Songs: full discography, sorted by official release date, paginated ──
async function loadArtistSongs(artistName, page = 1) {
  if (artistSongsLoading) artistSongsLoading.classList.remove('hidden');
  if (artistSongsList) {
    artistSongsList.innerHTML = Array(10).fill(0).map(() =>
      '<div class="skeleton at-row" style="height:60px;"></div>'
    ).join('');
  }
  try {
    const res = await apiFetch("/api/lastfm/artist-songs?artist=" + encodeURIComponent(artistName) + "&page=" + page);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const songs = data.songs || [];
    artistSongsPage = data.page || page;
    artistSongsTotalPages = data.totalPages || 1;
    const startRank = (artistSongsPage - 1) * 10 + 1;
    renderArtistRowList(artistSongsList, songs, startRank, { showReleaseDate: true });
    updateArtistSongsPagination();
  } catch (e) {
    if (artistSongsList) artistSongsList.innerHTML = '<div class="discover-empty">Error loading songs for this artist</div>';
    if (artistSongsPagination) artistSongsPagination.classList.add('hidden');
  } finally {
    if (artistSongsLoading) artistSongsLoading.classList.add('hidden');
  }
}

function formatReleaseDate(dateStr, precision) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  if (precision === 'year') return String(d.getUTCFullYear());
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: precision === 'month' ? undefined : 'numeric' });
}

function renderArtistRowList(container, items, startRank, opts) {
  if (!container) return;
  opts = opts || {};
  if (!items.length) {
    container.innerHTML = '<div class="discover-empty">No tracks found</div>';
    return;
  }
  container.innerHTML = items.map((t, i) => {
    const src = isValidImageUrl(t.artwork) ? escapeHtml(t.artwork) : FALLBACK_ARTWORK;
    const dateLabel = opts.showReleaseDate ? formatReleaseDate(t.releaseDate, t.releaseDatePrecision) : '';
    return '<div class="at-row" data-uri="' + escapeHtml(t.uri || '') + '">' +
      '<div class="at-rank">' +
        '<span class="at-rank-num">' + (startRank + i) + '</span>' +
        '<span class="at-rank-play"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>' +
      '</div>' +
      '<img class="at-art" src="' + src + '" alt="" loading="lazy" onerror="this.onerror=null;this.src=FALLBACK_ARTWORK;">' +
      '<div class="at-info">' +
        '<div class="at-title">' + escapeHtml(t.title) + '</div>' +
        '<div class="at-artist">' + escapeHtml(t.artist) + (dateLabel ? ' · ' + escapeHtml(dateLabel) : '') + '</div>' +
      '</div>' +
      '<span class="at-dur">' + escapeHtml(t.durationFmt || "3:45") + '</span>' +
    '</div>';
  }).join('');

  container.querySelectorAll('.at-row').forEach(row => {
    row.addEventListener('click', () => {
      playUri(row.dataset.uri, row.querySelector('.at-title').textContent);
    });
  });
}

function updateArtistSongsPagination() {
  if (!artistSongsPagination) return;
  if (artistSongsTotalPages > 1) {
    artistSongsPagination.classList.remove('hidden');
    if (artistSongsDpLabel) artistSongsDpLabel.textContent = artistSongsPage + ' / ' + artistSongsTotalPages;
    if (artistSongsDpPrev) artistSongsDpPrev.disabled = artistSongsPage <= 1;
    if (artistSongsDpNext) artistSongsDpNext.disabled = artistSongsPage >= artistSongsTotalPages;
  } else {
    artistSongsPagination.classList.add('hidden');
  }
}

if (artistSongsDpPrev) {
  artistSongsDpPrev.addEventListener('click', () => {
    if (artistSongsPage > 1) {
      loadArtistSongs(currentArtistName, artistSongsPage - 1).then(() =>
        artistSongsList.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  });
}
if (artistSongsDpNext) {
  artistSongsDpNext.addEventListener('click', () => {
    if (artistSongsPage < artistSongsTotalPages) {
      loadArtistSongs(currentArtistName, artistSongsPage + 1).then(() =>
        artistSongsList.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  });
}


async function loadDiscovery(page = 1) {
  discoverMode = 'trending';
  discoverTag = '';
  updateBackButton();
  if (discoverTitleText) discoverTitleText.textContent = "Discover new music";
  if (featuredTitleText) featuredTitleText.textContent = "Featured for you";
  showSkeletons();
  setLoadingState(true);
  if (page === 1) fetchArtists('');
  try {
    const res = await apiFetch("/api/lastfm/trending?page=" + page);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const tracks = data.tracks || [];
    discoverPage = data.page || page;
    discoverTotalPages = data.totalPages || 1;
    if (page === 1) renderFeatured(tracks.slice(0, 3));
    renderDiscover(tracks);
  } catch (e) {
    featuredGrid.innerHTML = '<div class="discover-empty">Error loading trending tracks</div>';
    discoverList.innerHTML = '';
    if (discoverPagination) discoverPagination.classList.add('hidden');
  } finally {
    setLoadingState(false);
  }
}

async function loadByTag(tag, page = 1) {
  discoverMode = 'tag';
  discoverTag = tag;
  updateBackButton();
  if (discoverTitleText) discoverTitleText.textContent = "Discover new music";
  if (featuredTitleText) featuredTitleText.textContent = "Featured for you";
  showSkeletons();
  setLoadingState(true);
  if (page === 1) fetchArtists(tag);
  try {
    const res = await apiFetch("/api/lastfm/tag?tag=" + encodeURIComponent(tag) + "&page=" + page);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const tracks = data.tracks || [];
    discoverPage = data.page || page;
    discoverTotalPages = data.totalPages || 1;
    if (page === 1) renderFeatured(tracks.slice(0, 3));
    renderDiscover(tracks);
  } catch (e) {
    featuredGrid.innerHTML = '<div class="discover-empty">Error loading genre tracks</div>';
    discoverList.innerHTML = '';
    if (discoverPagination) discoverPagination.classList.add('hidden');
  } finally {
    setLoadingState(false);
  }
}

function renderFeatured(tracks) {
  if (!featuredGrid) return;
  if (!tracks.length) {
    featuredGrid.innerHTML = '<div class="discover-empty">No featured tracks available</div>';
    return;
  }
  featuredGrid.innerHTML = tracks.slice(0, 3).map((t) => {
    const src = isValidImageUrl(t.artwork) ? escapeHtml(t.artwork) : FALLBACK_ARTWORK;
    return '<div class="featured-card" data-uri="' + escapeHtml(t.uri || '') + '">' +
    '<img class="feat-bg" src="' + src + '" alt="" loading="lazy" onerror="this.onerror=null;this.src=FALLBACK_ARTWORK;">' +
    '<div class="feat-overlay"></div>' +
    '<div class="feat-info"><div class="feat-title">' + escapeHtml(t.title) + '</div><div class="feat-artist">' + escapeHtml(t.artist) + '</div></div>' +
    '</div>';
  }).join('');
  featuredGrid.querySelectorAll('.featured-card').forEach(card => {
    card.addEventListener('click', () => playUri(card.dataset.uri, card.querySelector('.feat-title').textContent));
  });
}

/**
 * Renders exactly the tracks it's given as one page — no internal slicing.
 * Replacing discoverList.innerHTML drops the previous page's <img> elements
 * from the DOM, so the browser frees those images from memory/decoded cache.
 */
function renderDiscover(tracks, container) {
  container = container || discoverList;
  if (!container) return;

  if (!tracks.length) {
    container.innerHTML = '<div class="discover-empty">No tracks found</div>';
    if (container === discoverList && discoverPagination) discoverPagination.classList.add('hidden');
    return;
  }

  container.innerHTML = tracks.map((t) => {
    const src = isValidImageUrl(t.artwork) ? escapeHtml(t.artwork) : FALLBACK_ARTWORK;
    const liked = likedKeys.has(favoriteKey(t));
    return '<div class="discover-row" data-uri="' + escapeHtml(t.uri || '') + '">' +
      '<div class="dr-art-wrap">' +
        '<img class="dr-art" src="' + src + '" alt="" loading="lazy" onerror="this.onerror=null;this.src=FALLBACK_ARTWORK;">' +
        '<button class="dr-play" title="Play">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="dr-info">' +
        '<div class="dr-title">' + escapeHtml(t.title) + '</div>' +
        '<div class="dr-artist">' + escapeHtml(t.artist) + '</div>' +
        '<div class="dr-meta-row">' +
          '<span class="dr-dur">' + escapeHtml(t.durationFmt || "3:45") + '</span>' +
          '<span style="display:flex;gap:2px;">' +
            '<button class="dr-btn dr-like' + (liked ? ' active' : '') + '" title="Like"><svg viewBox="0 0 24 24" width="14" height="14" fill="' + (liked ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21.2l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z"></path></svg></button>' +
            '<button class="dr-btn dr-more" title="Add to queue">+</button>' +
          '</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  container.querySelectorAll('.discover-row').forEach((row, i) => {
    const t = tracks[i];
    row.addEventListener('click', e => {
      if (e.target.closest('.dr-btn') || e.target.closest('.dr-play')) return;
      playUri(row.dataset.uri, row.querySelector('.dr-title').textContent);
    });
    const playBtn = row.querySelector('.dr-play');
    if (playBtn) playBtn.addEventListener('click', () => playUri(row.dataset.uri, row.querySelector('.dr-title').textContent));
    const moreBtn = row.querySelector('.dr-more');
    if (moreBtn) moreBtn.addEventListener('click', () => playUri(row.dataset.uri, row.querySelector('.dr-title').textContent));
    const likeBtn = row.querySelector('.dr-like');
    if (likeBtn) likeBtn.addEventListener('click', () => toggleFavorite(likeBtn, t));
  });

  if (container === discoverList) updatePaginationUI();
}

function updatePaginationUI() {
  if (!discoverPagination) return;
  const totalPages = discoverMode === 'search'
    ? Math.max(1, Math.ceil(discoverAllTracks.length / PAGE_SIZE))
    : discoverTotalPages;
  const page = discoverMode === 'search' ? discoverPage + 1 : discoverPage; // both 1-based for display

  if (totalPages > 1) {
    discoverPagination.classList.remove('hidden');
    if (dpLabel) dpLabel.textContent = page + ' / ' + totalPages;
    if (dpPrev)  dpPrev.disabled  = page <= 1;
    if (dpNext)  dpNext.disabled  = page >= totalPages;
  } else {
    discoverPagination.classList.add('hidden');
  }
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
      const qvSrc = isValidImageUrl(track.artwork) ? escapeHtml(track.artwork) : FALLBACK_ARTWORK;
      html += '<div class="qv-now"><img class="qv-art" src="' + qvSrc + '" alt="" loading="lazy" onerror="this.onerror=null;this.src=FALLBACK_ARTWORK;">';
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

async function renderFavoritesView() {
  if (!viewFavorites) return;
  viewFavorites.innerHTML = '<h2 class="discover-title" style="margin-bottom:16px;">Favorites</h2>' +
    '<div class="discover-list" id="favorites-list"></div>';
  const list = $("#favorites-list");
  list.innerHTML = Array(4).fill(0).map(() => '<div class="skeleton discover-row" style="aspect-ratio:1/1.35;"></div>').join('');
  try {
    const res = await apiFetch("/api/favorites");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const tracks = data.tracks || [];
    likedKeys = new Set(tracks.map(favoriteKey));
    if (!tracks.length) {
      viewFavorites.innerHTML = '<h2 class="discover-title" style="margin-bottom:16px;">Favorites</h2>' +
        '<div class="empty-state" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:300px;">' +
        '<div class="empty-icon"><svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></div>' +
        '<h3>No favorites yet</h3><p>Tap the heart on any song to save it here.</p></div>';
      return;
    }
    renderDiscover(tracks, list);
  } catch (e) {
    viewFavorites.innerHTML = '<h2 class="discover-title" style="margin-bottom:16px;">Favorites</h2><div class="discover-empty">Error loading favorites</div>';
  }
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

  const PLAY_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>';
  const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="none"><rect x="5" y="3" width="5" height="18" rx="1"></rect><rect x="14" y="3" width="5" height="18" rx="1"></rect></svg>';
  bpPlaypause.innerHTML = player.paused ? PLAY_ICON : PAUSE_ICON;
  bpPlaypause.title = player.paused ? "Resume" : "Pause";
  bpVol.value = player.volume || 100;
  bpLoop.classList.toggle('active', !!player.repeatMode && player.repeatMode !== "off");
}

function collapseBottomPlayer() {
  bottomPlayer.classList.add('collapsed');
  bpTitle.textContent = "Nothing playing";
  bpArtist.textContent = "Select a server to sync";
  bpGuild.textContent = "No guild";
  bpFill.style.width = "0%";
  bpArt.src = NO_SONG_ARTWORK;
  bpArt.style.opacity = '1';
  bpArt.style.display = 'block';
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
$("#bp-shuffle").addEventListener('click', () => sendCmd('shuffle', {}).then(ok => { if (ok) toast("Queue shuffled"); }));

// ── Loop mode + audio filter popover ─────────────────
const FILTER_PRESETS = [
  { id: "off",       label: "Off (Reset)" },
  { id: "bassboost", label: "Bass Boost" },
  { id: "nightcore",  label: "Nightcore" },
  { id: "vaporwave",  label: "Vaporwave" },
  { id: "slowed",     label: "Slowed" },
  { id: "8d",         label: "8D Audio" },
  { id: "karaoke",    label: "Karaoke" },
  { id: "tremolo",    label: "Tremolo" },
  { id: "vibrato",    label: "Vibrato" },
  { id: "lowpass",    label: "Low Pass" },
  { id: "pop",        label: "Pop" },
];

let activeFilterPreset = "off";

filterGrid.innerHTML = FILTER_PRESETS.map(f =>
  '<button class="filter-chip" data-preset="' + f.id + '"><span class="filter-dot"></span>' + escapeHtml(f.label) + '</button>'
).join('');

function setActiveLoopOpt(mode) {
  loopOpts.querySelectorAll('.loop-opt').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));
  const activeBtn = loopOpts.querySelector('.loop-opt[data-mode="' + mode + '"]');
  if (activeBtn) {
    const idx = [...loopOpts.querySelectorAll('.loop-opt')].indexOf(activeBtn);
    loopOptIndicator.style.transform = 'translateY(' + (idx * 36) + 'px)';
  }
}

function setActiveFilterChip(preset) {
  activeFilterPreset = preset;
  filterGrid.querySelectorAll('.filter-chip').forEach(chip => chip.classList.toggle('active', chip.dataset.preset === preset));
}

function openLoopPanel() {
  loopPanel.classList.add('open');
  bpLoop.classList.add('panel-open');
  const player = currentPlayers.find(p => p.guildId === activeGuildId);
  setActiveLoopOpt(player?.repeatMode || "off");
}

function closeLoopPanel() {
  loopPanel.classList.remove('open', 'showing-filters');
  bpLoop.classList.remove('panel-open');
}

bpLoop.addEventListener('click', e => {
  e.stopPropagation();
  loopPanel.classList.contains('open') ? closeLoopPanel() : openLoopPanel();
});

loopPanelFilterBtn.addEventListener('click', () => loopPanel.classList.add('showing-filters'));
loopPanelBack.addEventListener('click', () => loopPanel.classList.remove('showing-filters'));

loopOpts.addEventListener('click', e => {
  const btn = e.target.closest('.loop-opt');
  if (!btn) return;
  const mode = btn.dataset.mode;
  setActiveLoopOpt(mode);
  sendCmd('loop', { mode }).then(ok => { if (ok) toast("Loop: " + btn.querySelector('span').textContent); });
  closeLoopPanel();
});

filterGrid.addEventListener('click', e => {
  const chip = e.target.closest('.filter-chip');
  if (!chip) return;
  if (!activeGuildId) { toast("No active player", {type:"error"}); return; }
  const preset = chip.dataset.preset;
  setActiveFilterChip(preset);
  apiFetch("/api/players/" + activeGuildId + "/filter", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preset }),
  }).then(async res => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast(data.error || "Filter failed", {type:"error"}); return; }
    toast(preset === "off" ? "Filters reset" : "Filter: " + chip.textContent.trim());
  }).catch(() => toast("Connection issue", {type:"error"}));
});

document.addEventListener('click', e => {
  if (loopPanel.classList.contains('open') && !e.target.closest('.loop-popover-wrap')) closeLoopPanel();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeLoopPanel();
});

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
  if (!activeGuildId) { toast("No active player", {type:"error"}); return false; }
  try {
    const res = await apiFetch("/api/players/" + activeGuildId + "/" + action, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) { const data = await res.json().catch(()=>({})); toast(data.error || "Command failed", {type:"error"}); return false; }
    return true;
  } catch (e) { toast("Connection issue", {type:"error"}); return false; }
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
    const res = await apiFetch("/api/search?q=" + encodeURIComponent(query));
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "HTTP " + res.status);
    }
    const data = await res.json();
    let tracks = data.tracks || [];
    if (!tracks.length) {
      toast("No results found", {type:"error"});
      renderFeatured([]);
      discoverMode = 'search';
      updateBackButton();
      discoverAllTracks = [];
      discoverPage = 0;
      renderDiscover([]);
      return;
    }

    // PRIORITY: tracks with "official" in title or artist go to the top
    tracks.sort((a, b) => {
      const aText = ((a.title || "") + " " + (a.artist || "")).toLowerCase();
      const bText = ((b.title || "") + " " + (b.artist || "")).toLowerCase();
      const aHasOfficial = aText.includes("official") ? 0 : 1;
      const bHasOfficial = bText.includes("official") ? 0 : 1;
      return aHasOfficial - bHasOfficial;
    });

    // Show top 3 as featured cards; paginate the rest locally
    discoverMode = 'search';
    updateBackButton();
    discoverAllTracks = tracks;
    discoverPage = 0;
    renderFeatured(tracks.slice(0, 3));
    renderDiscover(tracks.slice(0, PAGE_SIZE));

    if (discoverTitleText) discoverTitleText.textContent = "Search Results (" + tracks.length + ")";
  } catch (e) {
    toast("Search error: " + e.message, {type:"error"});
    if (featuredGrid) featuredGrid.innerHTML = '<div class="discover-empty">Search error: ' + escapeHtml(e.message) + '</div>';
    if (discoverList) discoverList.innerHTML = '';
    if (discoverPagination) discoverPagination.classList.add('hidden');
  }
}

globalSearchInput.addEventListener("input", () => {
  clearTimeout(globalDebounce);
  globalDebounce = setTimeout(doGlobalSearch, 500);
});

globalSearchInput.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); clearTimeout(globalDebounce); doGlobalSearch(); }
});

// ── Discover back button ──────────────────────────────
if (discoverBack) {
  discoverBack.addEventListener('click', () => {
    if (globalSearchInput) globalSearchInput.value = '';
    genresScroll?.querySelectorAll('.genre-card').forEach(c => c.classList.remove('active'));
    loadDiscovery(1);
  });
}

// ── Discover pagination controls ─────────────────────
function pagedLoader(page) {
  if (discoverMode === 'tag') return loadByTag(discoverTag, page);
  return loadDiscovery(page);
}

if (dpPrev) {
  dpPrev.addEventListener('click', () => {
    if (discoverMode === 'search') {
      if (discoverPage > 0) {
        discoverPage--;
        const start = discoverPage * PAGE_SIZE;
        renderDiscover(discoverAllTracks.slice(start, start + PAGE_SIZE));
        discoverList.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } else {
      if (discoverPage > 1) {
        pagedLoader(discoverPage - 1).then(() => discoverList.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
    }
  });
}
if (dpNext) {
  dpNext.addEventListener('click', () => {
    if (discoverMode === 'search') {
      const totalPages = Math.ceil(discoverAllTracks.length / PAGE_SIZE);
      if (discoverPage < totalPages - 1) {
        discoverPage++;
        const start = discoverPage * PAGE_SIZE;
        renderDiscover(discoverAllTracks.slice(start, start + PAGE_SIZE));
        discoverList.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } else {
      if (discoverPage < discoverTotalPages) {
        pagedLoader(discoverPage + 1).then(() => discoverList.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
    }
  });
}

// ── Init ─────────────────────────────────────────────
(async function init() {
  try {
    const res = await fetch("/api/me");
    const data = await res.json();
    if (data.authenticated) showDashboard(); else showLogin();
  } catch (err) { console.error("Init error:", err); showLogin(); }
})();
