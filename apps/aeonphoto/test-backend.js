'use strict';
/**
 * Unit tests for BackendManager detection/selection/failure states.
 * Spins up local mock HTTP servers:
 *   A. sd.cpp mock  — GET /health -> {"status":"OK"},
 *                     POST /v1/images/generations -> b64_json 1x1 PNG
 *   B. WebUI mock   — GET /sdapi/v1/sd-models -> [...],
 *                     POST /sdapi/v1/txt2img -> {images:[b64 1x1 PNG]}
 *   C. dead port    — nothing listening
 */
const http = require('http');
const assert = require('assert');
const { BackendManager } = require('./linux-src/backend-manager');

// 1x1 transparent PNG (test fixture, not a "generated" image)
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function startMockSdcpp() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        // Exact shape from examples/server/routes_openai.cpp
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'sd-cpp-local', object: 'model', owned_by: 'local' }] }));
      } else if (req.method === 'POST' && req.url === '/v1/images/generations') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          assert.strictEqual(parsed.size, '1024x1024');
          assert.strictEqual(parsed.output_format, 'png');
          // seed/steps travel via the documented <sd_cpp_extra_args> extension
          const m = /<sd_cpp_extra_args>(.*?)<\/sd_cpp_extra_args>/.exec(parsed.prompt);
          assert.ok(m, 'expected sd_cpp_extra_args in prompt');
          const extra = JSON.parse(m[1]);
          assert.strictEqual(typeof extra.seed, 'number');
          assert.strictEqual(extra.sample_params.sample_steps, 20);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ created: 1, output_format: 'png', data: [{ b64_json: TINY_PNG_B64 }] }));
        });
      } else { res.writeHead(404); res.end(); }
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function startMockWebui() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/sdapi/v1/sd-models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ title: 'mock-model.safetensors', model_name: 'mock-model' }]));
      } else if (req.method === 'POST' && req.url === '/sdapi/v1/txt2img') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          assert.strictEqual(parsed.width, 1024);
          assert.strictEqual(parsed.height, 1024);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ images: [TINY_PNG_B64], parameters: {}, info: '{}' }));
        });
      } else { res.writeHead(404); res.end(); }
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function deadPort() {
  return new Promise((resolve) => {
    const srv = http.createServer(() => {});
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

(async () => {
  const sdcpp = await startMockSdcpp();
  const webui = await startMockWebui();
  const dead = await deadPort();
  const sdcppUrl = `http://127.0.0.1:${sdcpp.port}`;
  const webuiUrl = `http://127.0.0.1:${webui.port}`;
  const deadUrl = `http://127.0.0.1:${dead}`;
  let n = 0;
  const ok = (name) => { n++; console.log(`PASS ${n}: ${name}`); };

  // 1. sd.cpp detected alone
  let bm = new BackendManager({ sdcppUrl, webuiUrl: deadUrl });
  let st = await bm.detect();
  assert.strictEqual(st.kind, 'sdcpp', 'expected sdcpp, got ' + st.kind);
  assert.ok(bm.isReady());
  ok('sd.cpp detected when alone (kind=sdcpp, isReady=true)');

  // 2. WebUI detected alone
  bm = new BackendManager({ sdcppUrl: deadUrl, webuiUrl });
  st = await bm.detect();
  assert.strictEqual(st.kind, 'webui', 'expected webui, got ' + st.kind);
  ok('WebUI detected when alone (kind=webui)');

  // 3. Priority: sd.cpp wins when both answer
  bm = new BackendManager({ sdcppUrl, webuiUrl });
  st = await bm.detect();
  assert.strictEqual(st.kind, 'sdcpp', 'expected sdcpp priority, got ' + st.kind);
  ok('sd.cpp takes priority when both backends answer');

  // 4. Failure state: nothing listening -> kind=none, isReady()=false
  bm = new BackendManager({ sdcppUrl: deadUrl, webuiUrl: deadUrl });
  st = await bm.detect();
  assert.strictEqual(st.kind, 'none', 'expected none, got ' + st.kind);
  assert.strictEqual(bm.isReady(), false);
  ok('dead ports -> kind=none, isReady()=false (honest disabled state)');

  // 5. Generation routes through the selected backend (sd.cpp mock)
  bm = new BackendManager({ sdcppUrl, webuiUrl: deadUrl });
  await bm.detect();
  const png = await bm.generateSquare({ prompt: 'test', steps: 20, seed: 42 });
  assert.ok(Buffer.isBuffer(png));
  assert.strictEqual(png.toString('base64'), TINY_PNG_B64);
  ok('generateSquare returns backend image bytes via sd.cpp endpoint');

  // 6. Generation routes through WebUI mock
  bm = new BackendManager({ sdcppUrl: deadUrl, webuiUrl });
  await bm.detect();
  const png2 = await bm.generateSquare({ prompt: 'test', steps: 20, seed: 42 });
  assert.strictEqual(png2.toString('base64'), TINY_PNG_B64);
  ok('generateSquare returns backend image bytes via WebUI txt2img endpoint');

  // 7. generateSquare with no backend throws (never fakes an image)
  bm = new BackendManager({ sdcppUrl: deadUrl, webuiUrl: deadUrl });
  await bm.detect();
  await assert.rejects(() => bm.generateSquare({ prompt: 'x', steps: 1, seed: 1 }), /no diffusion backend/);
  ok('generateSquare rejects when no backend (never synthesizes an image)');

  // 8. Wrong-shaped server on sd.cpp port is NOT misdetected as sd.cpp
  bm = new BackendManager({ sdcppUrl: webuiUrl, webuiUrl: deadUrl }); // webui mock on sdcpp slot
  st = await bm.detect();
  assert.strictEqual(st.kind, 'none', 'webui-shaped server must not pass as sd.cpp, got ' + st.kind);
  ok('sd.cpp probe rejects non-sd.cpp servers on its port');

  sdcpp.srv.close();
  webui.srv.close();
  console.log(`\nAll ${n} BackendManager tests passed.`);
})().catch((e) => { console.error('FAIL: ' + (e.stack || e)); process.exit(1); });
