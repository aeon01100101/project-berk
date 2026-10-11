/**
 * ICY metadata tap. Opens a parallel connection to the stream with the
 * `Icy-MetaData: 1` header (an <audio> element cannot set custom headers),
 * parses icy-metaint StreamTitle blocks, and emits "now playing" events.
 * When the server sends no ICY data we emit {icy:false} once and close the
 * tap — the renderer then honestly shows the station name.
 */
'use strict';

const http = require('http');
const https = require('https');

/**
 * @param {string} url resolved stream URL
 * @param {(ev:{icy:boolean,title:string|null})=>void} onEvent
 * @returns {()=>void} stop function
 */
function startTap(url, onEvent) {
  let stopped = false;
  let req = null;

  const stop = () => {
    stopped = true;
    if (req) { try { req.destroy(); } catch (_) {} req = null; }
  };

  const low = String(url).toLowerCase().split('?')[0];
  if (low.endsWith('.m3u8')) {
    // HLS carries its own timed metadata; an ICY tap would just download segments.
    setImmediate(() => { if (!stopped) onEvent({ icy: false, title: null }); });
    return stop;
  }

  const mod = String(url).toLowerCase().startsWith('https') ? https : http;
  try {
    req = mod.get(url, {
      headers: { 'Icy-MetaData': '1', 'User-Agent': 'AeonRadio/1.0' },
      timeout: 15000,
    }, (res) => {
      if (stopped) { res.resume(); return; }
      const metaint = parseInt(res.headers['icy-metaint'], 10);
      if (!(metaint > 0)) {
        onEvent({ icy: false, title: null });
        res.resume();
        stop();
        return;
      }
      onEvent({ icy: true, title: null });
      let buf = Buffer.alloc(0);
      let audioLeft = metaint;
      let lastTitle = null;
      res.on('data', (chunk) => {
        if (stopped) return;
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (audioLeft > 0) {
            const take = Math.min(audioLeft, buf.length);
            buf = buf.subarray(take);
            audioLeft -= take;
            if (buf.length === 0) break;
          }
          if (buf.length < 1) break;
          const metaLen = buf[0] * 16;
          if (buf.length < 1 + metaLen) break;
          const meta = buf.subarray(1, 1 + metaLen).toString('utf8').replace(/\0+$/, '');
          buf = buf.subarray(1 + metaLen);
          audioLeft = metaint;
          const m = /StreamTitle='([^']*)'/.exec(meta);
          if (m) {
            const title = m[1].trim();
            if (title && title !== lastTitle) {
              lastTitle = title;
              onEvent({ icy: true, title });
            }
          }
        }
      });
      res.on('error', () => {});
    });
  } catch (_) {
    setImmediate(() => { if (!stopped) onEvent({ icy: false, title: null }); });
    return stop;
  }
  req.on('timeout', stop);
  req.on('error', () => {
    if (!stopped) onEvent({ icy: false, title: null });
    stop();
  });
  return stop;
}

module.exports = { startTap };
