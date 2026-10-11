'use strict';
/**
 * AeonCodeNet Linux port — validation suite.
 * Run:  node tests/run-tests.js
 *
 * 1. stripFences fixtures (line-for-line port of the Android logic)
 * 2. buildChatRequest exact request-body assertions
 * 3. validateConfig error messages
 * 4. Full generateCode flow against a local mock OpenAI-compatible server
 *    (never hits a real external API)
 * 5. Settings store: 0600 file mode + round trip
 * 6. History store: save / list / read / delete
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const llm = require('../common/llm');
const { makeSettingsStore, makeHistoryStore, SETTINGS_MODE } = require('../common/store');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok - ${name}`);
}

// ---------------------------------------------------------------------------
// 1. stripFences
// ---------------------------------------------------------------------------
function testStripFences() {
  console.log('stripFences:');
  const cases = [
    // [input, expected]
    ["print('hi')\n", "print('hi')"],
    ['```python\nprint("hi")\n```', 'print("hi")'],
    ['```\nline1\nline2\n```', 'line1\nline2'],
    // no newline after opening fence: Kotlin logic drops everything
    ['```code without newline```', ''],
    // only an opening fence
    ['```\nonly opening', 'only opening'],
    // text starting with ``` but no closing fence
    ['```js\nconst a = 1;', 'const a = 1;'],
    // lastIndexOf: trailing text after the closing fence is dropped
    ['```python\ncode()\n```\ntrailing junk', 'code()'],
    // language tag + surrounding whitespace
    ['  \n  ```cpp\n#include <iostream>\n```\n  ', '#include <iostream>'],
    // inner blank lines survive
    ['```\na\n\nb\n```', 'a\n\nb'],
    // does not touch text that merely mentions backticks later
    ['x = 1  # no ``` here', 'x = 1  # no ``` here'],
    // empty input
    ['', ''],
  ];
  for (const [input, expected] of cases) {
    assert.equal(llm.stripFences(input), expected, `stripFences(${JSON.stringify(input)})`);
    ok(`stripFences ${JSON.stringify(input.slice(0, 24))}…`);
  }
}

// ---------------------------------------------------------------------------
// 2. buildChatRequest
// ---------------------------------------------------------------------------
function testBuildChatRequest() {
  console.log('buildChatRequest:');
  const python = llm.languageById('python');
  const got = llm.buildChatRequest(
    { baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o-mini' },
    python,
    '  make a hello  ',
  );
  const expected = {
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You are AeonCodeNet, a precise code generator. ' +
          'Respond with ONLY the complete Python program requested. ' +
          'Do not include explanations, markdown fences, or commentary unless the user explicitly asked for them. ' +
          'The code must be complete and runnable as written whenever that is reasonable.',
      },
      {
        role: 'user',
        content:
          'Write a Python program for the following request. ' +
          'Use Python 3 and only the standard library unless the request asks for packages.' +
          '\n\nRequest:\nmake a hello',
      },
    ],
    temperature: 0.2,
  };
  assert.deepEqual(got, expected);
  ok('request body deep-equals the expected payload (python)');

  // C++ variant: display name, extension and hint all flow through
  const cpp = llm.languageById('cpp');
  const cppReq = llm.buildChatRequest(
    { baseUrl: 'http://localhost:1/v1', apiKey: 'k', model: 'm' },
    cpp,
    'fib',
  );
  assert.equal(cppReq.messages[0].content.includes('complete C++ program'), true);
  assert.equal(cppReq.messages[1].content.includes('Use standard C++17'), true);
  assert.equal(cppReq.messages[1].content.endsWith('Request:\nfib'), true);
  ok('C++ prompt text uses display name + hint');

  // every language maps to the right extension
  const ext = Object.fromEntries(llm.LANGUAGES.map((l) => [l.id, l.extension]));
  assert.deepEqual(ext, {
    cpp: 'cpp',
    csharp: 'cs',
    python: 'py',
    java: 'java',
    javascript: 'js',
    kotlin: 'kt',
  });
  ok('language -> extension map is exact for all 6 languages');
}

// ---------------------------------------------------------------------------
// 3. validateConfig
// ---------------------------------------------------------------------------
function testValidateConfig() {
  console.log('validateConfig:');
  assert.throws(
    () => llm.validateConfig({ baseUrl: 'https://x/v1', apiKey: '  ', model: 'm' }),
    /No API key set\. Open Settings and add your LLM API key first\./,
  );
  ok('empty API key rejected with the Android message');
  assert.throws(
    () => llm.validateConfig({ baseUrl: 'https://x/v1', apiKey: 'k', model: '' }),
    /No model set\. Open Settings and choose a model\./,
  );
  ok('empty model rejected with the Android message');
  assert.throws(
    () => llm.validateConfig({ baseUrl: 'ftp://x/v1', apiKey: 'k', model: 'm' }),
    /Base URL must start with http:\/\/ or https:\/\//,
  );
  ok('non-http base URL rejected');
  const clean = llm.validateConfig({ baseUrl: 'https://x/v1///', apiKey: ' k ', model: ' m ' });
  assert.deepEqual(clean, { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' });
  ok('trailing slashes + whitespace are trimmed');
}

// ---------------------------------------------------------------------------
// 4. generateCode against a mock OpenAI-compatible server
// ---------------------------------------------------------------------------
function startMockServer(handler) {
  return new Promise((resolve) => {
    const seen = { headers: null, body: null };
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.headers = req.headers;
        seen.body = Buffer.concat(chunks).toString('utf8');
        handler(req, res);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, port: srv.address().port }));
  });
}

async function testGenerateCodeMock() {
  console.log('generateCode (mock server):');
  const python = llm.languageById('python');
  const fenced = '```python\nprint("mock ok")\n```';

  // happy path
  {
    const { srv, seen, port } = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: fenced } }] }));
    });
    try {
      const config = { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key-123', model: 'mock-model' };
      const code = await llm.generateCode(config, python, 'print ok');
      assert.equal(code, 'print("mock ok")');
      ok('fenced mock response is extracted to clean code');

      assert.equal(seen.headers.authorization, 'Bearer test-key-123');
      assert.equal(seen.headers['content-type'], 'application/json');
      ok('Authorization: Bearer <key> header is sent');

      const sentBody = JSON.parse(seen.body);
      const expectedBody = llm.buildChatRequest(config, python, 'print ok');
      assert.deepEqual(sentBody, expectedBody);
      ok('request JSON body deep-equals buildChatRequest output');
    } finally {
      srv.close();
    }
  }

  // 401 error surfaces the backend message + the key hint
  {
    const { srv, port } = await startMockServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key' } }));
    });
    try {
      await assert.rejects(
        () =>
          llm.generateCode(
            { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'wrong', model: 'm' },
            python,
            'x',
          ),
        (err) => {
          assert.equal(
            err.message,
            'LLM backend returned HTTP 401. bad key Check that the API key in Settings is correct.',
          );
          return true;
        },
      );
      ok('HTTP 401 produces the exact Android-style error message');
    } finally {
      srv.close();
    }
  }

  // empty model content -> friendly error, not an empty save
  {
    const { srv, port } = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '   ' } }] }));
    });
    try {
      await assert.rejects(
        () =>
          llm.generateCode(
            { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm' },
            python,
            'x',
          ),
        /The model returned an empty response\. Try rephrasing the prompt\./,
      );
      ok('empty model response is rejected, never saved');
    } finally {
      srv.close();
    }
  }

  // unreachable backend -> wrapped connection error
  {
    await assert.rejects(
      () =>
        llm.generateCode(
          { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' },
          python,
          'x',
          // force the real postJson with a short timeout via a failing port
          undefined,
        ),
      /Could not reach the LLM backend/,
    );
    ok('unreachable backend raises "Could not reach the LLM backend"');
  }
}

// ---------------------------------------------------------------------------
// 5. settings store (0600 + round trip)
// ---------------------------------------------------------------------------
function testSettingsStore() {
  console.log('settings store:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-settings-'));
  const store = makeSettingsStore(dir);

  // defaults when nothing saved yet
  assert.deepEqual(store.load(), { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' });
  ok('fresh store returns defaults');

  const saved = store.save({ baseUrl: 'https://llm.example/v1/', apiKey: ' secret ', model: ' test-model ' });
  assert.deepEqual(saved, { baseUrl: 'https://llm.example/v1/', apiKey: 'secret', model: 'test-model' });
  ok('save trims values');

  assert.deepEqual(store.load(), saved);
  ok('load round-trips the saved config');

  const mode = fs.statSync(store.settingsFile()).mode & 0o777;
  assert.equal(mode, SETTINGS_MODE, `settings file mode is 0o600 (got 0o${mode.toString(8)})`);
  ok('settings file has mode 0600');

  assert.equal(store.isConfigured(), true);
  ok('isConfigured() true once a key is saved');

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 6. history store
// ---------------------------------------------------------------------------
function testHistoryStore() {
  console.log('history store:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-history-'));
  const store = makeHistoryStore(dir);
  const python = llm.languageById('python');
  const java = llm.languageById('java');

  assert.deepEqual(store.list(), []);
  ok('fresh store lists empty');

  const a = store.save("print('a')", 'first program', python, 'mock-model');
  const b = store.save('class Main {}', 'second program', java, 'mock-model');
  assert.ok(a.id && b.id && a.id !== b.id);
  assert.equal(a.fileName, `${a.id}.py`);
  assert.equal(b.fileName, `${b.id}.java`);
  ok('saved entries get unique ids and language-correct file names');

  const listed = store.list();
  assert.equal(listed.length, 2);
  assert.ok(listed[0].createdAt >= listed[1].createdAt, 'newest first');
  ok('list() returns newest-first order');

  assert.equal(store.readText(b), 'class Main {}');
  ok('readText returns the stored source');

  assert.equal(store.readText({ fileName: 'nope.py' }), '');
  ok('readText of a missing file returns empty string');

  store.remove(a.id);
  const after = store.list();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, b.id);
  assert.equal(fs.existsSync(path.join(store.codeDir, a.fileName)), false);
  ok('remove() deletes the index entry and the source file');

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
async function main() {
  testStripFences();
  testBuildChatRequest();
  testValidateConfig();
  await testGenerateCodeMock();
  testSettingsStore();
  testHistoryStore();
  console.log(`\n${passed} assertions passed.`);
}

main().catch((e) => {
  console.error(`\nTEST FAILURE: ${e.stack || e}`);
  process.exit(1);
});
