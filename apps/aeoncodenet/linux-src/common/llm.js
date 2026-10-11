'use strict';
/**
 * Shared LLM logic for AeonCodeNet (Linux/Electron).
 * Plain CommonJS so it can be required by main.js, preload.js,
 * and the node unit tests without Electron.
 *
 * Faithful port of the Android app's:
 *   llm/LlmClient.kt, llm/LlmSettings.kt, llm/CodeLanguage.kt
 */

const http = require('http');
const https = require('https');

/** Languages AeonCodeNet can generate. Mirrors CodeLanguage in the Android app. */
const LANGUAGES = [
  {
    id: 'cpp',
    displayName: 'C++',
    extension: 'cpp',
    hint: 'Use standard C++17 and include every needed header.',
  },
  {
    id: 'csharp',
    displayName: 'C#',
    extension: 'cs',
    hint: 'Target modern .NET console-style code unless the request says otherwise.',
  },
  {
    id: 'python',
    displayName: 'Python',
    extension: 'py',
    hint: 'Use Python 3 and only the standard library unless the request asks for packages.',
  },
  {
    id: 'java',
    displayName: 'Java',
    extension: 'java',
    hint: 'Provide a complete, compilable program; use a public class named Main unless the request names another class.',
  },
  {
    id: 'javascript',
    displayName: 'JavaScript',
    extension: 'js',
    hint: 'Use modern JavaScript (ES2022); print results with console.log for CLI-style programs.',
  },
  {
    id: 'kotlin',
    displayName: 'Kotlin',
    extension: 'kt',
    hint: 'Provide a complete Kotlin program with a main function when a runnable program makes sense.',
  },
];

const DEFAULT_CONFIG = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
};

function languageById(id) {
  return LANGUAGES.find((l) => l.id === id) || LANGUAGES[2]; // default: Python
}

function buildSystemPrompt(language) {
  return (
    'You are AeonCodeNet, a precise code generator. ' +
    `Respond with ONLY the complete ${language.displayName} program requested. ` +
    'Do not include explanations, markdown fences, or commentary unless the user explicitly asked for them. ' +
    'The code must be complete and runnable as written whenever that is reasonable.'
  );
}

function buildUserPrompt(language, prompt) {
  return (
    `Write a ${language.displayName} program for the following request. ${language.hint}` +
    `\n\nRequest:\n${prompt.trim()}`
  );
}

/** The exact JSON body POSTed to {baseUrl}/chat/completions. */
function buildChatRequest(config, language, prompt) {
  return {
    model: config.model.trim(),
    messages: [
      { role: 'system', content: buildSystemPrompt(language) },
      { role: 'user', content: buildUserPrompt(language, prompt) },
    ],
    temperature: 0.2,
  };
}

/**
 * Validates a config the way the Android app does (require() checks in LlmClient).
 * Returns a cleaned copy or throws an Error with the user-facing message.
 */
function validateConfig(config) {
  const apiKey = (config.apiKey || '').trim();
  const model = (config.model || '').trim();
  const base = (config.baseUrl || '').trim().replace(/\/+$/, '');
  if (!apiKey) {
    throw new Error('No API key set. Open Settings and add your LLM API key first.');
  }
  if (!model) {
    throw new Error('No model set. Open Settings and choose a model.');
  }
  if (!/^https?:\/\//.test(base)) {
    throw new Error('Base URL must start with http:// or https://');
  }
  return { baseUrl: base, apiKey, model };
}

/**
 * Removes ``` fences when a model adds them despite the system prompt.
 * Line-for-line port of LlmClient.stripFences in the Android app.
 */
function stripFences(text) {
  let t = text.trim();
  if (!t.startsWith('```')) return t;
  t = t.slice(3);
  const nl = t.indexOf('\n');
  t = nl >= 0 ? t.slice(nl + 1) : '';
  const end = t.lastIndexOf('```');
  if (end >= 0) t = t.slice(0, end);
  return t.trim();
}

/** Mirrors LlmClient.serverErrorMessage in the Android app. */
function serverErrorMessage(code, body) {
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    detail = (parsed && parsed.error && parsed.error.message) || '';
  } catch (_) {
    /* not JSON — no detail */
  }
  const hints = {
    401: ' Check that the API key in Settings is correct.',
    404: ' Check the base URL and model name in Settings.',
    429: ' The backend is rate-limiting requests. Wait a bit and retry.',
  };
  return `LLM backend returned HTTP ${code}.${detail ? ' ' + detail : ''}${hints[code] || ''}`;
}

/** Minimal POST helper over node http/https (no external deps). */
function postJson(urlStr, bodyObj, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json', 'Content-Length': body.length },
          headers,
        ),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.setTimeout(timeoutMs || 120000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Full generation flow: validate config, POST to /chat/completions,
 * parse the first choice, strip fences. requestFn is injectable for tests.
 */
async function generateCode(config, language, prompt, requestFn) {
  const cfg = validateConfig(config);
  const body = buildChatRequest(cfg, language, prompt);
  let status;
  let text;
  try {
    const res = await (requestFn || postJson)(
      `${cfg.baseUrl}/chat/completions`,
      body,
      { Authorization: `Bearer ${cfg.apiKey}` },
      120000,
    );
    status = res.status;
    text = res.text;
  } catch (e) {
    throw new Error(`Could not reach the LLM backend: ${e.message}`);
  }
  if (status < 200 || status > 299) {
    throw new Error(serverErrorMessage(status, text));
  }
  let content = '';
  try {
    const parsed = JSON.parse(text);
    const choice = (parsed.choices || [])[0];
    content = (choice && choice.message && choice.message.content) || '';
  } catch (_) {
    content = '';
  }
  const cleaned = stripFences(content);
  if (!cleaned) {
    throw new Error('The model returned an empty response. Try rephrasing the prompt.');
  }
  return cleaned;
}

module.exports = {
  LANGUAGES,
  DEFAULT_CONFIG,
  languageById,
  buildSystemPrompt,
  buildUserPrompt,
  buildChatRequest,
  validateConfig,
  stripFences,
  serverErrorMessage,
  postJson,
  generateCode,
};
