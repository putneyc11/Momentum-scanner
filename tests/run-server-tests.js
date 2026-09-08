#!/usr/bin/env node
/* Isolated runner for server suites and the alert recovery regressions.
   Uses this Node executable for every child; never inherits live credentials. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SUITES = [
  'test-setup', 'test-apns', 'test-plan', 'test-serverkeys',
  'test-dup', 'test-trig4', 'test-alert-delivery', 'test-push-recovery',
];
const TIMEOUT_MS = 90000;
const directories = new Set();
const children = new Set();

function stop(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (e) {
    if (e.code === 'ESRCH') return;
    /* macOS can report EPERM for a group containing only exited, unreaped
       children. Verify there is no live member before treating it as gone. */
    if (e.code === 'EPERM') {
      const members = spawnSync('/bin/ps', ['-g', String(child.pid), '-o', 'stat='], { encoding: 'utf8' });
      const states = (members.stdout || '').trim().split(/\s+/).filter(Boolean);
      if (!members.error && [0, 1].includes(members.status) && states.every((s) => s.startsWith('Z'))) return;
    }
    throw e;
  }
}
function remove(directory) {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  directories.delete(directory);
}
function cleanup() {
  for (const child of children) { try { stop(child); } catch {} }
  for (const directory of directories) { try { remove(directory); } catch {} }
}
process.once('exit', cleanup);
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));

function environment(directory, suite) {
  const env = {};
  for (const name of ['LANG', 'LC_ALL', 'LC_CTYPE']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return {
    ...env,
    PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
    TMPDIR: path.join(directory, 'tmp'),
    TZ: 'UTC',
    NODE_ENV: 'test',
    PORT: suite === 'test-dup' ? '8793' : '8787',
    SCANNER_STATE_DIR: path.join(directory, 'state'),
    /* Suite stubs explicitly override these. Unused monitor paths fail locally. */
    ALPACA_DATA_URL: 'http://127.0.0.1:1',
    ALPACA_TRADING_URL: 'http://127.0.0.1:1',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    APNS_HOST: 'http://127.0.0.1:1',
  };
}
function prepare(suite, server) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `momentum-${suite}-`));
  directories.add(directory);
  for (const child of ['tests', 'src', 'state', 'tmp'])
    fs.mkdirSync(path.join(directory, child), { mode: 0o700 });
  const prefix = path.join(directory, 'state', 'scanner-').split(path.sep).join('/');
  const content = fs.readFileSync(path.join(__dirname, suite + '.js'), 'utf8')
    .replaceAll('/tmp/scanner-', prefix.replaceAll('\\', '\\\\').replaceAll("'", "\\'"))
    .replace(/\.listen\((\d+), r\)/g, '.listen($1, "127.0.0.1", r)');
  fs.writeFileSync(path.join(directory, 'tests', suite + '.js'), content);
  fs.writeFileSync(path.join(directory, 'tests', 'server.js'), server.replace('server.listen(PORT,', 'server.listen(PORT, "127.0.0.1",'));
  for (const file of ['server.template.js', 'momentum-dashboard.jsx'])
    fs.copyFileSync(path.join(ROOT, 'src', file), path.join(directory, 'src', file));
  return directory;
}
async function run(suite, server) {
  const directory = prepare(suite, server);
  let child, timer;
  try {
    console.log(`\nRunning ${suite} with Node ${process.versions.node}`);
    const result = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [path.join(directory, 'tests', suite + '.js')], {
        cwd: path.join(directory, 'tests'), env: environment(directory, suite),
        detached: true, stdio: 'inherit',
      });
      children.add(child);
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
      timer = setTimeout(() => {
        try { stop(child); } catch {}
        reject(new Error(`${suite} exceeded ${TIMEOUT_MS / 1000} seconds`));
      }, TIMEOUT_MS);
    });
    if (result.code !== 0) throw new Error(`${suite} failed (${result.signal || `exit ${result.code}`})`);
  } finally {
    clearTimeout(timer);
    if (child) { stop(child); children.delete(child); }
    remove(directory);
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--list') { console.log(SUITES.join('\n')); return; }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Run this runner with Node 22 or newer.');
  if (process.platform === 'win32') throw new Error('This runner requires POSIX process groups to clean up child servers safely.');
  const selected = args.length ? args.map((arg) => arg.replace(/\.js$/, '')) : SUITES;
  if (selected.some((suite) => !SUITES.includes(suite)) || new Set(selected).size !== selected.length)
    throw new Error('Choose distinct suite names from: ' + SUITES.join(', '));
  const server = fs.readFileSync(path.join(ROOT, 'deploy/server.js'), 'utf8');
  const expected = fs.readFileSync(path.join(ROOT, 'src/server.template.js'), 'utf8')
    .replace('__ICON_B64__', fs.readFileSync(path.join(ROOT, 'build/icon.b64'), 'utf8').trim());
  if (server !== expected) throw new Error('Generated server is stale. Run python3 build/build.py before running tests.');
  for (const suite of selected) await run(suite, server);
  console.log(`\n${selected.length} isolated suites passed; temporary state and child servers removed.`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
