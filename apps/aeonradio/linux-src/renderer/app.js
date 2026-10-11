/* Aeon Radio — renderer. Vanilla JS port of the Android Compose UI. */
'use strict';

/* global Hls */

const GENRES = ['Top clicks', 'Top voted', 'rock', 'pop', 'jazz', 'hip-hop',
  'classical', 'electronic', 'country', 'news', 'sports'];
const COUNTRY_CHIPS = [
  ['US', 'USA'], ['GB', 'UK'], ['DE', 'Germany'], ['FR', 'France'],
  ['CA', 'Canada'], ['AU', 'Australia'], ['NL', 'Netherlands'], ['ES', 'Spain'],
];
const SLEEP_OPTIONS = [null, 15, 30, 60, 90];

// ------------------------------------------------------------- state ---
const S = {
  tab: 'browse',
  query: '',
  searching: false,
  genre: 'Top clicks',
  country: null,          // ISO code
  countryName: null,
  stations: [],
  presets: {},            // category -> stations
  presetNames: [],
  loading: false,
  error: null,
  favs: {},               // url -> station
  streams: [],            // custom streams
  recents: [],
  volume: 1.0,
  current: null,          // StationRef
  playing: false,
  buffering: false,
  icyTitle: null,
  playError: null,
  sleepMin: null,
  playerOpen: false,
  loadSeq: 0,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function stationSub(ref) {
  const parts = [];
  if (ref.country) parts.push(ref.country);
  if (ref.tags) {
    const t = ref.tags.split(',').slice(0, 3).join(', ').trim().slice(0, 60);
    if (t) parts.push(t);
  }
  if (ref.bitrate > 0) parts.push(ref.bitrate + 'k' + (ref.codec ? ' ' + ref.codec : ''));
  return parts.join('  •  ');
}

// -------------------------------------------------------------- audio ---
const audio = new Audio();
audio.preload = 'none';
let hls = null;

function destroyHls() {
  if (hls) { try { hls.destroy(); } catch (_) {} hls = null; }
}

audio.addEventListener('playing', () => {
  S.buffering = false; S.playing = true; S.playError = null;
  renderPlayer(); renderList();
});
audio.addEventListener('pause', () => {
  // 'pause' also fires right before a new src loads; only treat as stopped
  // when there is no pending load.
  if (!S.buffering) { S.playing = false; renderPlayer(); renderList(); }
});
audio.addEventListener('waiting', () => { S.buffering = true; renderPlayer(); });
audio.addEventListener('error', () => {
  if (!S.current) return;
  S.buffering = false; S.playing = false;
  S.playError = "Couldn't play this stream. It may be offline or in an unsupported format.";
  renderPlayer(); renderList();
});

function isHlsUrl(url) {
  return String(url).toLowerCase().split('?')[0].endsWith('.m3u8');
}

async function playStation(ref) {
  if (S.current && S.current.url === ref.url) { togglePlay(); return; }
  stopPlayback(false);
  S.current = ref;
  S.icyTitle = null;
  S.playError = null;
  S.buffering = true;
  addRecent(ref);
  renderPlayer(); renderList();
  try {
    const resolved = await window.aeon.invoke('radio.resolve', ref.url);
    if (!S.current || S.current.url !== ref.url) return; // superseded
    if (isHlsUrl(resolved)) {
      if (window.Hls && Hls.isSupported()) {
        destroyHls();
        hls = new Hls({ maxBufferLength: 30 });
        hls.on(Hls.Events.ERROR, (_ev, data) => {
          if (data && data.fatal && S.current && S.current.url === ref.url) {
            S.buffering = false; S.playing = false;
            S.playError = "Couldn't play this stream. It may be offline or in an unsupported format.";
            renderPlayer(); renderList();
          }
        });
        hls.loadSource(resolved);
        hls.attachMedia(audio);
      } else if (audio.canPlayType('application/vnd.apple.mpegurl')) {
        audio.src = resolved; // native HLS (Safari-like)
      } else {
        throw new Error('HLS not supported');
      }
    } else {
      audio.src = resolved;
    }
    audio.volume = S.volume;
    await audio.play();
    // Real ICY metadata tap in the main process (custom header impossible here).
    window.aeon.send('radio.icy-start', resolved);
  } catch (e) {
    if (!S.current || S.current.url !== ref.url) return;
    S.buffering = false; S.playing = false;
    S.playError = "Couldn't play this stream. It may be offline or in an unsupported format.";
    renderPlayer(); renderList();
  }
}

function togglePlay() {
  if (!S.current) return;
  if (S.playing) { audio.pause(); S.playing = false; }
  else { audio.play().catch(() => {}); }
  renderPlayer(); renderList();
}

function stopPlayback(render = true) {
  destroyHls();
  try { audio.pause(); } catch (_) {}
  audio.removeAttribute('src');
  try { audio.load(); } catch (_) {}
  window.aeon.send('radio.icy-stop');
  S.playing = false; S.buffering = false; S.icyTitle = null; S.playError = null;
  if (render) { renderPlayer(); renderList(); }
}

function setVolume(v) {
  S.volume = Math.min(1, Math.max(0, v));
  audio.volume = S.volume;
  $('volume').value = Math.round(S.volume * 100);
  persist();
}

window.aeon.on('radio.now-playing', (p) => {
  if (!p) return;
  // Where the server sends no ICY data we keep showing the station name.
  S.icyTitle = p.title || null;
  renderPlayer();
});

window.aeon.on('sleep.fired', () => {
  stopPlayback();
  S.sleepMin = null;
  renderPlayer();
});

// --------------------------------------------------------------- store ---
async function persist() {
  await window.aeon.invoke('store.save', {
    favs: S.favs, streams: S.streams, recents: S.recents, volume: S.volume,
  });
}

function toggleFav(ref) {
  if (S.favs[ref.url]) delete S.favs[ref.url];
  else S.favs[ref.url] = ref;
  persist();
  renderList(); renderPlayer();
}

function addStream(name, url) {
  const clean = String(url || '').trim();
  if (!clean) return;
  const ref = { name: String(name || '').trim() || clean, url: clean,
    favicon: '', tags: '', country: '', codec: '', bitrate: 0 };
  S.streams = [ref].concat(S.streams.filter((s) => s.url !== ref.url));
  persist();
  renderList();
}

function removeStream(ref) {
  S.streams = S.streams.filter((s) => s.url !== ref.url);
  persist();
  renderList();
}

function addRecent(ref) {
  S.recents = [ref].concat(S.recents.filter((r) => r.url !== ref.url)).slice(0, 20);
  persist();
  if (!S.searching) renderList();
}

function clearRecents() {
  S.recents = [];
  persist();
  renderList();
}

// -------------------------------------------------------------- browse ---
async function loadBrowse() {
  const my = ++S.loadSeq;
  S.loading = true; S.error = null;
  renderList();
  try {
    let result;
    if (S.country) result = await window.aeon.invoke('browser.byCountry', S.country);
    else if (S.genre === 'Top clicks') result = await window.aeon.invoke('browser.topClicks');
    else if (S.genre === 'Top voted') result = await window.aeon.invoke('browser.topVotes');
    else if (S.presets[S.genre]) result = S.presets[S.genre];
    else result = await window.aeon.invoke('browser.byTag', S.genre);
    if (S.loadSeq !== my) return;
    S.stations = result;
  } catch (e) {
    if (S.loadSeq !== my) return;
    S.error = "Couldn't load stations (" + (e && e.message ? e.message : e) +
      '). Check your connection and retry.';
  }
  if (S.loadSeq !== my) return;
  S.loading = false;
  renderList();
}

async function doSearch() {
  const q = S.query.trim();
  if (!q) return;
  const my = ++S.loadSeq;
  S.loading = true; S.error = null; S.searching = true;
  renderChips(); renderList();
  try {
    const result = await window.aeon.invoke('browser.search', q);
    if (S.loadSeq !== my) return;
    S.stations = result;
  } catch (e) {
    if (S.loadSeq !== my) return;
    S.error = 'Search failed (' + (e && e.message ? e.message : e) +
      '). Check your connection and retry.';
  }
  if (S.loadSeq !== my) return;
  S.loading = false;
  renderList();
}

function clearSearch() {
  S.query = ''; $('search').value = '';
  S.searching = false;
  loadBrowse();
}

// --------------------------------------------------------------- sleep ---
async function refreshSleep() {
  try { S.sleepMin = await window.aeon.invoke('sleep.status'); }
  catch (_) { S.sleepMin = null; }
  renderPlayer();
}

function setSleep(opt) {
  if (opt == null) window.aeon.send('sleep.cancel');
  else window.aeon.send('sleep.start', opt);
  refreshSleep();
}

// -------------------------------------------------------------- render ---
function favIcon(ref) {
  const isFav = !!S.favs[ref.url];
  return '<button class="icon-btn fav-btn' + (isFav ? ' fav' : '') + '" data-fav="' +
    esc(ref.url) + '" title="Favorite">' + (isFav ? '★' : '☆') + '</button>';
}

function stationRow(ref, keyPrefix) {
  const isCurrent = S.current && S.current.url === ref.url;
  const sub = stationSub(ref);
  const artHtml = ref.favicon
    ? '<div class="art"><img src="' + esc(ref.favicon) + '" alt="" loading="lazy" onerror="this.remove()"></div>'
    : '<div class="art">♪</div>';
  const playIcon = isCurrent && S.playing ? '⏸' : '▶';
  return '<div class="station-row' + (isCurrent ? ' current' : '') + '" data-play="' + esc(ref.url) + '">' +
    artHtml +
    '<div class="st-info"><div class="st-name">' + esc(ref.name || ref.url) + '</div>' +
    (sub ? '<div class="st-sub">' + esc(sub) + '</div>' : '') + '</div>' +
    favIcon(ref) +
    '<button class="icon-btn play-btn" data-playbtn="' + esc(ref.url) + '" title="Play">' + playIcon + '</button>' +
    '</div>';
}

function renderList() {
  const c = $('content');
  if (S.tab === 'favorites') return renderFavorites(c);
  if (S.tab === 'streams') return renderStreams(c);
  // browse
  if (S.loading) { c.innerHTML = '<div class="spinner"></div>'; return; }
  if (S.error) {
    c.innerHTML = '<div class="error-box">' + esc(S.error) +
      '<br><button class="retry-btn" id="retry-btn">Retry</button></div>';
    $('retry-btn').onclick = () => (S.searching ? doSearch() : loadBrowse());
    return;
  }
  let html = '';
  if (!S.searching && S.recents.length) {
    html += '<div class="section-head"><h3>Recently played</h3>' +
      '<button class="link-btn" id="clear-recents">Clear</button></div>';
    html += S.recents.map((r) => stationRow(r)).join('');
    html += '<div class="section-head"><h3>Stations</h3></div>';
  }
  if (!S.stations.length && !S.recents.length) {
    html += '<div class="center-msg">No stations found.</div>';
  } else {
    html += S.stations.map((r) => stationRow(r)).join('');
  }
  c.innerHTML = html;
  const cr = $('clear-recents');
  if (cr) cr.onclick = clearRecents;
  wireRows(c);
}

function renderFavorites(c) {
  const list = Object.values(S.favs).sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  if (!list.length) {
    c.innerHTML = '<div class="center-msg">No favorites yet.<br>Tap the star on any station to pin it here.</div>';
    return;
  }
  c.innerHTML = list.map((r) => stationRow(r)).join('');
  wireRows(c);
}

function renderStreams(c) {
  let html = '<div id="streams-header"><h3>Your custom streams</h3></div>';
  if (!S.streams.length) {
    html += '<div class="center-msg">No custom streams yet.<br>Tap ＋ to add any http(s) stream URL — LAN IPs work too.</div>';
  } else {
    html += S.streams.map((r) =>
      '<div class="station-row" data-play="' + esc(r.url) + '">' +
      '<div class="art">♪</div>' +
      '<div class="st-info"><div class="st-name">' + esc(r.name) + '</div>' +
      '<div class="st-sub">' + esc(r.url) + '</div></div>' +
      '<button class="icon-btn del-btn" data-del="' + esc(r.url) + '" title="Remove">🗑</button>' +
      '<button class="icon-btn" data-playbtn="' + esc(r.url) + '" title="Play">' +
      (S.current && S.current.url === r.url && S.playing ? '⏸' : '▶') + '</button></div>'
    ).join('');
  }
  c.innerHTML = html;
  wireRows(c);
  c.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const ref = S.streams.find((s) => s.url === b.getAttribute('data-del'));
      if (ref) removeStream(ref);
    };
  });
}

