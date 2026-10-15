// Checks the guardrails with the commands and files in guard-cases.json.
//   node test/guard.test.mjs                 this computer's own system
//   node test/guard.test.mjs win32           pretend to be Windows (or linux, darwin)
//   node test/guard.test.mjs all             all three, each in its own process
import fs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];

if (arg === 'all') {
  let failed = false;
  for (const p of ['darwin', 'linux', 'win32']) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), p], { stdio: 'inherit' });
    failed ||= r.status !== 0;
  }
  process.exit(failed ? 1 : 0);
}

const plat = arg || process.platform;
const pretend = plat !== process.platform;
let home;
if (pretend) {
  // A made-up home folder, so a Mac can check the Windows and Linux rules.
  Object.defineProperty(process, 'platform', { value: plat });
  home = { win32: 'C:\\Users\\tester', linux: '/home/tester', darwin: '/Users/tester' }[plat];
  process.env.HOME = home;
  process.env.USERPROFILE = home;  // where Windows looks for the home folder
  if (plat === 'win32') {
    Object.assign(process.env, { APPDATA: home + '\\AppData\\Roaming', LOCALAPPDATA: home + '\\AppData\\Local',
      SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramData: 'C:\\ProgramData' });
  }
}
const sys = await import(pathToFileURL(nodePath.join(REPO, 'system.mjs')).href);
const path = plat === 'win32' ? nodePath.win32 : nodePath.posix;
home ||= (await import('node:os')).homedir();
const office = pretend ? path.join(home, 'Burrow') : REPO;
const project = path.join(home, 'Projects', 'site');

// guard() lives in server.mjs, which starts the office when imported, so take just that part.
const src = fs.readFileSync(nodePath.join(REPO, 'server.mjs'), 'utf8');
const body = src.slice(src.indexOf('/* ---------------- Guardrails'), src.indexOf('function guardHook'));
const guard = new Function('fs', 'path', 'HOME', 'DIR', 'memoryDir', 'sys', `
  const { OS, WORDS, GUARD, SHELL_TOOLS, SAFE_DEVICES, TEMP_DIRS, within, fromShell } = sys;
  ${body}
  return guard;`)(fs, path, home, office, () => path.join(home, '.claude', 'projects', 'site', 'memory'), sys);

const fwd = s => s.replace(/\\/g, '/');
const shell = s => plat === 'win32' ? fwd(s).replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase()) : s;
const fill = s => s
  .replaceAll('{PROJECTFWD}', fwd(project)).replaceAll('{PROJECT}', project).replaceAll('{OFFICE}', office)
  .replaceAll('{HOMEFWD_ODDCASE}', fwd(home).toLowerCase().replace(/[^/]+$/, n => n.toUpperCase()))
  .replaceAll('{HOMESHELL}', shell(home)).replaceAll('{HOME}', home);

const cases = JSON.parse(fs.readFileSync(nodePath.join(REPO, 'test', 'guard-cases.json'), 'utf8'))[plat];
let bad = 0;
for (const [want, tool, raw] of cases) {
  const a = fill(raw);
  const got = guard({ folder: project }, tool, sys.SHELL_TOOLS.includes(tool) ? { command: a } : { file_path: a });
  const g = got ? got[0] : 'ok';
  if (g !== want) { bad++; console.log(`FAIL  wanted ${want}, got ${g}  ${tool}: ${a}${got ? '  (' + got[1] + ')' : ''}`); }
}
console.log(`${plat}${pretend ? ' (pretend)' : ''}: ${cases.length - bad} of ${cases.length} guardrail checks as expected.`);
process.exit(bad ? 1 : 0);
