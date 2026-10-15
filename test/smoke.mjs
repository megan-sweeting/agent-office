// Starts a throwaway office and checks the basics: the page, a critter picture, the live link,
// and that the office knows which system it's on. Uses its own data file and a free port.
//   node test/smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A port nothing else is using (never 4545, the real office's port).
const PORT = await new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-smoke-'));
const expectedOs = { win32: 'windows', darwin: 'mac' }[process.platform] || 'linux';

const office = spawn(process.execPath, [path.join(REPO, 'server.mjs')], {
  cwd: REPO, env: { ...process.env, OFFICE_PORT: String(PORT), OFFICE_DATA: path.join(tmp, 'office.json') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
office.stdout.on('data', d => { log += d; });
office.stderr.on('data', d => { log += d; });

const checks = [];
const check = (name, ok, detail = '') => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    try { const r = await fetch(base + '/'); if (r.ok) page = await r.text(); } catch { await sleep(250); }
  }
  check('the office starts and serves the page', !!page && page.includes('Burrow &amp; Co.'));
  const token = fs.readFileSync(path.join(REPO, '.office-token'), 'utf8').trim();

  const pic = fs.readdirSync(path.join(REPO, 'assets', 'critters')).find(f => /\.(png|webp|jpg)$/.test(f));
  const img = await fetch(`${base}/assets/critters/${pic}`);
  check('critter pictures load', img.ok, pic);

  // The live link's first message says hello, with this computer's details.
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events?token=${token}`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
  ctrl.abort();
  const hello = JSON.parse(text.replace(/^data: /, '').trim());
  check('the live link says hello', hello.type === 'hello');
  check(`the office knows it's on ${expectedOs}`, hello.system?.os === expectedOs, JSON.stringify(hello.system));
  check('Open in Claude Desktop only where the desktop app exists', hello.system?.desktop === (expectedOs !== 'linux'));
  if (process.env.EXPECT_SANDBOX) check('the sandbox is found (bubblewrap and socat installed)', hello.system?.sandbox === true);
  if (!hello.system?.sandbox) console.log(`INFO  no sandbox here: ${hello.system?.sandboxMissing}`);

  const denied = await fetch(`${base}/api/events`);
  check('the office refuses requests without its key', denied.status === 401);
} catch (e) {
  check('smoke test ran', false, e.message);
} finally {
  office.kill();
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
}
const failed = checks.filter(ok => !ok).length;
if (failed) console.log('\nOffice log:\n' + log);
console.log(`\n${checks.length - failed} of ${checks.length} start-up checks passed on ${expectedOs}.`);
process.exit(failed ? 1 : 0);
