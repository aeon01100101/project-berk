/**
 * PlaylistParser — resolves Shoutcast-style playlist URLs (.m3u/.pls) to the
 * first direct stream URL inside. Plain stream URLs are returned unchanged.
 * NOTE: .m3u8 (HLS) is intentionally NOT resolved here — hls.js handles HLS
 * playlists natively and parsing one as a flat playlist would break playback.
 * Never throws.
 */
'use strict';

const http = require('http');
const https = require('https');

const USER_AGENT = 'AeonRadio/1.0';
const MAX_BODY = 65536;
const TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 5;

function looksLikeStreamUrl(s) {
  return /^https?:\/\//i.test(s);
}

function parseM3u(text) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (looksLikeStreamUrl(line)) return line;
  }
  return null;
}

function parsePls(text) {
  const re = /^File\d+\s*=\s*(.+?)\s*$/gim;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = m[1].trim();
    if (looksLikeStreamUrl(v)) return v;
  }
  return null;
}

function fetchText(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const mod = url.toLowerCase().startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        fetchText(next, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status > 299) {
        res.resume();
        reject(new Error('HTTP ' + status));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length < MAX_BODY) body += chunk;
      });
      res.on('end', () => resolve(body.slice(0, MAX_BODY)));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function resolve(url) {
  const low = String(url || '').toLowerCase().split('?')[0];
  if (!low.endsWith('.m3u') && !low.endsWith('.pls')) return url;
  try {
    const text = await fetchText(url, MAX_REDIRECTS);
    const parsed = low.endsWith('.pls') ? parsePls(text) : parseM3u(text);
    return parsed || url;
  } catch (_) {
    return url;
  }
}

module.exports = { resolve, parseM3u, parsePls, looksLikeStreamUrl };
