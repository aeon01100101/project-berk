let servers = [];
let settings = {};
let playingId = null;

const $ = (id) => document.getElementById(id);
const logEl = $('log');

function log(line, cls) {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = line;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  while (logEl.children.length > 2000) logEl.removeChild(logEl.firstChild);
}

function currentSettings() {
  return {
    username: $('username').value.trim(),
    ram: settings.ram || '4G',
    gameDir: settings.gameDir || '',
    dataDir: settings.dataDir || '',
    javaPath: settings.javaPath || '',
  };
}

async function refresh() {
  const cfg = await window.enigma.getConfig();
  servers = cfg.servers;
  settings = cfg.settings;
  $('username').value = settings.username || '';
  renderServers();
  servers.forEach(pingCard);
}

function renderServers() {
  const grid = $('serverGrid');
  grid.innerHTML = '';
  servers.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'card-' + s.id;
    const mp = s.modpack || {};
    const modBadge = mp.url
      ? `<span class="badge modded" title="${escapeHtml(mp.name || 'Modpack')}">${escapeHtml(mp.loader || 'Modded')}</span>`
      : `<span class="badge vanilla">Vanilla</span>`;
    card.innerHTML = `
      <div class="card-top">
        <span class="badge">Minecraft ${escapeHtml(s.mcVersion || '1.18.2')}</span>
        <span class="status"><span class="dot checking"></span><span class="status-text">Checking...</span></span>
      </div>
      <h2>${escapeHtml(s.name)}</h2>
      <p class="tagline">${escapeHtml(s.tagline || '')}</p>
      <div class="badges">${modBadge}</div>
      <p class="motd"></p>
      <div class="players"></div>
      <div class="actions">
        <button class="btn primary play-btn">Play</button>
        <button class="btn ghost prepare-btn" title="Download all game files now">&#8681;</button>
      </div>`;
    card.querySelector('.play-btn').addEventListener('click', () => play(s));
    card.querySelector('.prepare-btn').addEventListener('click', () => prepare(s));
    grid.appendChild(card);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function pingCard(server) {
  const card = $('card-' + server.id);
  if (!card) return;
  const dot = card.querySelector('.dot');
  const text = card.querySelector('.status-text');
  const motdEl = card.querySelector('.motd');
  const playersEl = card.querySelector('.players');
  try {
    const res = await window.enigma.ping(server.host, server.port);
    dot.className = 'dot ' + (res.online ? 'online' : 'offline');
    if (res.online) {
      text.textContent = 'Online';
      motdEl.textContent = res.motd || '';
      playersEl.innerHTML = `<b>${res.playersOnline}</b> / ${res.playersMax} players online`;
    } else {
      text.textContent = 'Offline';
      motdEl.textContent = '';
      playersEl.textContent = '';
    }
  } catch {
    dot.className = 'dot offline';
    text.textContent = 'Offline';
  }
}

async function play(server) {
  const st = currentSettings();
  if (!st.username) {
    log('[Enigma] Enter a username first.', 'err');
    $('username').focus();
    return;
  }
  persistUsername();
  log(`[Enigma] Launching ${server.name} as ${st.username}...`);
  setPlaying(server.id, true);
  const res = await window.enigma.play(server, st);
  if (!res.ok) {
    log('[Enigma] ' + res.error, 'err');
    setPlaying(null, false);
  }
}

async function prepare(server) {
  const st = currentSettings();
  persistUsername();
  log(`[Enigma] Pre-downloading files for ${server.name}...`);
  const res = await window.enigma.prepare(server, st);
  if (!res.ok) log('[Enigma] ' + res.error, 'err');
}

function setPlaying(id, running) {
  playingId = running ? id : null;
  document.querySelectorAll('.play-btn').forEach((b) => { b.disabled = running; });
  $('stopBtn').disabled = !running;
  if (running) {
    const card = $('card-' + id);
    if (card) card.querySelector('.play-btn').textContent = 'Running...';
  } else {
    document.querySelectorAll('.play-btn').forEach((b) => { b.textContent = 'Play'; });
  }
}

function persistUsername() {
  settings.username = $('username').value.trim();
  window.enigma.saveSettings({ ...settings, username: settings.username });
}

// ------------------------------------------------------------ settings modal

function openSettings() {
  $('setRam').value = settings.ram || '4G';
  $('setGameDir').value = settings.gameDir || '';
  $('setDataDir').value = settings.dataDir || '';
  $('setJavaPath').value = settings.javaPath || '';
  const wrap = $('serverFields');
  wrap.innerHTML = '';
  servers.forEach((s) => {
    const mp = s.modpack || {};
    const div = document.createElement('div');
    div.className = 'server-edit';
    div.innerHTML = `
      <div class="srv-name">${escapeHtml(s.name)}</div>
      <div class="row">
        <label class="field"><span>Host / IP</span>
          <input type="text" data-srv="${s.id}" data-k="host" value="${escapeHtml(s.host)}" />
        </label>
        <label class="field" style="max-width:110px"><span>Port</span>
          <input type="text" data-srv="${s.id}" data-k="port" value="${escapeHtml(s.port)}" />
        </label>
      </div>
      <label class="field"><span>Modpack name <em>(blank = vanilla)</em></span>
        <input type="text" data-srv="${s.id}" data-k="modpack.name" value="${escapeHtml(mp.name || '')}" placeholder="e.g. HTTYD Normal Pack" />
      </label>
      <label class="field"><span>Modpack zip URL</span>
        <input type="text" data-srv="${s.id}" data-k="modpack.url" value="${escapeHtml(mp.url || '')}" placeholder="https://..." />
      </label>
      <div class="row">
        <label class="field"><span>SHA1 <em>(optional)</em></span>
          <input type="text" data-srv="${s.id}" data-k="modpack.sha1" value="${escapeHtml(mp.sha1 || '')}" placeholder="optional" />
        </label>
        <label class="field"><span>Loader <em>forge-40.2.10 / fabric-0.16.9</em></span>
          <input type="text" data-srv="${s.id}" data-k="modpack.loader" value="${escapeHtml(mp.loader || '')}" placeholder="forge-40.2.10" />
        </label>
      </div>`;
    wrap.appendChild(div);
  });
  $('settingsModal').classList.remove('hidden');
}

async function saveSettings() {
  settings.ram = $('setRam').value;
  settings.gameDir = $('setGameDir').value.trim();
  settings.dataDir = $('setDataDir').value.trim();
  settings.javaPath = $('setJavaPath').value.trim();
  settings.username = $('username').value.trim();
  document.querySelectorAll('#serverFields input').forEach((input) => {
    const srv = servers.find((x) => x.id === input.dataset.srv);
    if (!srv) return;
    const k = input.dataset.k;
    if (k === 'port') srv.port = parseInt(input.value, 10) || 25565;
    else if (k === 'host') srv.host = input.value.trim();
    else if (k.startsWith('modpack.')) {
      srv.modpack = srv.modpack || {};
      srv.modpack[k.slice('modpack.'.length)] = input.value.trim();
    }
  });
  await window.enigma.saveSettings(settings);
  await window.enigma.saveServers(servers);
  $('settingsModal').classList.add('hidden');
  log('[Enigma] Settings saved.', 'ok');
  renderServers();
  servers.forEach(pingCard);
}

// ------------------------------------------------------------ wiring

$('settingsBtn').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', () => $('settingsModal').classList.add('hidden'));
$('saveSettings').addEventListener('click', saveSettings);
$('clearLog').addEventListener('click', () => { logEl.innerHTML = ''; });
$('stopBtn').addEventListener('click', async () => {
  const res = await window.enigma.stop();
  if (!res.ok) log('[Enigma] ' + res.error, 'err');
});
$('username').addEventListener('change', persistUsername);

window.enigma.onLog((line) => {
  const cls = /ERROR|Exception|Failed/i.test(line) ? 'err'
    : /ready|complete|Launching/i.test(line) ? 'ok' : '';
  log(line, cls);
});
window.enigma.onExit((code) => {
  log(`[Enigma] Minecraft closed (exit code ${code}).`);
  setPlaying(null, false);
});

refresh();
setInterval(() => servers.forEach(pingCard), 30000);