function findRef(url) {
  return S.streams.find((s) => s.url === url) ||
    (S.favs[url] || null) ||
    S.recents.find((r) => r.url === url) ||
    S.stations.find((s) => s.url === url) || null;
}

function wireRows(root) {
  root.querySelectorAll('[data-fav]').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const ref = findRef(b.getAttribute('data-fav'));
      if (ref) toggleFav(ref);
    };
  });
  const playHandler = (ev) => {
    const t = ev.target.closest('[data-play],[data-playbtn]');
    if (!t || ev.target.closest('[data-fav],[data-del]')) return;
    const url = t.getAttribute('data-play') || t.getAttribute('data-playbtn');
    const ref = findRef(url);
    if (ref) playStation(ref);
  };
  root.querySelectorAll('[data-play],[data-playbtn]').forEach((el) => {
    el.addEventListener('click', playHandler);
  });
}

function renderChips() {
  const g = $('genre-chips');
  g.innerHTML = GENRES.map((x) =>
    '<button class="chip' + (!S.searching && !S.country && S.genre === x ? ' selected' : '') +
    '" data-genre="' + esc(x) + '">' + esc(x.charAt(0).toUpperCase() + x.slice(1)) + '</button>').join('');
  g.querySelectorAll('[data-genre]').forEach((b) => {
    b.onclick = () => {
      S.searching = false; S.country = null; S.countryName = null;
      S.genre = b.getAttribute('data-genre');
      renderChips(); loadBrowse();
    };
  });

  const p = $('preset-chips');
  p.innerHTML = S.presetNames.map((x) =>
    '<button class="chip' + (!S.searching && !S.country && S.genre === x ? ' selected' : '') +
    '" data-preset="' + esc(x) + '">' + esc(x) + '</button>').join('');
  p.querySelectorAll('[data-preset]').forEach((b) => {
    b.onclick = () => {
      S.searching = false; S.country = null; S.countryName = null;
      S.genre = b.getAttribute('data-preset');
      renderChips(); loadBrowse();
    };
  });

  const cc = $('country-chips');
  let html = COUNTRY_CHIPS.map(([code, label]) =>
    '<button class="chip' + (!S.searching && S.country === code ? ' selected' : '') +
    '" data-country="' + code + '">' + esc(label) + '</button>').join('');
  if (S.country && !COUNTRY_CHIPS.some(([code]) => code === S.country)) {
    html += '<button class="chip selected" id="country-picked">' + esc(S.countryName || S.country) + '</button>';
  }
  html += '<button class="chip" id="country-more">More…</button>';
  cc.innerHTML = html;
  cc.querySelectorAll('[data-country]').forEach((b) => {
    b.onclick = () => {
      S.searching = false;
      S.country = b.getAttribute('data-country');
      S.countryName = b.textContent;
      renderChips(); loadBrowse();
    };
  });
  $('country-more').onclick = openCountryPicker;
  const picked = $('country-picked');
  if (picked) picked.onclick = openCountryPicker;
}

