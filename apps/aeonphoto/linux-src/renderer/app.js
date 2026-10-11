'use strict';
/* AeonPhoto renderer — port of the Android Create/Gallery/Model screens. */
const STYLES = ['cinematic photo', 'watercolor painting', '3D render', 'anime-inspired illustration', 'editorial portrait'];
const SHAPES = ['square', 'portrait', 'landscape', 'wide'];

const $ = (id) => document.getElementById(id);
const state = {
  style: STYLES[0],
  shape: SHAPES[0],
  backend: { kind: 'unknown', url: null, detail: 'not checked yet' },
  generating: false,
  modalId: null,
};

function randomSeed() {
  // 32-bit seed like the Android app's Random.nextLong() folded for backends.
  return String(Math.floor(Math.random() * 0x7fffffff));
}

function chips(el, items, current, onPick, fmt) {
  el.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'chip' + (it === current ? ' selected' : '');
    b.textContent = fmt ? fmt(it) : it;
    b.onclick = () => { onPick(it); chips(el, items, it, onPick, fmt); refreshGenerate(); };
    el.appendChild(b);
  }
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tabpage').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'gallery') renderGallery();
}

/** Honest backend state -> UI. Generate is enabled only with prompt + backend. */
function renderBackend() {
  const b = state.backend;
  const ready = b.kind !== 'none' && b.kind !== 'unknown';
  const pill = $('backend-pill');
  pill.textContent = 'backend: ' + (b.kind === 'unknown' ? '…' : b.kind === 'none' ? 'none' : b.kind);
  pill.className = 'pill ' + (ready ? 'pill-ok' : 'pill-none');

  $('backend-label').textContent =
    b.kind === 'unknown' ? 'Checking…' :
    b.kind === 'none' ? 'No backend found' :
    b.kind === 'sdcpp' ? 'stable-diffusion.cpp server' : 'Stable Diffusion WebUI API';
  $('backend-detail').textContent = b.detail || '';
  $('backend-setup').hidden = ready;
  $('backend-ok-note').hidden = !ready;
  $('no-backend-card').hidden = ready;

  console.log('[aeonphoto] backend-state: ' + b.kind + (b.detail ? ' — ' + b.detail : ''));
  refreshGenerate();
}

function refreshGenerate() {
  const hasPrompt = $('prompt').value.trim().length > 0;
  const ready = state.backend.kind !== 'none' && state.backend.kind !== 'unknown';
  $('generate-btn').disabled = !(hasPrompt && ready && !state.generating);
  $('generate-btn').textContent = state.generating ? 'Diffusing…' : 'Generate image';
}

function showError(msg) {
  const e = $('error');
  if (!msg) { e.hidden = true; return; }
  e.textContent = msg;
  e.hidden = false;
}

async function doGenerate() {
  showError(null);
  $('result').hidden = true;
  state.generating = true;
  refreshGenerate();
  $('progress-wrap').hidden = false;
  $('progress-bar').style.width = '2%';
  $('progress-msg').textContent = 'Sending prompt to local backend…';
  const seedNum = parseInt(($('seed').value || '').replace(/[^0-9-]/g, ''), 10);
  try {
    const meta = await window.aeonPhoto.generate({
      prompt: $('prompt').value,
      style: state.style,
      shape: state.shape,
      steps: parseInt($('steps').value, 10),
      seed: Number.isFinite(seedNum) ? seedNum : parseInt(randomSeed(), 10),
    });
    const file = await window.aeonPhoto.galleryFile(meta.id);
    $('result-img').src = 'file://' + file;
    $('result-meta').textContent = `Seed ${meta.seed} · ${meta.steps} steps · ${meta.style}`;
    $('result-save').onclick = () => window.aeonPhoto.saveImage(meta.id);
    $('result-copy').onclick = async () => { await window.aeonPhoto.copyClipboard(meta.id); };
    $('result').hidden = false;
    $('seed').value = randomSeed(); // next generation gets a fresh seed, like Android
  } catch (e) {
    showError(e.message || 'Generation failed');
  } finally {
    state.generating = false;
    $('progress-wrap').hidden = true;
    refreshGenerate();
  }
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function renderGallery() {
  const items = await window.aeonPhoto.galleryList();
  const grid = $('gallery-grid');
  grid.innerHTML = '';
  $('gallery-empty').style.display = items.length ? 'none' : '';
  for (const g of items) {
    const file = await window.aeonPhoto.galleryFile(g.id);
    if (!file) continue;
    const card = document.createElement('button');
    card.className = 'thumb';
    card.title = g.prompt;
    const img = document.createElement('img');
    img.src = 'file://' + file;
    img.alt = g.prompt;
    img.loading = 'lazy';
    card.appendChild(img);
    card.onclick = () => openModal(g, file);
    grid.appendChild(card);
  }
}

async function openModal(g, file) {
  state.modalId = g.id;
  $('modal-title').textContent = g.prompt.slice(0, 80);
  $('modal-img').src = 'file://' + file;
  $('modal-meta').textContent = `${g.style} · ${g.shape} · seed ${g.seed} · ${g.steps} steps\n${fmtDate(g.createdAt)}`;
  $('modal').hidden = false;
}

function closeModal() { $('modal').hidden = true; state.modalId = null; }

function init() {
  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => switchTab(t.dataset.tab); });
  chips($('style-chips'), STYLES, state.style, (s) => { state.style = s; });
  chips($('shape-chips'), SHAPES, state.shape, (s) => { state.shape = s; }, (s) => s[0].toUpperCase() + s.slice(1));

  $('prompt').addEventListener('input', refreshGenerate);
  $('advanced-toggle').onclick = () => {
    const a = $('advanced');
    a.hidden = !a.hidden;
    $('advanced-toggle').textContent = a.hidden ? 'Advanced settings' : 'Hide advanced settings';
  };
  $('steps').addEventListener('input', () => { $('steps-val').textContent = $('steps').value; });
  $('seed').value = randomSeed();
  $('dice').onclick = () => { $('seed').value = randomSeed(); };
  $('generate-btn').onclick = doGenerate;
  $('goto-backend').onclick = () => switchTab('backend');
  $('check-again').onclick = async () => {
    $('backend-label').textContent = 'Checking…';
    state.backend = await window.aeonPhoto.checkBackend();
    renderBackend();
  };
  $('open-folder').onclick = () => window.aeonPhoto.openFolder();

  $('modal-close').onclick = closeModal;
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
  $('modal-save').onclick = () => { if (state.modalId) window.aeonPhoto.saveImage(state.modalId); };
  $('modal-copy').onclick = async () => { if (state.modalId) await window.aeonPhoto.copyClipboard(state.modalId); };
  $('modal-delete').onclick = async () => {
    if (!state.modalId) return;
    await window.aeonPhoto.galleryDelete(state.modalId);
    closeModal();
    renderGallery();
  };

  window.aeonPhoto.onProgress(({ pct, msg }) => {
    $('progress-bar').style.width = Math.round(pct * 100) + '%';
    if (msg) $('progress-msg').textContent = msg;
  });
  window.aeonPhoto.onBackendState((st) => { state.backend = st; renderBackend(); });

  // Initial state fetch, then report readiness (used by --smoke-test).
  window.aeonPhoto.getBackendState().then((st) => {
    state.backend = st;
    renderBackend();
    window.aeonPhoto.rendererReady();
  });
}

document.addEventListener('DOMContentLoaded', init);
