// Java runtime detection helpers for the Enigma Launcher.
//
// Pure Node (no Electron) so the logic can be unit-tested with plain `node`.
// main.js delegates to these; the dialog shown to the user lives in main.js.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function jreDirName(platform) {
  return platform === 'win32' ? 'jre-win' : 'jre-linux';
}

function javaBinName(platform) {
  return platform === 'win32' ? 'java.exe' : 'java';
}

/** Candidate bundled-JRE binary paths, in priority order. */
function bundledJavaCandidates({ resourcesPath, projectRoot, platform }) {
  const dir = jreDirName(platform);
  const bin = javaBinName(platform);
  return [
    path.join(resourcesPath, dir, bin),        // packaged (extra resource)
    path.join(resourcesPath, dir, 'bin', bin), // packaged (alt layout)
    path.join(resourcesPath, 'app', dir, bin), // packaged (in app dir)
    path.join(projectRoot, dir, bin),          // dev layout
    path.join(projectRoot, dir, 'bin', bin),   // dev alt layout
  ];
}

/** First existing candidate, or null. */
function findBundledJava(opts) {
  for (const c of bundledJavaCandidates(opts)) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Parse the major version out of `java -version` output.
 *  Handles both modern "17.0.12" and legacy "1.8.0_412" formats. */
function parseJavaMajor(text) {
  const m = /version\s+"(\d+)(?:\.(\d+))?/.exec(String(text || ''));
  if (!m) return 0;
  if (m[1] === '1' && m[2] !== undefined) return parseInt(m[2], 10);
  return parseInt(m[1], 10);
}

/** True when `<javaBin> -version` reports a major version >= minMajor.
 *  `runner` is injectable for tests; defaults to child_process.spawnSync. */
function javaVersionOk(javaBin, minMajor, runner) {
  const run = runner || spawnSync;
  try {
    const out = run(javaBin, ['-version'], { encoding: 'utf8', timeout: 15000 });
    const text = ((out && out.stderr) || '') + ((out && out.stdout) || '');
    return parseJavaMajor(text) >= minMajor;
  } catch {
    return false;
  }
}

module.exports = {
  jreDirName,
  javaBinName,
  bundledJavaCandidates,
  findBundledJava,
  parseJavaMajor,
  javaVersionOk,
};