// --------------------------------------------------------------- player ---
function renderPlayer() {
  const ref = S.current;
  const mini = $('mini-player');
  if (!ref) { mini.classList.remove('visible'); }
  else {
    mini.classList.add('visible');
    const art = ref.favicon
      ? '<img src="' + esc(ref.favicon) + '" alt="" onerror="this.remove()">'
      : '♪';
    $('mini-art').innerHTML = art;
    $('mini-title').textContent = S.icyTitle || ref.name;
    $('mini-sub').textContent = S.icyTitle ? ref.name : stationSub(ref);
    $('mini-sub').style.display = ($('mini-sub').textContent ? '' : 'none');
    $('mini-play').textContent = S.playing ? '⏸' : '▶';
    $('mini-spinner').style.display = S.buffering ? '' : 'none';
    $('mini-play').style.display = S.buffering ? 'none' : '';
  }
  if (!S.playerOpen) return;
  $('player-art').innerHTML = ref && ref.favicon
    ? '<img src="' + esc(ref.favicon) + '" alt="" onerror="this.remove()">' : '♪';
  $('player-title').textContent = S.icyTitle || (ref && ref.name) || 'Nothing playing';
  $('player-station').textContent = (S.icyTitle && ref) ? ref.name : '';
  $('player-meta').textContent = ref ? stationSub(ref) : '';
  $('player-error').textContent = S.playError || '';
  const isFav = ref && !!S.favs[ref.url];
  $('player-fav').textContent = isFav ? '★' : '☆';
  $('player-fav').classList.toggle('fav', !!isFav);
  $('player-fav').disabled = !ref;
  $('player-play').textContent = S.playing ? '⏸' : '▶';
  $('player-play').style.display = S.buffering ? 'none' : '';
  $('player-spinner').style.display = S.buffering ? '' : 'none';
  renderSleepChips();
}

