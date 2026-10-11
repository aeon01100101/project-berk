'use strict';
/* AeonCodeNet renderer — Generate / History / Settings tabs.
 * All privileged work (settings file, history store, LLM HTTP, save dialog,
 * clipboard) goes through the window.aeon preload bridge.
 */

(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  function reportError(e) {
    try {
      const msg = (e && e.stack) || (e && e.message) || String(e);
      if (window.aeon && window.aeon.log) window.aeon.log(`FATAL: ${msg}`);
      else console.error(msg);
    } catch (_) { /* last resort */ }
  }
  window.addEventListener('error', (ev) => reportError(ev.error || ev.message));

  try {
    init();
  } catch (e) {
    reportError(e);
  }

  function init() {

  const state = {
    languageId: 'python',
    generating: false,
    resultCode: '',
    resultLanguageId: 'python',
    modalLanguageId: null,
    modalCode: '',
    deleteId: null,
  };

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function formatTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function langOf(id) {
    return (window.aeon.languages.find((l) => l.id === id) || window.aeon.languages[2]);
  }

  // ---- Tabs ---------------------------------------------------------------
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  function showTab(name) {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    if (name === 'history') refreshHistory();
    if (name === 'settings') loadSettingsIntoForm();
  }

  // ---- Generate -----------------------------------------------------------
  function renderChips() {
    const wrap = $('chips');
    wrap.innerHTML = '';
    window.aeon.languages.forEach((lang) => {
      const b = document.createElement('button');
      b.className = 'chip' + (lang.id === state.languageId ? ' selected' : '');
      b.textContent = lang.displayName;
      b.addEventListener('click', () => {
        state.languageId = lang.id;
        renderChips();
      });
      wrap.appendChild(b);
    });
  }

  function setGenerating(on) {
    state.generating = on;
    const btn = $('generate-btn');
    btn.disabled = on;
    btn.innerHTML = on ? '<span class="spinner"></span>Writing code…' : 'Generate code';
    $('regenerate-btn').disabled = on;
  }

  function showError(msg) {
    const box = $('gen-error');
    box.textContent = msg;
    box.classList.remove('hidden');
  }

  function hideError() {
    $('gen-error').classList.add('hidden');
  }

  async function generate() {
    const prompt = $('prompt').value.trim();
    if (!prompt) {
      showError('Describe the program you want first.');
      return;
    }
    hideError();
    setGenerating(true);
    try {
      const { meta, code } = await window.aeon.generate(prompt, state.languageId);
      state.resultCode = code;
      state.resultLanguageId = meta.languageId;
      $('result-meta').textContent = `${meta.language} · ${meta.model}`;
      $('result-code').textContent = code;
      $('result-card').classList.remove('hidden');
      refreshHistory();
    } catch (e) {
      showError((e && e.message) || String(e));
    } finally {
      setGenerating(false);
    }
  }

  $('generate-btn').addEventListener('click', generate);
  $('regenerate-btn').addEventListener('click', generate);
  $('prompt').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') generate();
  });

  $('copy-btn').addEventListener('click', () => window.aeon.copy(state.resultCode));
  $('save-btn').addEventListener('click', async () => {
    const res = await window.aeon.saveCodeDialog(state.resultCode, state.resultLanguageId);
    if (res && res.saved) $('result-meta').textContent += `  ·  saved to ${res.path}`;
  });

  $('open-settings').addEventListener('click', () => showTab('settings'));

  async function checkConfigured() {
    try {
      const cfg = await window.aeon.getSettings();
      $('not-configured').classList.toggle('hidden', !!(cfg && cfg.apiKey));
    } catch (_) {
      $('not-configured').classList.remove('hidden');
    }
  }

  // ---- History ------------------------------------------------------------
  async function refreshHistory() {
    const list = await window.aeon.listHistory();
    const wrap = $('history-list');
    wrap.innerHTML = '';
    $('history-empty').classList.toggle('hidden', list.length !== 0);
    list.forEach((g) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML =
        `<div class="meta">` +
        `<div class="lang">${esc(g.language)}</div>` +
        `<div class="prompt">${esc(g.prompt)}</div>` +
        `<div class="time">${esc(formatTime(g.createdAt))}</div>` +
        `</div>` +
        `<button class="icon-btn" title="Delete">🗑</button>`;
      item.querySelector('.icon-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        askDelete(g);
      });
      item.addEventListener('click', () => openModal(g));
      wrap.appendChild(item);
    });
  }

  async function openModal(g) {
    const code = await window.aeon.readHistoryCode(g.id);
    state.modalLanguageId = g.languageId;
    state.modalCode = code;
    $('modal-title').textContent = `${g.language} · ${g.fileName}`;
    $('modal-prompt').textContent = g.prompt;
    $('modal-code').textContent = code || '(file missing)';
    $('modal').classList.remove('hidden');
  }

  function closeModal() {
    $('modal').classList.add('hidden');
  }

  $('modal-close').addEventListener('click', closeModal);
  $('modal-close2').addEventListener('click', closeModal);
  $('modal').addEventListener('click', (e) => {
    if (e.target === $('modal')) closeModal();
  });
  $('modal-copy').addEventListener('click', () => window.aeon.copy(state.modalCode));
  $('modal-save').addEventListener('click', () =>
    window.aeon.saveCodeDialog(state.modalCode, state.modalLanguageId),
  );

  function askDelete(g) {
    state.deleteId = g.id;
    $('confirm-text').textContent = `“${g.prompt}” (${g.fileName}) will be removed from this machine.`;
    $('confirm-modal').classList.remove('hidden');
  }

  $('confirm-cancel').addEventListener('click', () => {
    $('confirm-modal').classList.add('hidden');
    state.deleteId = null;
  });
  $('confirm-delete').addEventListener('click', async () => {
    if (state.deleteId) await window.aeon.deleteHistory(state.deleteId);
    state.deleteId = null;
    $('confirm-modal').classList.add('hidden');
    refreshHistory();
  });

  // ---- Settings -----------------------------------------------------------
  async function loadSettingsIntoForm() {
    try {
      const cfg = await window.aeon.getSettings();
      $('set-baseurl').value = cfg.baseUrl || '';
      $('set-apikey').value = cfg.apiKey || '';
      $('set-model').value = cfg.model || '';
    } catch (_) {
      /* leave placeholders */
    }
  }

  $('save-settings').addEventListener('click', async () => {
    await window.aeon.setSettings({
      baseUrl: $('set-baseurl').value.trim(),
      apiKey: $('set-apikey').value.trim(),
      model: $('set-model').value.trim(),
    });
    $('settings-saved').classList.remove('hidden');
    checkConfigured();
  });
  ['set-baseurl', 'set-apikey', 'set-model'].forEach((id) => {
    $(id).addEventListener('input', () => $('settings-saved').classList.add('hidden'));
  });

  // ---- Init ---------------------------------------------------------------
  renderChips();
  checkConfigured();
  window.aeon.ready();
  } // end init()
})();
