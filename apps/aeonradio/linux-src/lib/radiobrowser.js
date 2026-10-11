/**
 * Radio Browser API client — the free directory needs no API key.
 * Mirrors are tried in turn so one outage doesn't brick the Browse tab.
 */
'use strict';

const BASES = [
  'https://de1.api.radio-browser.info/json',
  'https://de2.api.radio-browser.info/json',
  'https://nl1.api.radio-browser.info/json',
];
const USER_AGENT = 'AeonRadio/1.0';
const TIMEOUT_MS = 15000;

async function fetchBody(path) {
  let lastError = null;
  for (const base of BASES) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(base + path, {
          headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error('Radio Browser HTTP ' + res.status);
        return await res.text();
      } finally {
        clearTimeout(t);
      }
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('Radio Browser unreachable');
}

function parseStations(body) {
  const arr = JSON.parse(body);
  const out = [];
  const seen = new Set();
  for (const o of arr) {
    if (!o || typeof o !== 'object') continue;
    const streamUrl = String(o.url_resolved || o.url || '').trim();
    if (!streamUrl) continue;
    if (seen.has(streamUrl)) continue; // directory lists the same URL under several entries
    seen.add(streamUrl);
    out.push({
      name: String(o.name || '').trim() || streamUrl,
      url: streamUrl,
      favicon: String(o.favicon || '').trim(),
      tags: String(o.tags || '').trim(),
      country: String(o.country || '').trim(),
      codec: String(o.codec || '').trim(),
      bitrate: parseInt(o.bitrate, 10) || 0,
    });
  }
  return out;
}

async function search(q) {
  return parseStations(await fetchBody('/stations/search?name=' + encodeURIComponent(q) + '&limit=50&hidebroken=true'));
}
async function topClicks() {
  return parseStations(await fetchBody('/stations/topclick/50'));
}
async function topVotes() {
  return parseStations(await fetchBody('/stations/topvote/50'));
}
async function byTag(tag) {
  return parseStations(await fetchBody('/stations/bytag/' + encodeURIComponent(tag) + '?limit=50&hidebroken=true'));
}
async function byCountry(code) {
  return parseStations(await fetchBody('/stations/bycountrycodeexact/' + encodeURIComponent(code) + '?limit=50&hidebroken=true'));
}
async function countries() {
  const arr = JSON.parse(await fetchBody('/countries?order=stationcount&reverse=true&limit=150'));
  const out = [];
  for (const o of arr) {
    const code = String(o.iso_3166_1 || '').trim();
    const name = String(o.name || '').trim();
    if (!code || !name) continue;
    out.push({ name, code, stations: parseInt(o.stationcount, 10) || 0 });
  }
  return out;
}

module.exports = { search, topClicks, topVotes, byTag, byCountry, countries };