function renderSleepChips() {
  const el = $('sleep-chips');
  el.innerHTML = SLEEP_OPTIONS.map((opt) =>
    '<button class="chip' + (S.sleepMin === opt ? ' selected' : '') +
    '" data-sleep="' + (opt == null ? '' : opt) + '">' +
    (opt == null ? 'Off' : opt + 'm') + '</button>').join('');
  el.querySelectorAll('[data-sleep]').forEach((b) => {
    b.onclick = () => {
      const v = b.getAttribute('data-sleep');
      setSleep(v === '' ? null : parseInt(v, 10));
    };
  });
  $('sleep-note').textContent = S.sleepMin != null
    ? 'Playback stops in ~' + S.sleepMin + ' min' : '';
}

function openPlayer() {
  if (!S.current) return;
  S.playerOpen = true;
  $('player-overlay').classList.add('visible');
  renderPlayer();
}
function closePlayer() {
  S.playerOpen = false;
  $('player-overlay').classList.remove('visible');
}

// -------------------------------------------------------- country picker ---
let countryCache = null;
async function openCountryPicker() {
  $('country-overlay').classList.add('visible');
  $('country-search').value = '';
  const list = $('country-list');
  if (!countryCache) {
    list.innerHTML = '<div class="spinner"></div>';
    try {
      countryCache = await window.aeon.invoke('browser.countries');
    } catch (_) {
      list.innerHTML = '<div class="center-msg">Couldn\'t load the country list. Check your connection and retry.</div>';
      return;
    }
  }
  paintCountries('');
}
function paintCountries(q) {
  const list = $('country-list');
  const query = q.trim().toLowerCase();
  const items = !query ? countryCache
    : countryCache.filter((c) => c.name.toLowerCase().includes(query));
  if (!items.length) { list.innerHTML = '<div class="center-msg">No matches.</div>'; return; }
  list.innerHTML = items.map((c) =>
    '<div class="country-row" data-code="' + esc(c.code) + '" data-name="' + esc(c.name) + '">' +
    '<span class="c-name">' + esc(c.name) + '</span>' +
    '<span class="c-count">' + c.stations + '</span></div>').join('');
  list.querySelectorAll('.country-row').forEach((row) => {
    row.onclick = () => {
      S.searching = false;
      S.country = row.getAttribute('data-code');
      S.countryName = row.getAttribute('data-name');
      $('country-overlay').classList.remove('visible');
      renderChips(); loadBrowse();
    };
  });
}

