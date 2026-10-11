'use strict';
/**
 * Settings + history persistence for AeonCodeNet (Linux/Electron).
 * Plain CommonJS so it can be required by main.js and the node unit tests.
 *
 * Mirrors the Android app:
 *   llm/LlmSettings.kt  -> makeSettingsStore(dir)
 *   data/CodeStore.kt   -> makeHistoryStore(dir)
 *
 * Settings note: the Android app uses EncryptedSharedPreferences. On Linux
 * there is no equivalent OS keyring integration yet, so the API key is kept
 * in a JSON file with mode 0600 (owner read/write only) inside the app's
 * config dir. This limitation is stated honestly in the Settings UI.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const llm = require('./llm');

const SETTINGS_MODE = 0o600;

function makeSettingsStore(dir) {
  const file = path.join(dir, 'settings.json');

  function cleanConfig(raw) {
    return {
      baseUrl: ((raw && raw.baseUrl) || '').trim() || llm.DEFAULT_CONFIG.baseUrl,
      apiKey: ((raw && raw.apiKey) || '').trim(),
      model: ((raw && raw.model) || '').trim() || llm.DEFAULT_CONFIG.model,
    };
  }

  function load() {
    try {
      return cleanConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (_) {
      return Object.assign({}, llm.DEFAULT_CONFIG);
    }
  }

  function save(config) {
    const clean = cleanConfig(config);
    fs.mkdirSync(dir, { recursive: true });
    // mode applies at creation; chmod after covers pre-existing files too.
    fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n', { mode: SETTINGS_MODE });
    try {
      fs.chmodSync(file, SETTINGS_MODE);
    } catch (_) {
      /* best effort */
    }
    return clean;
  }

  function isConfigured() {
    return load().apiKey !== '';
  }

  function settingsFile() {
    return file;
  }

  return { load, save, isConfigured, settingsFile };
}

/** File-backed history: source files in <dir>/code + a JSON index. */
function makeHistoryStore(dir) {
  const codeDir = path.join(dir, 'code');
  const indexFile = path.join(codeDir, 'index.json');

  function ensureDir() {
    fs.mkdirSync(codeDir, { recursive: true });
  }

  function list() {
    try {
      const raw = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      if (!Array.isArray(raw)) return [];
      return raw.slice().sort((a, b) => b.createdAt - a.createdAt);
    } catch (_) {
      return [];
    }
  }

  function save(code, prompt, language, model) {
    ensureDir();
    const id = crypto.randomUUID();
    const fileName = `${id}.${language.extension}`;
    fs.writeFileSync(path.join(codeDir, fileName), code, 'utf8');
    const meta = {
      id,
      prompt,
      language: language.displayName,
      languageId: language.id,
      extension: language.extension,
      model,
      createdAt: Date.now(),
      fileName,
    };
    const all = list();
    all.unshift(meta);
    fs.writeFileSync(indexFile, JSON.stringify(all, null, 2) + '\n', 'utf8');
    return meta;
  }

  function readText(meta) {
    try {
      return fs.readFileSync(path.join(codeDir, meta.fileName), 'utf8');
    } catch (_) {
      return '';
    }
  }

  function remove(id) {
    const all = list();
    const keep = [];
    for (const g of all) {
      if (g.id === id) {
        try {
          fs.unlinkSync(path.join(codeDir, g.fileName));
        } catch (_) {
          /* file already gone */
        }
      } else {
        keep.push(g);
      }
    }
    ensureDir();
    fs.writeFileSync(indexFile, JSON.stringify(keep, null, 2) + '\n', 'utf8');
    return keep;
  }

  return { list, save, readText, remove, codeDir, indexFile };
}

module.exports = { makeSettingsStore, makeHistoryStore, SETTINGS_MODE };
