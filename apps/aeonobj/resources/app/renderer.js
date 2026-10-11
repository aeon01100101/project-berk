// AeonObj renderer: image input -> MeshCore -> OBJ/MTL/PNG export.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const MC = window.MeshCore;

  const state = {
    img: null,      // HTMLImageElement (loaded)
    label: 'model',
    lastDir: null
  };

  // ------------------------------------------------------------ image input
  function setImage(img, label) {
    state.img = img;
    state.label = (label || 'model').slice(0, 40);
    $('preview').src = img.src;
    $('preview-meta').textContent = `${state.label} · ${img.naturalWidth}×${img.naturalHeight}`;
    $('preview-wrap').classList.remove('hidden');
    $('no-image').classList.add('hidden');
    $('model-controls').classList.remove('hidden');
    $('name-input').value = state.label.replace(/[^A-Za-z0-9_.-]/g, '_') || 'model';
    $('result').classList.add('hidden');
  }

  function loadImageFromUrl(url, label) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('could not load image'));
      img.src = url;
    }).then(img => setImage(img, label));
  }

  $('btn-pick').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    loadImageFromUrl(url, f.name.replace(/\.[^.]+$/, '')).catch(err => {
      setStatus($('search-status'), 'Could not load that file.', true);
    });
    e.target.value = '';
  });

  $('btn-url').addEventListener('click', () => {
    const url = $('url-input').value.trim();
    if (!url) return;
    setStatus($('search-status'), 'Loading…');
    loadImageFromUrl(url, 'web_image')
      .then(() => setStatus($('search-status'), ''))
      .catch(() => setStatus($('search-status'),
        'Could not read that URL (the server may block cross-origin access — try downloading the PNG first).', true));
  });

  // ---------------------------------------------------------- web search
  function setStatus(el, msg, isErr) {
    el.textContent = msg || '';
    el.classList.toggle('err', !!isErr);
    if (el.id === 'export-status') {
      const sb = $('sb-status');
      if (sb) sb.textContent = msg || 'Ready.';
    }
  }

  $('btn-search').addEventListener('click', async () => {
    const q = $('search-input').value.trim();
    if (!q) return;
    const box = $('results');
    box.innerHTML = '';
    setStatus($('search-status'), 'Searching…');
    try {
      const api = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*' +
        '&generator=search&gsrsearch=' + encodeURIComponent(q) +
        '&gsrnamespace=6&gsrlimit=30&prop=imageinfo&iiprop=url%7Csize&iiurlwidth=1024';
      const r = await fetch(api);
      const j = await r.json();
      const pages = (j.query && j.query.pages) || {};
      const items = [];
      for (const k of Object.keys(pages)) {
        const p = pages[k];
        const info = (p.imageinfo && p.imageinfo[0]) || {};
        const full = info.url || '';
        if (!/\.(jpe?g|png|webp)$/i.test(full)) continue;
        items.push({
          title: (p.title || '').replace(/^File:/, ''),
          thumb: info.thumburl || full,
          full
        });
      }
      if (!items.length) { setStatus($('search-status'), 'No images found — try another search.', true); return; }
      setStatus($('search-status'), items.length + ' results — click one to use it.');
      for (const it of items) {
        const d = document.createElement('div');
        d.className = 'thumb';
        d.innerHTML = `<img loading="lazy" src="${it.thumb}"><div></div>`;
        d.querySelector('div').textContent = it.title;
        d.addEventListener('click', () => {
          setStatus($('search-status'), 'Loading image…');
          loadImageFromUrl(it.thumb, it.title.slice(0, 30))
            .then(() => setStatus($('search-status'), ''))
            .catch(() => setStatus($('search-status'), 'Could not load that image.', true));
        });
        box.appendChild(d);
      }
    } catch (e) {
      setStatus($('search-status'), 'Search failed: ' + (e.message || e), true);
    }
  });
  $('search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('btn-search').click();
  });

  // ---------------------------------------------------------- mesh options
  const kindRadios = document.querySelectorAll('input[name="kind"]');
  function currentKind() {
    for (const r of kindRadios) if (r.checked) return r.value;
    return 'relief';
  }
  kindRadios.forEach(r => r.addEventListener('change', () => {
    const k = currentKind();
    $('relief-opts').classList.toggle('hidden', k !== 'relief');
    $('extrude-opts').classList.toggle('hidden', k !== 'extrude');
  }));
  $('depth').addEventListener('input', e => $('depth-val').textContent = (+e.target.value).toFixed(2));
  $('detail').addEventListener('input', e => $('detail-val').textContent = e.target.value);
  $('thick').addEventListener('input', e => $('thick-val').textContent = (+e.target.value).toFixed(2));

  // ---------------------------------------------------------- build+export
  function getPixels() {
    const img = state.img;
    const MAX = 1600;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const px = new Int32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      px[i] = (d[i * 4 + 3] << 24) | (d[i * 4] << 16) | (d[i * 4 + 1] << 8) | d[i * 4 + 2];
    }
    return { px, w, h };
  }

  function texturePngBuffer() {
    return new Promise((resolve, reject) => {
      const img = state.img;
      const MAX = 1024;
      const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      cv.toBlob(blob => {
        if (!blob) return reject(new Error('PNG encode failed'));
        blob.arrayBuffer().then(resolve, reject);
      }, 'image/png');
    });
  }

  $('btn-export').addEventListener('click', async () => {
    if (!state.img) return;
    const btn = $('btn-export');
    btn.disabled = true;
    setStatus($('export-status'), 'Building mesh…');
    $('result').classList.add('hidden');
    try {
      // Let the UI paint before the (possibly heavy) mesh build.
      await new Promise(r => setTimeout(r, 30));
      const { px, w, h } = getPixels();
      const kind = currentKind();
      const opts = {
        reliefDetail: +$('detail').value,
        reliefDepth: +$('depth').value,
        reliefInvert: $('invert').checked,
        reliefFromAlpha: $('from-alpha').checked,
        extrudeThickness: +$('thick').value
      };
      const t0 = performance.now();
      const mesh = MC.build(px, w, h, kind, opts);
      const ms = Math.round(performance.now() - t0);
      const verts = mesh.positions.length / 3;
      const tris = mesh.faces.length / 9;

      const name = ($('name-input').value.trim() || 'model').replace(/[^A-Za-z0-9_.-]/g, '_');
      const obj = MC.toObj(mesh, name, name + '.mtl');
      const mtl = MC.toMtl(name + '_tex.png');
      // Auto-rig: build skeleton bones and Blender script (extrude only).
      let rigScript = null, rigBones = 0;
      if (kind === 'extrude' && $('autorrig').checked) {
        setStatus($('export-status'), 'Building auto-rig…');
        const bones = MC.buildRig(px, w, h, kind, opts);
        if (bones && bones.length) {
          rigScript = MC.toBlenderRigScript(bones, name + '.obj', name);
          rigBones = bones.length;
        }
      }
      setStatus($('export-status'), 'Encoding texture…');
      const pngBuffer = await texturePngBuffer();

      setStatus($('export-status'), 'Choose where to save…');
      const res = await window.aeon.saveModel({ name, obj, mtl, pngBuffer, rigScript });
      if (res.canceled) {
        setStatus($('export-status'), 'Save canceled.');
      } else if (res.ok) {
        state.lastDir = res.dir;
        $('result-stats').textContent =
          `${verts.toLocaleString()} vertices · ${tris.toLocaleString()} triangles · built in ${ms} ms` +
          (rigScript ? ` · rig: ${rigBones} bones` : '') +
          '\n' + res.files.map(f => f.split(/[\\/]/).pop()).join('\n');
        $('result').classList.remove('hidden');
        setStatus($('export-status'), '');
      } else {
        setStatus($('export-status'), 'Save failed: ' + (res.error || 'unknown error'), true);
      }
    } catch (e) {
      setStatus($('export-status'), 'Export failed: ' + (e.message || e), true);
    }
    btn.disabled = false;
  });

  $('btn-reveal').addEventListener('click', () => {
    if (state.lastDir) window.aeon.openPath(state.lastDir);
  });

  // Windows 98 title bar buttons
  $('tb-min').addEventListener('click', () => window.aeon.winMin());
  $('tb-max').addEventListener('click', () => window.aeon.winMax());
  $('tb-close').addEventListener('click', () => window.aeon.winClose());
})();