// ------------------------------------------------------------------ init ---
async function init() {
  // stored state
  try {
    const saved = await window.aeon.invoke('store.load');
    if (saved) {
      S.favs = saved.favs || {};
      S.streams = saved.streams || [];
      S.recents = saved.recents || [];
      S.volume = typeof saved.volume === 'number' ? saved.volume : 1.0;
    }
  } catch (_) {}
  $('volume').value = Math.round(S.volume * 100);
  audio.volume = S.volume;

  // presets
  try {
    S.presets = await window.aeon.invoke('stations.get');
    S.presetNames = Object.keys(S.presets);
  } catch (_) { S.presets = {}; S.presetNames = []; }

  // tabs
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      S.tab = t.getAttribute('data-tab');
      $('browse-controls').style.display = S.tab === 'browse' ? '' : 'none';
      $('fab').style.display = S.tab === 'streams' ? '' : 'none';
      renderList();
    };
  });

  // search
  const search = $('search');
  let debounce = null;
  search.addEventListener('input', () => {
    S.query = search.value;
    clearTimeout(debounce);
    debounce = setTimeout(() => { if (S.query.trim()) doSearch(); }, 600);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(debounce); doSearch(); }
    if (e.key === 'Escape') { clearSearch(); }
  });

  // mini player
  $('mini-player').addEventListener('click', (e) => {
    if (e.target.closest('#mini-play,#mini-stop')) return;
    openPlayer();
  });
  $('mini-play').onclick = (e) => { e.stopPropagation(); togglePlay(); };
  $('mini-stop').onclick = (e) => { e.stopPropagation(); stopPlayback(); };

  // full player
  $('player-close').onclick = closePlayer;
  $('player-overlay').addEventListener('click', (e) => {
    if (e.target === $('player-overlay')) closePlayer();
  });
  $('player-play').onclick = togglePlay;
  $('player-stop').onclick = stopPlayback;
  $('player-fav').onclick = () => { if (S.current) toggleFav(S.current); };
  $('volume').addEventListener('input', (e) => setVolume(e.target.value / 100));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.playerOpen) closePlayer();
  });

  // country picker
  $('country-close').onclick = () => $('country-overlay').classList.remove('visible');
  $('country-overlay').addEventListener('click', (e) => {
    if (e.target === $('country-overlay')) $('country-overlay').classList.remove('visible');
  });
  $('country-search').addEventListener('input', (e) => paintCountries(e.target.value));

  // my streams
  $('fab').onclick = () => {
    $('stream-name').value = '';
    $('stream-url').value = '';
    $('stream-overlay').classList.add('visible');
    $('stream-url').focus();
  };
  $('stream-cancel').onclick = () => $('stream-overlay').classList.remove('visible');
  $('stream-overlay').addEventListener('click', (e) => {
    if (e.target === $('stream-overlay')) $('stream-overlay').classList.remove('visible');
  });
  $('stream-add').onclick = () => {
    addStream($('stream-name').value, $('stream-url').value);
    $('stream-overlay').classList.remove('visible');
  };

  renderChips();
  renderSleepChips();
  refreshSleep();
  loadBrowse();

  window.aeon.send('smoke.ready');
}

document.addEventListener('DOMContentLoaded', init);
