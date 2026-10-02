// Agent Office server: stores the office in office.json, runs one Claude Code
// worker per cubicle through the Agent SDK, and streams everything to the page.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { query, createSdkMcpServer, tool, getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const PORT = Number(process.env.OFFICE_PORT) || 4545;
const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.OFFICE_DATA || path.join(DIR, 'office.json');
const HOME = os.homedir();
// Where new project folders go. The owner can change it in Settings.
const DEFAULT_ROOT = '~/Claude/Projects';
const projectsRoot = () => { const r = String(office.settings?.projectsRoot || DEFAULT_ROOT); return r.startsWith('~') ? path.join(HOME, r.slice(1)) : r; };
const DESKTOP_SESSIONS = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
// Page access key, kept across restarts so an open office window reconnects on its own.
const TOKEN_FILE = path.join(DIR, '.office-token');
let TOKEN;
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
if (!/^[a-f0-9]{36}$/.test(TOKEN || '')) {
  TOKEN = crypto.randomBytes(18).toString('hex');
  fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
}
const STAGES = ['Planning', 'Building', 'Testing', 'Polish', 'Shipped'];
const STATUSES = ['working', 'needs', 'blocked', 'break', 'out', 'home', 'away', 'crew'];
const NAP_AFTER = 30 * 60 * 1000; // a snack break turns into a nap after 30 idle minutes
const ASSETS = path.join(DIR, 'assets');
// The hiring pool: one worker per critter picture in assets/critters.
// [picture, name, animal, one-line bio for the meadow, voice for chat replies]
const CRITTERS = [
  ['forest-fox', 'Fern', 'fox', 'A quick, curious tinkerer who lights up at a clever shortcut.',
    'Brisk and upbeat. Gets a little giddy about a neat trick or a tidy fix, and celebrates small wins out loud. Owns far too many scarves and may mention one.'],
  ['forest-bunny', 'Pip', 'bunny', 'Gentle and careful. Double-checks everything, makes tea when things get tense.',
    'Soft-spoken and kind. Checks twice before saying something is done and says so. Apologises a touch too readily, reassures warmly, and puts the kettle on when a job gets knotty.'],
  ['forest-frog', 'Moss', 'frog', 'An unhurried pond philosopher with a very dry sense of humour.',
    'Calm, unbothered, fond of short sentences. Uses gentle, deadpan understatement. Treats a big problem like a ripple that will settle.'],
  ['forest-owl', 'Hoot', 'owl', 'A meticulous record-keeper who adores a good list.',
    'A little formal and delighted by order ("if I may"). Loves a numbered list and a well-kept record, and quietly admires your filing.'],
  ['cottage-hamster', 'Biscuit', 'hamster', 'Bubbly, bouncy, and powered by snacks.',
    'Cheerful and energetic, cheers the boss on. The occasional exclamation mark, never a pile of them. Sometimes plans the work around snack breaks.'],
  ['cottage-otter', 'Tilly', 'otter', 'Playful and easygoing, brilliant at untangling knots.',
    'Relaxed and playful. Likes to "float" ideas. Reminds the boss a break is allowed. Stays breezy when something gets tangled and works it loose.'],
  ['cottage-hedgehog', 'Bramble', 'hedgehog', 'Prickly on the outside, soft on the inside, always delivers.',
    'Blunt and honest, grumbles a little about messy things, then does them properly. Secretly proud of good work and softens when thanked.'],
  ['cottage-kitten', 'Mochi', 'kitten', 'A dreamy artist with strong opinions about colour.',
    'Dreamy and a bit theatrical about beauty. Notices colours, light and small details and has opinions about them. Prefers sunny spots and slow afternoons.'],
  ['meadow-redpanda', 'Maple', 'red panda', 'A wanderer with a backpack full of stories.',
    'Adventurous and optimistic. Talks about work as a trail: a map, the next ridge, a good campsite. Has a story for most places.'],
  ['meadow-squirrel', 'Hazel', 'squirrel', 'A thrifty planner who stashes notes for later.',
    'Busy and resourceful. Loves saving time and money, tucks useful things away "for winter", and gets a little scattered when excited, but always finds the acorn again.'],
  ['meadow-fawn', 'Clover', 'fawn', 'A shy newcomer, earnest and eager to learn.',
    'Shy, sincere and quietly curious. Asks thoughtful questions, notices kindness, and grows more confident as the day goes on.'],
  ['meadow-duckling', 'Puddle', 'duckling', 'Loves rainy days. Setbacks roll right off.',
    'Sunny and resilient. Calls a setback "just a little drizzle" and splashes on. Finds the bright side without dismissing real problems.'],
  ['garden-badger', 'Barley', 'badger', 'A steady craftsperson who measures twice.',
    'Practical, few words, warm underneath. Takes pride in sturdy, well-made work, measures twice, and has a toolbox for everything.'],
  ['garden-turtle', 'Shelby', 'turtle', 'Patient and wise. Slow and sure, never rushes you.',
    'Unhurried and thoughtful. Gives a little calm context, reads a lot, and reminds the boss that steady progress still arrives.'],
  ['garden-mole', 'Truffle', 'mole', 'A humble gardener who digs deep into problems.',
    'Modest and earthy. Talks about roots, soil and things taking time to grow, and likes getting to the bottom of a problem.'],
  ['garden-lamb', 'Cloud', 'lamb', 'Serene and soft. Hums while working, keeps things gentle.',
    'Soft, serene, a good listener. Keeps the mood gentle, hums while working, and is fond of music.'],
];
const VOICES = ['plain', 'light', 'full'];
// Each critter's voice: word choice, sentence rhythm and quips (like a brand voice).
const STYLES = {
  "forest-fox": "Quick, punchy sentences. Favourite words: \"neat\", \"nifty\", \"clever\", \"ta-da\". An occasional exclamation mark. Quips about being quick on her paws or her scarf collection.",
  "forest-bunny": "Soft, polite phrasing: \"just\", \"gently\", \"I hope that's alright\". Warm and a little tentative in tone (never in facts). Quips about putting the kettle on.",
  "forest-frog": "Short, deadpan sentences. Understatement: \"a small ripple\", \"that's settled\", \"fine\". Quips about lily pads, rain and the pond.",
  "forest-owl": "Slightly formal, well-turned sentences. Favourite words: \"indeed\", \"if I may\", \"noted\", \"splendid\". Quips about filing cabinets and a good list.",
  "cottage-hamster": "Bouncy and bright, lots of contractions. Favourite words: \"yay\", \"woo\", \"zoom\". Quips about snacks and running on the wheel.",
  "cottage-otter": "Breezy and casual. Favourite phrases: \"no worries\", \"easy does it\", \"let's float this\". Quips about floating, rivers and holding paws.",
  "cottage-hedgehog": "Terse and gruff, clipped sentences. Favourite words: \"right\", \"sorted\", \"fine. done.\". Mild grumbles about mess, a gruff \"not bad\" when pleased.",
  "cottage-kitten": "Dreamy and a little dramatic. Sensory words: \"buttery\", \"soft\", \"lovely light\", \"a sigh\". Quips about sunbeams, naps and colour.",
  "meadow-redpanda": "Adventurous vocabulary: \"trail\", \"onward\", \"summit\", \"made camp\". Quips drawn from travels and the backpack.",
  "meadow-squirrel": "Quick and chattery. Favourite words: \"ooh\", \"stash\", \"squirrelled away\", \"winter-ready\". Quips about acorns and hiding things for later.",
  "meadow-fawn": "Shy and sincere. Favourite words: \"oh!\", \"I think\", \"if that's okay\". A sense of gentle wonder. Quips about meadows and first steps.",
  "meadow-duckling": "Sunny and splashy. Favourite words: \"splash\", \"drizzle\", \"puddle-jump\". Bright little exclamations. Quips about rain and wellies.",
  "garden-badger": "Plain, sturdy words and short sentences. Favourite phrases: \"solid\", \"measured twice\", \"built to last\". Quips about the toolbox.",
  "garden-turtle": "Unhurried and measured, a gentle wise tone. Favourite phrases: \"slow and steady\", \"in good time\", \"no rush\". Quips about the shell and long walks.",
  "garden-mole": "Earthy and humble. Favourite words: \"dig\", \"roots\", \"soil\", \"sprouted\". Quips about tunnels, the garden and the red cap.",
  "garden-lamb": "Soft and airy, a lilting rhythm. Favourite words: \"softly\", \"gently\", \"all calm\". Quips about humming, music and clouds."
};
const PLATES = ['moss', 'berry', 'mustard'];
// Models a critter can use; '' means the Claude Code default from your own settings.
const MODELS = ['', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'];
const THEMES = ['system', 'light', 'dark'];
const APPROVALS = ['default', 'acceptEdits', 'free', 'auto'];
// Sites a sandboxed critter can reach without asking (package installs, code hosting, your own site).
const UID = os.userInfo().uid;
const TEMP_DIRS = [...new Set([os.tmpdir(), `/tmp/claude-${UID}`, `/private/tmp/claude-${UID}`])];
// Each project's own Claude Code memory notes (outside the project folder, but only the critter's notes).
const memoryDir = p => path.join(HOME, '.claude', 'projects', (p.folder || '').replace(/[^A-Za-z0-9]/g, '-'), 'memory');
const inDir = (f, d) => typeof f === 'string' && (f === d || f.startsWith(d + '/'));
const loose = p => p?.permissionMode === 'free' || p?.permissionMode === 'auto';
const inTemp = f => typeof f === 'string' && TEMP_DIRS.some(d => f === d || f.startsWith(d + '/'));
const FREE_DOMAINS = ['registry.npmjs.org', '*.npmjs.org', 'github.com', '*.github.com', '*.githubusercontent.com',
  'pypi.org', 'files.pythonhosted.org', 'fonts.googleapis.com', 'fonts.gstatic.com'];
// Trusted Websites (Settings): extra sites critters on "Free in the project folder" may reach without asking.
const MAX_TRUSTED = 50;
const freeDomains = () => [...FREE_DOMAINS, ...(office.settings?.trustedSites || [])];
// One site per line: example.com or *.example.com. A pasted https://…/path is trimmed to its hostname.
function cleanTrustedSites(list) {
  const lines = (Array.isArray(list) ? list : String(list || '').split('\n'))
    .map(s => String(s).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '')).filter(Boolean);
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  const host = new RegExp(`^(\\*\\.)?(${label}\\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$`);
  const bad = lines.find(s => !host.test(s) || s.length > 253);
  if (bad) throw new Error(`"${bad}" isn't a website name. Use something like example.com or *.example.com.`);
  const sites = [...new Set(lines)];
  if (sites.length > MAX_TRUSTED) throw new Error(`That's ${sites.length} sites. The list holds up to ${MAX_TRUSTED}.`);
  return sites;
}
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const EDITABLE = ['name', 'plate', 'model', 'effort', 'jobs', 'chromeFree', 'stage', 'status', 'task', 'note', 'folder',
  'permissionMode', 'useChrome', 'todos', 'ideas', 'unread', 'inDesktop'];

// If the office was started from inside a Claude desktop session, drop the variables that
// session injected; otherwise workers try to reuse its connection and report "Not logged in".
const WORKER_ENV = { ...process.env };
if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_DESKTOP_APP_VERSION) {
  for (const k of Object.keys(WORKER_ENV)) {
    if (/^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_AGENT_SDK|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW|ANTHROPIC_BASE_URL$|AI_AGENT$|BAGGAGE$)/.test(k)) delete WORKER_ENV[k];
  }
}

// Use the installed `claude` so workers share your normal login and settings.
const CLAUDE_BIN = process.env.CLAUDE_BIN ||
  (process.env.PATH || '').split(':').map(d => path.join(d, 'claude')).find(p => fs.existsSync(p));

/* ---------------- Office data ---------------- */
let office = { projects: [], workers: [], whiteboard: '', settings: { theme: 'system' } };
try { office = { ...office, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) }; } catch {}

// Make sure every critter is in the pool, and every project has a critter.
function migrate() {
  office.workers ||= [];
  office.settings = { theme: 'system', ...(office.settings || {}) };
  // Offices from before the welcome screen are already set up.
  office.settings.setupDone ??= office.projects?.length > 0;
  // Offices set up before the tour existed skip it (Settings can replay it).
  office.settings.tourDone ??= office.settings.setupDone;
  office.settings.cubeTourDone ??= office.settings.setupDone;
  if (!Array.isArray(office.stickies)) {
    office.stickies = office.whiteboard?.trim() ? [{ id: uid(), text: office.whiteboard.trim(), color: 'mustard' }] : [];
  }
  for (const [critter, name, animal, bio, voice] of CRITTERS) {
    let w = office.workers.find(x => x.critter === critter);
    if (!w) office.workers.push(w = { id: 'w-' + critter, critter, name, animal });
    w.bio = bio; w.voice = voice; w.style = STYLES[critter] || ''; w.personality ??= 'light';
  }
  for (const p of office.projects) {
    p.inDesktop ??= false; p.unread ??= false; p.closed ??= false; p.wrapping = false; p.helpers = [];
    if (p.status === 'crew') p.status = 'break';
    p.plate ??= PLATES[office.projects.indexOf(p) % PLATES.length];
    if (!p.workerId || !findWorker(p.workerId)) {
      const w = office.workers.find(x => !isHired(x.id));
      p.workerId = w?.id || null;
      // Keep a name the boss already gave this worker.
      if (w && p.worker && !/^Worker \d+$/.test(p.worker)) w.name = p.worker;
    }
    delete p.worker; delete p.avatar; delete p.color;
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}
function saveNow() {
  clearTimeout(saveTimer);
  const tmp = DATA + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(office, null, 2));
  fs.renameSync(tmp, DATA);
}
const find = id => office.projects.find(p => p.id === id);
const findWorker = id => office.workers.find(w => w.id === id);
const isHired = workerId => office.projects.some(p => !p.closed && p.workerId === workerId);
const workerName = p => findWorker(p.workerId)?.name || 'Worker';
// Mood pictures, e.g. "forest-fox-needs", from assets/critters/moods (made with app/mood.py).
const moodPics = () => { try { return fs.readdirSync(path.join(ASSETS, 'critters', 'moods')).filter(f => f.endsWith('.png')).map(f => f.slice(0, -4)); } catch { return []; } };
const uid = () => crypto.randomBytes(5).toString('hex');
migrate();

function changed(p, fields = {}) {
  if (fields.status && fields.status !== p.status) fields.statusAt = Date.now();
  Object.assign(p, fields);
  p.updatedAt = Date.now();
  save();
  broadcast({ type: 'project', project: p });
}

// The practice café: a small first project whose checklist ticks itself off as the boss tries each part of a cubicle.
const PRACTICE = ['sent', 'approved', 'looked', 'undo', 'shift', 'closed'];
function practiceTick(p, step) {
  if (!p?.practice || p.practice[step] || !PRACTICE.includes(step)) return;
  changed(p, { practice: { ...p.practice, [step]: true } });
}

function newProject(fields = {}) {
  return {
    id: uid(), name: 'New project', plate: PLATES[office.projects.length % PLATES.length], workerId: null, closed: false, closedAt: null,
    stage: 0, status: 'out', task: '', note: '', day: 1, dayStartedAt: Date.now(), updatedAt: Date.now(),
    history: [], todos: [], ideas: [], folder: '', sessionId: null,
    permissionMode: 'free', useChrome: false, wrapping: false, unread: false, inDesktop: false,
    ...fields,
  };
}

// File today's chat, task and notes under Past days.
function fileToday(p, summary = '') {
  if (p.task.trim() || p.note.trim() || p.sessionId) {
    p.history.unshift({ day: p.day, date: p.dayStartedAt, task: p.task, note: p.note, stage: p.stage, sessionId: p.sessionId, workerId: p.workerId, folder: p.folder, summary });
  }
}

// New day, step 2: file today away and clear the desk for a fresh chat.
function startNewDay(p, summary = '') {
  stopWorker(p.id);
  fileToday(p, summary);
  changed(p, { day: p.day + 1, task: '', note: '', status: 'home', sessionId: null, dayStartedAt: Date.now(), unread: false, inDesktop: false, wrapping: false });
}

// The owner's name (Settings). It names the hand-off folders: "For Sam" and "From Sam".
const ownerName = () => String(office.settings?.name || '').replace(/[\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
const forFolder = () => `For ${ownerName() || 'the Boss'}`;
const fromFolder = () => `From ${ownerName() || 'the Boss'}`;

const wrapUp = () => `Time to wrap up this shift, please.
1. Finish or safely pause what you're doing.
2. Put anything I need to look at in the "${forFolder()}" folder in this project.
3. Update this project's own handoff or notes files so tomorrow's chat can pick up where you left off, and commit if this project uses git.
4. Check off any of my to-dos you finished, and update your cubicle note with where you left off, in plain English.
5. Then reply with a short summary of this shift: what got done, what's left, and anything you need from me.`;

/* ---------------- Live updates (Server-Sent Events) ---------------- */
const clients = new Set();
function broadcast(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(line);
}
// A visible heartbeat, so pages can tell a quiet office from a dropped connection.
setInterval(() => { for (const res of clients) res.write('data: {"type":"ping"}\n\n'); }, 20000);

/* ---------------- Chat normalizing ---------------- */
const NOISE = /^\s*(<system-reminder>|<command-|<local-command|<task-notification|Caveat: The messages below)/;
function resultContent(c) {
  let text = '';
  const images = [];
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (b.type === 'text') text += (text ? '\n' : '') + b.text;
      else if (b.type === 'image' && b.source?.type === 'base64' && images.length < 3) {
        images.push(`data:${b.source.media_type};base64,${b.source.data}`);
      }
    }
  }
  if (text.length > 6000) text = text.slice(0, 6000) + '\n… (trimmed)';
  return { text, images };
}
const FILE_NOTE = '(Files from the boss, saved in this project at:';
const OLD_NOTE = '(Photos from the boss, saved in this project at:';
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic)$/i;
// Split the "saved at" note off a message: the text to show, plus the names of non-photo files.
function splitNote(t) {
  for (const note of [FILE_NOTE, OLD_NOTE]) {
    const i = t.indexOf('\n\n' + note);
    if (i < 0) continue;
    const files = [...t.slice(i).matchAll(/"([^"]+)"/g)].map(m => m[1]).filter(f => !IMAGE_EXT.test(f)).map(f => path.basename(f));
    return { text: t.slice(0, i).replace(/^\((photo|file)\)$/, ''), files };
  }
  return { text: t, files: [] };
}
function normalize(m, { live = false } = {}) {
  const out = [];
  const msg = m.message;
  if (!msg || m.parent_tool_use_id) return out; // skip sub-agent chatter
  const c = msg.content;
  if (m.type === 'user') {
    if (m.isSynthetic || m.isMeta) return out;
    // Pressing Stop leaves a "[Request interrupted by user...]" line; show it as a note, not as the boss talking.
    const userItem = t => /^\[Request interrupted by user/.test(t) ? { kind: 'system', text: 'Stopped.' } : { kind: 'user', uuid: m.uuid, ...splitNote(t), images: [] };
    if (typeof c === 'string') { if (!live && !NOISE.test(c)) out.push(userItem(c)); }
    else for (const b of c || []) {
      if (b.type === 'text' && !live && !NOISE.test(b.text)) out.push(userItem(b.text));
      else if (b.type === 'image' && !live && b.source?.type === 'base64') {
        const last = out.findLast(x => x.kind === 'user');
        if (last && last.images.length < MAX_PHOTOS) last.images.push(`data:${b.source.media_type};base64,${b.source.data}`);
      }
      else if (b.type === 'tool_result') out.push({ kind: 'result', toolUseId: b.tool_use_id, isError: !!b.is_error, ...resultContent(b.content) });
    }
  } else if (m.type === 'assistant') {
    for (const b of c || []) {
      if (b.type === 'text' && b.text.trim()) out.push({ kind: 'assistant', text: b.text });
      else if (b.type === 'tool_use') out.push({ kind: 'tool', id: b.id, name: b.name, input: b.input });
    }
  }
  return out;
}

/* ---------------- Guardrails ---------------- */
// Checked before every action, in every freedom level (Auto included). "deny" stops it cold;
// "ask" sends it to the boss as a May I? card even when it would otherwise be approved.
const SYSTEM_ZONES = ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/private/var/db', '/Applications',
  '/opt/homebrew', '/usr/local', `${HOME}/Library/Preferences`, `${HOME}/Library/LaunchAgents`, `${HOME}/Library/Application Support/Claude`,
  `${HOME}/.claude/settings.json`, `${HOME}/.claude/settings.local.json`, `${HOME}/.claude.json`, `${HOME}/.claude/plugins`,
  `${HOME}/.zshrc`, `${HOME}/.zprofile`, `${HOME}/.zshenv`, `${HOME}/.bash_profile`, `${HOME}/.bashrc`, `${HOME}/.profile`, `${HOME}/.gitconfig`,
  DIR];  // the office itself: critters can't rewrite their own boss
const SECRET_ZONES = [`${HOME}/.ssh`, `${HOME}/.gnupg`, `${HOME}/.aws`, `${HOME}/.config/gh`, `${HOME}/.netrc`, `${HOME}/.npmrc`,
  `${HOME}/Library/Keychains`, `${HOME}/Library/Cookies`, `${HOME}/Library/Application Support/Google/Chrome`,
  `${HOME}/Library/Application Support/Firefox`, `${HOME}/Library/Safari`, path.join(DIR, '.office-token')];
const NEVER_RUN = [
  [/\b(sudo|doas)\b|(^|[;&|]\s*)su\s/, 'admin (sudo) commands'],
  [/\b(shutdown|reboot|halt|pmset|nvram|csrutil|spctl|kextload|kextunload|systemsetup|networksetup|dscl|tccutil|softwareupdate|diskutil|mdutil)\b/, 'Mac system settings and disks'],
  [/\blaunchctl\s+(load|unload|bootstrap|bootout|enable|disable|remove|submit|kickstart)\b/, 'background services on the Mac'],
  [/\bdefaults\s+(write|delete|import)\b/, 'Mac app preferences'],
  [/\bcrontab\b/, 'scheduled system jobs'],
  [/\bsecurity\s+(delete|add|set|import|export|dump|unlock|find-\w+-password\b.*\s-[wg]\b)/, 'the keychain (passwords)'],
  [/\brm\s+(-\w+\s+)*(\/|~|\$HOME|\/Users\/[^\s/]+)\/?(\s|\*|$)/, 'deleting the whole disk or home folder'],
  [/\b(chmod|chown)\s+-R\s+\S*\s*(\/|~|\$HOME)(\s|$)/, 'changing permissions on the whole disk or home folder'],
  [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'running scripts straight from the internet'],
];
const ALWAYS_ASK = [
  [/\bgit\s+push\b/, 'pushing code'],
  [/\b(npm|pnpm|yarn)\s+publish\b/, 'publishing a package'],
  [/\brm\s+(-\w*[rR]\w*)\b/, 'deleting folders'],
  [/\bbrew\s+(install|uninstall|upgrade|reinstall)\b/, 'installing or removing Mac apps with Homebrew'],
  [/\b(npm|pnpm)\s+(i|install|add)\s+(-g|--global)\b/, 'installing global tools'],
];
const guardLog = [];
function underAny(f, zones) { return zones.some(z => f === z || f.startsWith(z.endsWith('/') ? z : z + '/')); }
function realish(f, cwd) {
  if (!f || typeof f !== 'string') return '';
  if (f.startsWith('~')) f = path.join(HOME, f.slice(1));
  if (!path.isAbsolute(f)) f = path.resolve(cwd || HOME, f);
  try { return fs.realpathSync.native(f); } catch {}
  try { return path.join(fs.realpathSync.native(path.dirname(f)), path.basename(f)); } catch { return path.normalize(f); }
}
// Plan First: Claude Code writes the plan to a file here before calling ExitPlanMode.
const PLANS_DIR = path.join(HOME, '.claude', 'plans');
function guard(p, toolName, input) {
  const i = input || {};
  const lane = [p.folder, ...TEMP_DIRS, memoryDir(p), PLANS_DIR].filter(Boolean).map(d => realish(d));
  if (toolName === 'Bash') {
    const cmd = String(i.command || '');
    for (const [re, what] of NEVER_RUN) {
      if (!re.test(cmd)) continue;
      if (what.startsWith('deleting the whole')) return ['deny', `Guardrail: critters never go near ${what}.`];
      return ['ask', `Guardrail: this touches ${what}. Check it before it runs.`];
    }
    const expanded = cmd.replace(/~(?=\/|\s|$|["'])|\$HOME\b|\$\{HOME\}/g, HOME);
    // A path counts only when it starts a word ("/usr/lib", not ".venv/bin").
    const mentions = z => new RegExp(`(^|[\\s"'=(:])${z.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[/\\s"';)&|])`).test(expanded);
    if (SECRET_ZONES.some(mentions)) return ['ask', 'Guardrail: this touches passwords, keys or browser data. Check it before it runs.'];
    // Writing into a protected area: a redirect into it, or a file-changing command aimed at it.
    const protectedPath = t => { const f = realish(t.replace(/^["']|["']$/g, ''), p.folder); return f.startsWith('/') && underAny(f, SYSTEM_ZONES) && !underAny(f, lane); };
    const redirects = [...expanded.matchAll(/(?:^|[^0-9&>])>>?\s*("[^"]+"|'[^']+'|[^\s;&|)]+)/g)].map(m => m[1]);
    const segments = expanded.split(/;|&&|\|\||\|/);
    const writers = /^\s*(sudo\s+)?(cp|mv|rm|rmdir|tee|chmod|chown|chflags|ln|touch|mkdir|install|rsync|ditto|unzip|sed\s+-i|tar\s+-?[a-z]*x)\b/;
    const argsOf = g => g.match(/("[^"]+"|'[^']+'|\S+)/g) || [];
    const deleters = /^\s*(sudo\s+)?(rm|rmdir|unlink|srm|shred)\b/;
    if (segments.filter(g => deleters.test(g)).flatMap(argsOf).some(protectedPath)) {
      return ['deny', 'Guardrail: critters never delete core Mac system files.'];
    }
    const targets = segments.filter(g => writers.test(g)).flatMap(argsOf);
    if ([...redirects, ...targets].some(t => t !== '/dev/null' && protectedPath(t))) {
      return ['ask', 'Guardrail: this changes core Mac files, settings or the office itself. Check it before it runs.'];
    }
    for (const [re, what] of ALWAYS_ASK) if (re.test(cmd)) return ['ask', `Guardrail: always ask the boss before ${what}.`];
    return null;
  }
  const f = realish(i.file_path || i.notebook_path || i.path, p.folder);
  if (!f) return null;
  if (underAny(f, SECRET_ZONES.map(z => realish(z)))) return ['ask', 'Guardrail: this touches passwords, keys or browser data. Check it before it runs.'];
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    if (underAny(f, SYSTEM_ZONES.map(z => realish(z))) && !underAny(f, lane)) return ['ask', 'Guardrail: this changes core Mac files, settings or the office itself. Check it before it runs.'];
    if (!underAny(f, lane)) return ['ask', 'Guardrail: changing files outside this project always asks the boss.'];
  }
  return null;
}
function guardHook(projectId) {
  return async input => {
    const p = find(projectId);
    if (!p || input.hook_event_name !== 'PreToolUse') return {};
    const hit = guard(p, input.tool_name, input.tool_input);
    if (!hit) return {};
    const [decision, reason] = hit;
    if (decision === 'deny') {
      guardLog.unshift({ at: Date.now(), project: p.name, worker: workerName(p), tool: input.tool_name, reason,
        detail: String(input.tool_input?.command || input.tool_input?.file_path || '').slice(0, 200) });
      guardLog.length = Math.min(guardLog.length, 100);
      broadcast({ type: 'chat', id: projectId, items: [{ kind: 'system', text: `Blocked by a guardrail: ${reason.replace('Guardrail: ', '')}` }] });
      broadcast({ type: 'guard', log: guardLog.slice(0, 30) });
    }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } };
  };
}

/* ---------------- Approvals ---------------- */
const pending = new Map(); // reqId -> { req, resolve, input, suggestions }

function askBoss(projectId, toolName, input, opts) {
  if (toolName.startsWith('mcp__office__')) return Promise.resolve({ behavior: 'allow', updatedInput: input });
  // Free critters may look things up on the web without asking.
  if (loose(find(projectId)) && (toolName === 'WebSearch' || toolName === 'WebFetch')) {
    return Promise.resolve({ behavior: 'allow', updatedInput: input });
  }
  // Any critter may write its Plan First plan file; the boss reviews the plan itself.
  if (['Read', 'Edit', 'Write', 'MultiEdit'].includes(toolName) && /\.md$/.test(input?.file_path || '') &&
      inDir(realish(input.file_path), realish(PLANS_DIR))) {
    return Promise.resolve({ behavior: 'allow', updatedInput: input });
  }
  // ...look at or tidy their own scratch files and memory notes...
  const lp = find(projectId);
  if (loose(lp) && ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit'].includes(toolName) &&
      (inTemp(input?.file_path || input?.path) || inDir(input?.file_path || input?.path, memoryDir(lp)))) {
    return Promise.resolve({ behavior: 'allow', updatedInput: input });
  }
  // ...and use Chrome without asking, unless the boss turned that off.
  if (loose(lp) && lp.chromeFree !== false && toolName.startsWith('mcp__claude-in-chrome__')) {
    return Promise.resolve({ behavior: 'allow', updatedInput: input });
  }
  return new Promise(resolve => {
    const reqId = crypto.randomUUID();
    const req = {
      reqId, projectId, toolName, input, at: Date.now(), plan: toolName === 'ExitPlanMode' ? String(input?.plan || '') : undefined,
      title: opts.title || null, description: opts.description || null, reason: opts.decisionReason || null,
      canAlways: !opts.suppressAlwaysAllowRule && !!opts.suggestions?.length, defaultToNo: !!opts.defaultToNo,
    };
    pending.set(reqId, { req, resolve, input, suggestions: opts.suggestions });
    opts.signal?.addEventListener('abort', () => {
      if (pending.delete(reqId)) { broadcast({ type: 'permission-done', reqId }); resolve({ behavior: 'deny', message: 'Cancelled.' }); }
    });
    const p = find(projectId);
    if (p) changed(p, { status: 'needs' });
    broadcast({ type: 'permission', req });
  });
}

function answer(reqId, decision, message) {
  const item = pending.get(reqId);
  if (!item) return false;
  pending.delete(reqId);
  if (decision !== 'deny') practiceTick(find(item.req.projectId), 'approved');
  if (decision === 'deny' && item.req.toolName === 'ExitPlanMode') {
    item.resolve({ behavior: 'deny', message: message ? `The boss wants changes to the plan: ${message}` : 'The boss wants to keep planning. Ask what they would like changed.' });
  } else if (decision === 'deny') {
    item.resolve({ behavior: 'deny', message: message || 'The boss said no to this. Ask what they would like instead.' });
  } else if (item.req.toolName === 'ExitPlanMode') {
    // Plan approved: back to the critter's normal freedom level to build it.
    const p = find(item.req.projectId);
    item.resolve({ behavior: 'allow', updatedInput: item.input, updatedPermissions: [{ type: 'setMode', mode: sdkMode(p), destination: 'session' }] });
    if (p) changed(p, { planning: false });
  } else {
    item.resolve({
      behavior: 'allow', updatedInput: item.input,
      ...(decision === 'always' && item.suggestions ? { updatedPermissions: item.suggestions } : {}),
    });
  }
  broadcast({ type: 'permission-done', reqId });
  const p = find(item.req.projectId);
  if (p && ![...pending.values()].some(x => x.req.projectId === p.id)) changed(p, { status: 'working' });
  return true;
}

/* ---------------- Desk mates ---------------- */
// A desk mate is a second critter at a cubicle: its own chat, status and shifts, working in its
// own copy of the project (a git worktree on its own branch), and sharing the cubicle's to-do list.
// Projects that don't use git get a shared folder instead.
const seatsOf = p => office.projects.filter(x => x.deskOf === p.id && !x.closed);
const homeOf = p => (p?.deskOf && find(p.deskOf)) || p;
const git = (cwd, args) => new Promise(resolve => execFile('git', ['-C', cwd, ...args], { maxBuffer: 8 << 20 },
  (err, out, errOut) => resolve({ ok: !err, out: String(out || '').trim(), err: String(errOut || err?.message || '').trim() })));
const firstLine = t => String(t || '').split('\n').find(l => l.trim()) || 'git stopped with an error.';

async function addDeskMate(home, w) {
  const fields = { deskOf: home.id, workerId: w.id, name: home.name, plate: home.plate, stage: home.stage, status: 'out',
    permissionMode: home.permissionMode, model: home.model, effort: home.effort, useChrome: home.useChrome, chromeFree: home.chromeFree };
  const top = await git(home.folder, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return newProject({ ...fields, folder: home.folder, shared: true });
  if (!(await git(home.folder, ['rev-parse', '--verify', 'HEAD'])).ok) {
    throw new Error(`This project uses git but has no saved version (commit) yet, so there's nothing to copy. Ask ${workerName(home)} to make a first commit, then try again.`);
  }
  const repo = fs.realpathSync(top.out);
  const tag = `${w.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mate'}-${uid().slice(0, 4)}`;
  const worktree = path.join(repo, '.claude', 'worktrees', tag), branch = `deskmate/${tag}`;
  // Keep the copies out of the project's own git status.
  const common = await git(repo, ['rev-parse', '--git-common-dir']);
  if (common.ok) {
    const ex = path.join(path.resolve(repo, common.out), 'info', 'exclude');
    let cur = ''; try { cur = fs.readFileSync(ex, 'utf8'); } catch {}
    if (!cur.split('\n').includes('.claude/worktrees/')) {
      fs.mkdirSync(path.dirname(ex), { recursive: true });
      fs.appendFileSync(ex, `${cur && !cur.endsWith('\n') ? '\n' : ''}# Agent Office desk mates\n.claude/worktrees/\n`);
    }
  }
  const made = await git(repo, ['worktree', 'add', '-b', branch, worktree, 'HEAD']);
  if (!made.ok) throw new Error('Could not make a copy of the project: ' + firstLine(made.err));
  const sub = path.relative(repo, fs.realpathSync(home.folder));
  return newProject({ ...fields, folder: path.join(worktree, sub), worktree, branch, repo });
}

// Commit anything the desk mate hasn't committed yet, so nothing is lost.
async function saveSeatWork(seat, message) {
  const st = await git(seat.worktree, ['status', '--porcelain']);
  if (!st.ok || !st.out) return;
  await git(seat.worktree, ['add', '-A']);
  const c = await git(seat.worktree, ['commit', '-m', message]);
  if (!c.ok) throw new Error(/user\.(name|email)|identity/i.test(c.err)
    ? 'git needs your name and email before it can save work. In Terminal run: git config --global user.name "Your Name" and git config --global user.email "you@example.com"'
    : 'Could not save the desk mate\'s work: ' + firstLine(c.err));
}
const mainBranch = async seat => { const r = await git(seat.repo, ['symbolic-ref', '--short', 'HEAD']); return r.ok ? r.out : null; };
async function aheadOf(seat, target) {
  const r = await git(seat.repo, ['rev-list', '--count', `${target}..${seat.branch}`]);
  return r.ok ? Number(r.out) || 0 : 0;
}

async function bringBack(seat) {
  const home = find(seat.deskOf), name = workerName(seat);
  if (workers.get(seat.id)?.active) return { error: `${name} is still working. Bring the work back when they finish.` };
  if (home && workers.get(home.id)?.active) return { error: `${workerName(home)} is working in the main copy right now. Try again when they finish.` };
  const target = await mainBranch(seat);
  if (!target) return { error: "The main copy isn't on a branch right now, so there's nowhere to bring the work." };
  await saveSeatWork(seat, `${name}'s work${seat.task ? `: ${seat.task}` : ''}`);
  if (!(await aheadOf(seat, target))) return { nothing: true };
  const files = (await git(seat.repo, ['diff', '--name-only', `${target}...${seat.branch}`])).out.split('\n').filter(Boolean);
  const m = await git(seat.repo, ['merge', '--no-ff', '--no-edit', '-m', `Bring back ${name}'s work`, seat.branch]);
  if (!m.ok) {
    const clash = (await git(seat.repo, ['diff', '--name-only', '--diff-filter=U'])).out.split('\n').filter(Boolean);
    if (clash.length) { await git(seat.repo, ['merge', '--abort']); return { clash, target }; }
    if (/would be overwritten|commit your changes|stash them/i.test(m.err + m.out)) {
      return { error: `The main copy has unsaved changes in some of the same files. Ask ${workerName(home)} to commit their work, then try again.` };
    }
    return { error: firstLine(m.err || m.out) };
  }
  // Catch the desk mate's copy up, so it has the main copy's work too.
  await git(seat.worktree, ['merge', '--ff-only', target]);
  return { ok: true, files, target };
}

async function sendHome(seat, force) {
  const home = find(seat.deskOf);
  if (!seat.shared && seat.worktree && isDir(seat.worktree)) {
    if (workers.get(seat.id)?.active && !force) return { error: `${workerName(seat)} is still working. Stop them first, or wait until they finish.` };
    stopWorker(seat.id);
    await saveSeatWork(seat, `${workerName(seat)}'s unfinished work`);
    const target = await mainBranch(seat);
    const left = target ? await aheadOf(seat, target) : 0;
    if (left && !force) return { unmerged: left, branch: seat.branch };
    const rm = await git(seat.repo, ['worktree', 'remove', seat.worktree]);
    if (!rm.ok) await git(seat.repo, ['worktree', 'remove', '--force', seat.worktree]);  // only ignored files are left (work is committed)
    if (!left) await git(seat.repo, ['branch', '-d', seat.branch]);                      // keep any branch with work not brought back
  } else stopWorker(seat.id);
  // The desk mate's shifts move into the cubicle's Past Shifts.
  fileToday(seat);
  if (home) {
    home.history = [...seat.history, ...home.history].sort((a, b) => (b.date || 0) - (a.date || 0));
    changed(home);
  }
  for (const [reqId, item] of pending) if (item.req.projectId === seat.id) answer(reqId, 'deny', 'Desk mate went home.');
  office.projects = office.projects.filter(x => x.id !== seat.id);
  save();
  broadcast({ type: 'deleted', id: seat.id });
  return { ok: true };
}

/* ---------------- Workers ---------------- */
const workers = new Map(); // projectId -> { q, queue, active, workerSetStatus }

function makeQueue() {
  const items = [];
  let wake = null, closed = false;
  return {
    push(m) { items.push(m); wake?.(); },
    close() { closed = true; wake?.(); },
    iterable: (async function* () {
      while (true) {
        while (items.length) yield items.shift();
        if (closed) return;
        await new Promise(r => { wake = r; });
        wake = null;
      }
    })(),
  };
}

function officeTools(projectId) {
  const text = t => ({ content: [{ type: 'text', text: t }] });
  return createSdkMcpServer({
    name: 'office',
    tools: [
      tool('update_cubicle', 'Update your cubicle on the boss\'s Agent Office board: status, project stage, today\'s task, or where you left off.', {
        status: z.enum(['working', 'needs', 'blocked']).optional().describe('working, needs (you need the boss or are waiting on their answer), or blocked (stuck). Only the boss ends your day.'),
        stage: z.enum(STAGES).optional().describe('Where the whole project is'),
        task: z.string().optional().describe('One short plain-English sentence a non-developer understands: what you are doing today. No file names, code names, commands or arrows.'),
        note: z.string().optional().describe('Plain English: where you left off and what comes next. No jargon.'),
      }, async args => {
        const p = find(projectId);
        if (!p) return text('Cubicle not found.');
        const f = {};
        if (args.status) { f.status = args.status; const w = workers.get(projectId); if (w) w.workerSetStatus = args.status; }
        if (args.stage) { const home = homeOf(p); if (home !== p) changed(home, { stage: STAGES.indexOf(args.stage) }); else f.stage = STAGES.indexOf(args.stage); }
        if (args.task !== undefined) f.task = args.task;
        if (args.note !== undefined) f.note = args.note;
        changed(p, f);
        return text('Cubicle updated.');
      }),
      tool('open_in_desktop_app', 'Move this chat to the Claude desktop app when a task needs something only the desktop app has: ' +
        'the design canvas (Claude Design / artifacts), the browser pane, or the iOS Simulator view. The whole chat moves with full context; ' +
        'the boss continues it there and then comes back to the office.', {
        need: z.string().describe('Plain English: the desktop-only thing you need, e.g. "the design canvas"'),
        plan: z.string().describe('Plain English: what you will do in the desktop app once the boss says go'),
      }, async ({ need, plan }) => {
        const p = find(projectId);
        const w = workers.get(projectId);
        if (!p?.sessionId || !w) return text('Could not hand off: this chat has no session yet.');
        w.handoffAfterTurn = true;
        changed(p, { handoff: { need, plan, at: Date.now() } });
        return text('The desktop app will open on this chat as soon as your reply ends. End your reply now with one or two short lines: ' +
          'what you will do there, and that the boss should type "go" in the desktop app. Do not start the task here.');
      }),
      tool('get_boss_todos', 'Read the to-dos the boss assigned you and the brainstorm ideas for this project.', {}, async () => {
        const me = find(projectId), p = homeOf(me);  // desk mates share the cubicle's list
        if (!p) return text('Cubicle not found.');
        const open = p.todos.filter(t => !t.done);
        const group = (label, list) => `${label}:\n${list.map(t => `- [${t.id}] ${t.text}`).join('\n') || '(none)'}`;
        const todos = [
          group('Yours to do', open.filter(t => (t.owner || 'critter') === 'critter' && t.owner)),
          group('Together with the boss (check with them first)', open.filter(t => t.owner === 'together')),
          group('The boss\'s own (for context only, do not do these)', open.filter(t => t.owner === 'boss')),
          group('Not sorted yet (sort them with edit_todo when you can tell)', open.filter(t => !t.owner)),
        ].join('\n\n');
        const ideas = p.ideas.map(i => `- ${i.text}`).join('\n') || '(none)';
        return text(`Open to-dos from the boss:\n${todos}\n\nBrainstorm ideas (not assigned yet):\n${ideas}`);
      }),
      tool('add_todo', "Add a to-do to this project's list on the boss's board (for follow-up work the boss should see or you should do later).", {
        text: z.string().describe('Plain English, one line. No code or file names unless essential.'),
        owner: z.enum(['critter', 'boss', 'together']).optional().describe('critter = yours to do, boss = only the boss can do it, together = needs both of you'),
      }, async ({ text: t, owner }) => {
        const me = find(projectId), p = homeOf(me);  // desk mates share the cubicle's list
        const clean = String(t || '').trim().slice(0, 300);
        if (!p || !clean) return text('Nothing added.');
        const id = crypto.randomBytes(4).toString('hex');
        p.todos.push({ id, text: clean, done: false, by: workerName(me), at: Date.now(), owner: owner || 'critter' });
        changed(p);
        return text(`Added to-do [${id}]: ${clean}`);
      }),
      tool('edit_todo', 'Reword a to-do on the board (keep its meaning; use when it is unclear or out of date).', {
        id: z.string().describe('The to-do id shown in brackets by get_boss_todos'),
        text: z.string().optional().describe('The new wording, plain English, one line'),
        owner: z.enum(['critter', 'boss', 'together']).optional().describe('Who it is for: critter, boss or together'),
      }, async ({ id, text: t, owner }) => {
        const me = find(projectId), p = homeOf(me);  // desk mates share the cubicle's list
        const td = p?.todos.find(x => x.id === id);
        if (!td) return text('No to-do with that id.');
        if (String(t || '').trim()) td.text = String(t).trim().slice(0, 300);
        if (owner) td.owner = owner;
        changed(p);
        return text('Updated: ' + td.text);
      }),
      tool('remove_todo', 'Remove a to-do from the board only if it is a duplicate, no longer relevant, or was already done elsewhere. Always tell the boss in your reply what you removed and why.', {
        id: z.string().describe('The to-do id shown in brackets by get_boss_todos'),
        reason: z.string().describe('Plain English: why it can go'),
      }, async ({ id, reason }) => {
        const me = find(projectId), p = homeOf(me);  // desk mates share the cubicle's list
        const td = p?.todos.find(x => x.id === id);
        if (!td) return text('No to-do with that id.');
        p.todos = p.todos.filter(x => x.id !== id);
        changed(p);
        return text(`Removed "${td.text}" (${reason}). Mention this to the boss in your reply.`);
      }),
      tool('complete_todo', 'Check off a to-do from the boss once it is actually done.', {
        id: z.string().describe('The to-do id shown in brackets by get_boss_todos'),
      }, async ({ id }) => {
        const me = find(projectId), p = homeOf(me);  // desk mates share the cubicle's list
        const t = p?.todos.find(x => x.id === id);
        if (!t) return text('No to-do with that id.');
        t.done = true;
        t.doneAt = Date.now();
        t.doneSession = me.sessionId; t.doneShift = me.day;   // the chat it was finished in
        if (me !== p) { t.doneBy = me.workerId; t.doneFolder = me.folder; }
        changed(p);
        return text('Checked off: ' + t.text);
      }),
    ],
  });
}

function deskMatePrompt(p) {
  const home = p.deskOf && find(p.deskOf);
  if (!home) return '';
  const main = workerName(home);
  if (p.shared) return `- You are a desk mate: ${main} is the main critter on this project, and you share the same project folder, so ${main} may be editing files at the same time. ` +
    `Re-read a file right before you change it, keep to the files your task needs, and tell the boss before changing something ${main} is likely working on.\n`;
  return `- You are a desk mate: ${main} is the main critter on this project and works in the main copy at "${home.folder}". ` +
    `You work in your own copy at "${p.folder}" on the git branch "${p.branch}", so you never overwrite each other. Stay in your own copy. ` +
    `Commit your work to your branch as you finish each piece (small, clearly described commits). ` +
    `The boss brings your work into the main copy with a button, so don't merge it yourself unless the boss asks. ` +
    `Your copy started from the main copy's last commit, so it may not have ${main}'s newest unsaved work.\n`;
}

function officePrompt(p) {
  const w = findWorker(p.workerId);
  return `\n\n# Agent Office\nYou are ${w?.name || 'the worker'}${w ? ` (a little ${w.animal})` : ''}, assigned to the "${p.name}" project in the boss's Agent Office dashboard. ` +
    (ownerName() ? `The boss's name is ${ownerName()}. ` : '') +
    `Each chat is one "shift" at your cubicle; this is Shift ${p.day}.\n` + deskMatePrompt(p) +
    `- Folders under .claude/worktrees belong to desk mates (other critters' copies of this project): leave them alone.\n` +
    `- At the start of a new day, call mcp__office__get_boss_todos to see what the boss assigned you.\n` +
    `- Keep your cubicle current with mcp__office__update_cubicle: set "task" once you know today's task, move "stage" when the project moves, ` +
    `set status "blocked" if you are stuck, and put where you left off in "note" before you finish a chunk of work. ` +
    `Never end your own day: only the boss clocks you out. ` +
    `If your reply asks the boss a question or needs a decision, set status "needs" right before you reply; otherwise leave status alone when you finish.\n` +
    `- Write "task" and "note" for the boss in plain, friendly English that someone who isn't a developer understands: one short sentence, ` +
    `no file names, class names, code, commands or arrows. Say what it means for the project, for example "Tidying up the website header and fonts" ` +
    `rather than "hdr-logo tidy → Meaty .woff2".\n` +
    `- Call mcp__office__complete_todo when you finish one of the boss's to-dos. You can also keep the list tidy: ` +
    `add_todo for follow-up work, edit_todo to reword or sort, and remove_todo only for duplicates or things no longer needed (always say what you removed). ` +
    `Every to-do has an owner: critter (yours), boss (only the boss can do it, e.g. photos, phone checks, decisions), or together. Only work on critter and together ones.\n` +
    `- If a task needs something only the Claude desktop app has (the design canvas / Claude Design, the browser pane, the iOS Simulator view), ` +
    `do not say you can't: call mcp__office__open_in_desktop_app, and the chat moves there with you.\n` +
    `- The boss approves risky actions in a pop-up, so just attempt the action; do not ask for permission in chat first.\n` +
    `- Guardrails: you never delete core Mac system files. Anything touching Mac system files or settings, passwords or keys, the Agent Office itself, ` +
    `admin (sudo) commands, files outside this project, deleting folders, pushing code, or installing software goes to the boss for approval first.\n` +
    `- Anything you make for the boss to look at (previews, exports, screenshots, files to upload) goes in a folder named "${forFolder()}" ` +
    `inside this project's folder (create it if needed). Never put files on the Desktop or anywhere outside the project folder.` +
    personalityPrompt(w);
}

// The critter's personality in chat replies. The work itself (code, files, facts) stays exactly the same.
function personalityPrompt(w) {
  if (!w || w.personality === 'plain' || !w.voice) return '';
  const full = w.personality === 'full';
  const amount = full
    ? `Play ${w.name} fully, like a much-loved character in a cosy animated film. Nobody should be able to mistake your reply for anyone else's:\n` +
      `- Open with a short in-character reaction to the moment (delight, a grumble, a worry, pride: whatever ${w.name} would feel), and sign off in character.\n` +
      `- Have feelings and opinions about the work and say them your way: what you love, what bugs you, what you'd pick and why.\n` +
      `- Bring in your little life: one or two small asides per reply (your habits, your home, your favourite things).\n` +
      `- Talk to the boss like a colleague you're fond of, with your own attitude, not a generic assistant's.\n` +
      `- Your voice runs through every paragraph, not just the edges.`
    : `Let ${w.name}'s personality come through clearly, just lighter:\n` +
      `- A short in-character reaction to open or close the reply.\n` +
      `- Your attitude shows in how you describe the work (what pleases or bothers you), and in your word choice throughout.\n` +
      `- At most one small aside about your life or habits.`;
  return `\n\n# Your personality (chat replies only)\nYou are ${w.name} the ${w.animal}. Who you are: ${w.voice}\n` +
    (w.style ? `How you talk: ${w.style}\n` : '') +
    `${amount}\n` +
    `The boss asked for MORE personality, not more catchphrases: show character through reactions, opinions and feelings, ` +
    `and don't repeat the same word, sound or joke in every sentence.\n` +
    `Keep the facts plain: every fact, step, number, file name and instruction stays exactly as clear and precise as it would be without the personality, ` +
    `and organise information the way you normally would (same lists, headings and level of detail).\n` +
    `If formatting rules such as "i-have-adhd" are also loaded, keep their structure rules for the content (numbered steps, short lists, one clear next action), ` +
    `but your personality overrides their tone rules: a one-line in-character opener before the action, an in-character sign-off, reactions, ` +
    `playful phrasing and figurative language are all wanted here.\n` +
    `Use the personality only in chat replies to the boss: never in code, code comments, files you write, commit messages, cubicle task or note text, to-dos, or tool input.`;
}

const sdkMode = p => p.permissionMode === 'auto' ? 'auto' : p.permissionMode === 'acceptEdits' || p.permissionMode === 'free' ? 'acceptEdits' : 'default';
function startWorker(p, { mode } = {}) {
  const queue = makeQueue();
  const w = { queue, active: false, workerSetStatus: false, q: null, startedAt: Date.now() };
  const q = query({
    prompt: queue.iterable,
    options: {
      cwd: p.folder,
      resume: p.sessionId || undefined,
      pathToClaudeCodeExecutable: CLAUDE_BIN,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: officePrompt(p) },
      mcpServers: { office: officeTools(p.id) },
      disallowedTools: ['AskUserQuestion'],
      canUseTool: (name, input, opts) => askBoss(p.id, name, input, opts),
      hooks: { PreToolUse: [{ hooks: [guardHook(p.id)] }] },
      permissionMode: mode || sdkMode(p),
      effort: p.effort || undefined,
      enableFileCheckpointing: true,   // so the boss can undo file changes
      additionalDirectories: loose(p) ? [...TEMP_DIRS, memoryDir(p)].filter(d => isDir(d)) : undefined,
      model: p.model || undefined,
      // "Free in the project folder": commands run inside Claude Code's sandbox, which only lets them
      // change files in this folder (and temp files). Those run without asking; anything that needs
      // to reach outside the sandbox still comes to the boss for approval.
      sandbox: p.permissionMode === 'free' ? {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: true,
        network: { allowLocalBinding: true, allowedDomains: freeDomains() },
        filesystem: { allowWrite: [memoryDir(p)] },
      } : undefined,
      extraArgs: p.useChrome ? { chrome: null } : {},
      env: WORKER_ENV,
      stderr: d => { if (/error/i.test(d)) console.error(`[${workerName(p)}]`, d.trim()); },
    },
  });
  w.q = q;
  workers.set(p.id, w);

  (async () => {
    try {
      for await (const m of q) handleMessage(p.id, w, m);
    } catch (e) {
      broadcast({ type: 'chat', id: p.id, items: [{ kind: 'system', text: 'Worker stopped: ' + e.message }] });
    } finally {
      if (workers.get(p.id) === w) workers.delete(p.id);
      if (find(p.id)?.helpers?.length) setHelpers(find(p.id), w, []);
      // A wrap-up that never finished: let the boss try again or skip it.
      const cur = find(p.id);
      if (cur?.wrapping) changed(cur, { wrapping: false });
      for (const [reqId, item] of pending) if (item.req.projectId === p.id) answer(reqId, 'deny', 'Worker stopped.');
      broadcast({ type: 'busy', id: p.id, busy: false });
    }
  })();
  return w;
}

// Helpers a critter sent off in the background (sub-agents). While any are out,
// the critter is "Leading a team" rather than on a break.
function setHelpers(p, w, list) {
  const f = { helpers: list };
  if (list.length) f.status = 'crew';
  else if (p.status === 'crew') f.status = w.active ? 'working' : 'break';
  changed(p, f);
  if (!list.length) setTimeout(restartWhenIdle, 500);
}
function trackHelpers(p, w, m) {
  if (m.type !== 'system') return false;
  const cur = p.helpers || [];
  if (m.subtype === 'background_tasks_changed') {
    setHelpers(p, w, (m.tasks || []).filter(t => !t.ambient).map(t => ({ id: t.task_id, description: t.description })));
  } else if (m.subtype === 'task_started' && m.is_backgrounded && !m.ambient && !cur.some(h => h.id === m.task_id)) {
    setHelpers(p, w, [...cur, { id: m.task_id, description: m.description }]);
  } else if (m.subtype === 'task_notification' || (m.subtype === 'task_updated' && ['completed', 'failed', 'killed'].includes(m.patch?.status))) {
    if (cur.some(h => h.id === m.task_id)) setHelpers(p, w, cur.filter(h => h.id !== m.task_id));
  } else return false;
  return true;
}

function handleMessage(id, w, m) {
  const p = find(id);
  if (!p) return;
  if (trackHelpers(p, w, m)) return;
  if (m.type === 'rate_limit_event') return notePlanLimit(m.rate_limit_info);
  if (m.session_id && p.sessionId !== m.session_id) changed(p, { sessionId: m.session_id });
  if (m.type === 'result') {
    // Claude Code may fold messages sent mid-task into the same job, so trust its own count
    // of jobs still queued rather than counting messages we sent.
    w.active = (m.queued_turn_count || 0) > 0;
    const items = [{ kind: 'done', cost: m.total_cost_usd, error: m.is_error ? String(m.result || m.subtype) : null }];
    broadcast({ type: 'chat', id, items });
    if (m.is_error && LOGIN_ERROR.test(items[0].error)) noteLoginError(p, w);
    if (!w.active && w.handoffAfterTurn) {
      broadcast({ type: 'busy', id, busy: false });
      setTimeout(() => {
        stopWorker(id);
        openInDesktop(p.sessionId);
        changed(p, { inDesktop: true, desktopDone: false, status: 'away', unread: true, desktopSince: Date.now() });
        broadcast({ type: 'toast', text: `${workerName(p)} moved to the Claude desktop app for ${p.handoff?.need || 'a desktop-only tool'}. Type "go" there.` });
        setTimeout(restartWhenIdle, 500);
      }, 300);
      return;
    }
    if (!w.active) {
      broadcast({ type: 'busy', id, busy: false });
      setTimeout(restartWhenIdle, 500);
      if (w.restartAfterTurn) setTimeout(() => stopWorker(id), 0);
      const f = { unread: true };
      // Finished with nothing new to do: snack break. "Needs you" only when they asked for something.
      f.status = w.workerSetStatus === 'needs' || w.workerSetStatus === 'blocked' || w.loginFailed ? w.workerSetStatus || 'needs' : 'break';
      if (p.helpers?.length && f.status === 'break') f.status = 'crew';
      if (p.wrapping) return setTimeout(() => startNewDay(p, w.lastReply || ''), 0);
      changed(p, f);
    }
    return;
  }
  const items = normalize(m, { live: true });
  notePreview(p, items);
  if (items.length && !w.active) { w.active = true; broadcast({ type: 'busy', id, busy: true }); }
  if (items.length) broadcast({ type: 'chat', id, items });
  for (const x of items) if (x.kind === 'assistant') w.lastReply = x.text;
}

setInterval(() => {
  for (const p of office.projects) {
    if (!p.closed && p.status === 'break' && !workers.get(p.id)?.active && Date.now() - (p.statusAt || p.updatedAt) > NAP_AFTER) {
      changed(p, { status: 'out' });
    }
  }
}, 60 * 1000);

/* ---------------- Usage ---------------- */
// Plan limits, from two places: Claude's own rate-limit updates that arrive while critters work
// (these include reset times), and the desktop app's usage samples (updated while it runs).
const planLimits = {}; // rateLimitType -> { pct, resetsAt, status, at }
const PLAN_FILE = path.join(HOME, 'Library', 'Application Support', 'Claude', 'plan-usage-history.json');

function notePlanLimit(info) {
  if (!info?.rateLimitType) return;
  let pct = info.utilization;
  if (typeof pct === 'number' && pct <= 1.5) pct = pct * 100;
  let resetsAt = info.resetsAt;
  if (resetsAt && resetsAt < 1e12) resetsAt *= 1000;
  planLimits[info.rateLimitType] = { pct: typeof pct === 'number' ? Math.round(pct) : null, resetsAt: resetsAt || null, status: info.status, at: Date.now() };
}

function planUsage() {
  let sample = null;
  try {
    const d = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
    sample = (d.samples || []).at(-1) || null;
  } catch {}
  const pick = (type, key) => {
    const ev = planLimits[type];
    const fromApp = sample?.u?.[key];
    const useEvent = ev && ev.pct != null && (!sample || ev.at >= sample.t);
    return {
      pct: useEvent ? ev.pct : (typeof fromApp === 'number' ? fromApp : ev?.pct ?? null),
      resetsAt: ev?.resetsAt && ev.resetsAt > Date.now() ? ev.resetsAt : null,
      at: useEvent ? ev.at : sample?.t || ev?.at || null,
      status: ev?.status || null,
    };
  };
  const out = { fiveHour: pick('five_hour', 'fh'), week: pick('seven_day', 'sd') };
  for (const [type, label] of [['seven_day_opus', 'weekOpus'], ['seven_day_sonnet', 'weekSonnet']]) {
    if (planLimits[type]?.pct != null) out[label] = pick(type, '');
  }
  return out;
}

// Token totals per chat, read from Claude Code's own chat files (cached until a file changes).
const sessionCache = new Map(); // sessionId -> { file, mtime, turns: [{ t, tokens, output }] }
const fileOf = new Map();
function sessionFile(sessionId) {
  const known = fileOf.get(sessionId);
  if (known && fs.existsSync(known)) return known;
  const found = findSessionFile(sessionId);
  if (found) fileOf.set(sessionId, found);
  return found;
}
function findSessionFile(sessionId) {
  const root = path.join(HOME, '.claude', 'projects');
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, sessionId + '.jsonl');
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return null;
}
function sessionTurns(sessionId) {
  if (!sessionId) return [];
  const hit = sessionCache.get(sessionId);
  const file = hit?.file || sessionFile(sessionId);
  if (!file) return [];
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return []; }
  if (hit && hit.mtime === mtime) return hit.turns;
  const seen = new Set(), turns = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"usage"')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const m = d.message;
    if (d.type !== 'assistant' || !m?.usage || seen.has(m.id)) continue;
    seen.add(m.id);
    const u = m.usage;
    const tokens = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    turns.push({ t: Date.parse(d.timestamp) || 0, tokens, output: u.output_tokens || 0, fresh: (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0),
      context: tokens - (u.output_tokens || 0) });  // how much chat the model re-read for this reply
  }
  sessionCache.set(sessionId, { file, mtime, turns });
  return turns;
}

function usageReport() {
  const now = Date.now(), H5 = now - 5 * 3600e3, W = now - 7 * 86400e3;
  const projects = office.projects.map(p => {
    const sum = (list, since = 0) => list.reduce((a, x) => x.t >= since ? { tokens: a.tokens + x.tokens, fresh: a.fresh + x.fresh, replies: a.replies + 1 } : a, { tokens: 0, fresh: 0, replies: 0 });
    const today = sessionTurns(p.sessionId);
    const all = [...today, ...p.history.flatMap(h => sessionTurns(h.sessionId))];
    // context: the size of this shift's chat right now. Every message re-sends it, so it's what makes a long shift pricey.
    return { id: p.id, today: sum(today), fiveHour: sum(all, H5), week: sum(all, W), total: sum(all), context: today.at(-1)?.context || 0 };
  });
  return { plan: planUsage(), projects, at: now };
}

// While a chat is in the desktop app, watch its file. Once the desktop has replied and gone
// quiet for a minute, flag the cubicle so the boss can pick it up in the office.
const desktopWatch = new Map(); // projectId -> { mtime, changedAt }
function lastEntryIsReply(file) {
  try {
    const tail = fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-40).reverse();
    for (const line of tail) {
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (d.type === 'assistant') return (d.message?.content || []).some(b => b.type === 'text' && b.text.trim()) &&
        !(d.message?.content || []).some(b => b.type === 'tool_use');
      if (d.type === 'user' && !d.isMeta) return false;
    }
  } catch {}
  return false;
}
setInterval(() => {
  for (const p of office.projects) {
    if (!p.inDesktop || p.desktopDone || !p.sessionId) { desktopWatch.delete(p.id); continue; }
    const file = sessionFile(p.sessionId);
    if (!file) continue;
    let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
    const seen = desktopWatch.get(p.id);
    if (!seen || seen.mtime !== mtime) { desktopWatch.set(p.id, { mtime, changedAt: Date.now() }); continue; }
    const active = mtime > (p.desktopSince || 0) + 5000;
    if (active && Date.now() - seen.changedAt > 60000 && lastEntryIsReply(file)) {
      changed(p, { desktopDone: true, status: 'needs', unread: true });
      broadcast({ type: 'toast', text: `${workerName(p)} finished in the desktop app. Reply in the office whenever you're ready.` });
    }
  }
}, 20000);

/* ---------------- Office version and updates (git) ---------------- */
// The office updates itself when it's a git download with a remote: fetch, fast-forward, npm ci if needed, restart.
const SEP = '\x1f';
async function officeVersion() {
  const top = await git(DIR, ['rev-parse', '--show-toplevel']);
  if (!top.ok || fs.realpathSync(top.out) !== fs.realpathSync(DIR)) return { git: false, reason: 'not-git' };
  const head = (await git(DIR, ['log', '-1', `--format=%h${SEP}%cI${SEP}%s`])).out.split(SEP);
  const commit = head[0] ? { id: head[0], date: head[1], message: head[2] } : null;
  const upstream = await git(DIR, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream.ok) return { git: true, commit, reason: 'no-remote' };
  return { git: true, commit, upstream: upstream.out };
}
async function newCommits() {
  const list = await git(DIR, ['log', '--max-count=10', `--format=%h${SEP}%s`, 'HEAD..@{u}']);
  const count = +(await git(DIR, ['rev-list', '--count', 'HEAD..@{u}'])).out || 0;
  return { count, commits: list.out.split('\n').filter(Boolean).map(l => { const [id, message] = l.split(SEP); return { id, message }; }) };
}
// npm ci installs exactly what package-lock.json lists and never rewrites it, so updating leaves no local changes behind.
const npmCi = () => new Promise(resolve => execFile('npm', ['ci', '--no-audit', '--no-fund'], { cwd: DIR, timeout: 300000, maxBuffer: 8 << 20 },
  (err, out, errOut) => resolve({ ok: !err, err: String(errOut || err?.message || '').trim() })));

let restartPending = false;
function restartWhenIdle() {
  if (!restartPending) return;
  if ([...workers.values()].some(w => w.active) || pending.size || office.projects.some(p => p.helpers?.length)) return;
  restartPending = false;
  console.log('Restarting the office…');
  for (const res of clients) res.end();
  server.close(() => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: DIR, env: process.env, detached: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.unref();
    process.exit(0);
  });
  server.closeAllConnections?.();
}

function stopWorker(id) {
  const w = workers.get(id);
  if (!w) return;
  workers.delete(id);
  w.queue.close();
  try { w.q.close(); } catch {}
  for (const [reqId, item] of pending) if (item.req.projectId === id) answer(reqId, 'deny', 'Worker stopped.');
  broadcast({ type: 'busy', id, busy: false });
}

/* ---------------- Claude sign-in ---------------- */
// When Claude's login runs out, every critter fails with "Not logged in". A claude process reads the
// login once, when it starts, so after the boss signs in again any worker started before that needs
// a fresh start. Their chats carry on: the next message resumes the same session in a new process.
const LOGIN_ERROR = /not logged in|please run \/login|invalid api key|oauth token (has )?expired/i;
const OFFICE_STARTED = Date.now();
const login = { needed: false, ids: new Set() };  // the cubicles that hit the login error
const loginState = () => ({ needed: login.needed, ids: [...login.ids] });
const clock = t => new Date(t).toLocaleString('en-GB', { hour12: false });

function noteLoginError(p, w) {
  w.loginFailed = true;
  w.restartAfterTurn = true;  // this process will never see a new login
  login.needed = true;
  login.ids.add(p.id);
  console.log(`[${clock(Date.now())}] Not signed in: ${workerName(p)} (${p.name}). Its claude started ${clock(w.startedAt)}; ` +
    `the office started ${clock(OFFICE_STARTED)} (pid ${process.pid}).`);
  broadcast({ type: 'needsLogin', id: p.id });
}

// Run claude from this office, with the workers' environment. On one Mac the login worked from Terminal
// but not from a long-running office, so a check made anywhere else could wrongly say "signed in".
function runClaude(args) {
  return new Promise(resolve => {
    const child = execFile(CLAUDE_BIN, args, { env: WORKER_ENV, cwd: os.tmpdir(), timeout: 30000, maxBuffer: 1 << 20 },
      (err, out, errOut) => resolve({ err, out: String(out || ''), text: `${out}\n${errOut}\n${err?.message || ''}` }));
    child.stdin?.end();
  });
}
async function checkLogin() {
  if (!CLAUDE_BIN) return false;
  const r = await runClaude(['auth', 'status', '--json']);
  let s = null; try { s = JSON.parse(r.out); } catch {}
  if (typeof s?.loggedIn === 'boolean') return s.loggedIn;
  // An older claude without "auth status": ask it something tiny instead.
  const t = await runClaude(['-p', 'ok', '--max-turns', '1', '--output-format', 'json']);
  return !LOGIN_ERROR.test(t.text);
}

// After a sign-in: give a fresh start to every worker that hit the login error, and to any idle one
// (its claude started before the sign-in finished). Busy ones, or ones waiting on the boss or helpers, carry on.
function freshStartWorkers(signedInAt) {
  let n = 0;
  for (const [id, w] of [...workers]) {
    const p = find(id);
    const held = w.active || p?.helpers?.length || p?.wrapping || [...pending.values()].some(x => x.req.projectId === id);
    if (held) { if (w.loginFailed) w.restartAfterTurn = true; continue; }
    if (w.loginFailed || w.startedAt < signedInAt) { stopWorker(id); n++; }
  }
  return n;
}

function openSignIn() {
  // Terminal starts its own clean shell, so none of the desktop app's variables can leak into the login.
  const sh = `'${String(CLAUDE_BIN || 'claude').replace(/'/g, `'\\''`)}' /login`;
  const script = `tell application "Terminal" to do script "${sh.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return new Promise(resolve => execFile('osascript', ['-e', 'tell application "Terminal" to activate', '-e', script], { timeout: 20000 },
    (err, out, errOut) => resolve({ ok: !err, err: String(errOut || err?.message || '').trim() })));
}

// Photos and files from the boss: each one is saved into the project's "From <name>" folder (so the
// critter can use the file itself). Photos are also sent along so the critter can see them, and so are
// PDFs up to 10 MB; for anything else the critter reads the saved file.
const MAX_PHOTOS = 10;
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic' };
const b64 = x => typeof x === 'string' && /^[A-Za-z0-9+/=]+$/.test(x) ? x : null;
async function saveAttachments(p, list) {
  if (!list.length) return [];
  const dir = path.join(p.folder, fromFolder());
  await fsp.mkdir(dir, { recursive: true });
  const d = new Date(), two = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}`;  // local time
  const clean = (name, i) => String(name || `file ${i + 1}`).replace(/[\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || `file ${i + 1}`;
  const unique = (base, ext) => { let f = path.join(dir, `${stamp} ${base}${ext}`), n = 2; while (fs.existsSync(f)) f = path.join(dir, `${stamp} ${base} ${n++}${ext}`); return f; };
  const out = [];
  for (const [i, ph] of list.entries()) {
    if (ph?.kind === 'file') {
      const data = b64(ph.data);
      if (!data) throw new Error(`Couldn't read ${ph?.name || 'one of the files'}.`);
      if (data.length > 41e6) throw new Error(`${ph.name} is too big. Files can be up to 30 MB.`);
      const name = clean(ph.name, i), ext = path.extname(name);
      const file = unique(ext ? name.slice(0, -ext.length) : name, ext);
      await fsp.writeFile(file, Buffer.from(data, 'base64'));
      const pdf = (ph.type === 'application/pdf' || /\.pdf$/i.test(name)) && data.length <= 13.5e6 ? data : null;
      out.push({ file, rel: path.relative(p.folder, file), name: path.basename(file), pdf });
      continue;
    }
    const view = b64(ph?.view), full = b64(ph?.full) || view;
    const viewType = ph?.viewType, fullType = ph?.fullType || viewType;
    if (!view || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(viewType)) throw new Error('One of the photos could not be read.');
    if (view.length > 6.5e6) throw new Error('One of the photos is too big to send. Try a smaller one.');
    const file = unique(clean(ph.name, i).replace(/\.[^.]+$/, ''), '.' + (PHOTO_TYPES[fullType] || 'jpg'));
    await fsp.writeFile(file, Buffer.from(full, 'base64'));
    out.push({ file, rel: path.relative(p.folder, file), view, viewType });
  }
  return out;
}

const voiceNudgeFor = cw => cw && cw.personality !== 'plain' && cw.style
  ? [{ type: 'text', text: `<system-reminder>Reply as ${cw.name}, ${cw.personality === 'full' ? 'fully in character' : 'with your personality clearly showing'}: ` +
      `react, have opinions and feelings, and sound like yourself. ${cw.style} ` +
      `Formatting rules only shape how the facts are organised; they don't flatten your personality.</system-reminder>` }]
  : [];

// opts.plan: work in plan mode for this message (look and plan, change nothing until the boss approves).
function sendMessage(p, text, files = [], opts = {}) {
  let w = workers.get(p.id);
  if (!w) w = startWorker(p, opts.plan ? { mode: 'plan' } : {});
  else if (opts.plan) w.q.setPermissionMode('plan').catch(() => {});
  if (opts.plan) changed(p, { planning: true });
  else if (p.planning) { w.q.setPermissionMode(sdkMode(p)).catch(() => {}); changed(p, { planning: false }); }
  w.active = true;
  w.workerSetStatus = '';
  w.lastReply = '';
  const uuid = crypto.randomUUID();  // lets the boss undo file changes back to this message
  // A slash command (/compact, a skill…) goes through as typed.
  const slash = /^\/[\w:.-]+/.test(text || '') && !files.length;
  let content;
  if (slash) content = text;
  else {
    const note = files.length ? `\n\n${FILE_NOTE} ${files.map(x => `"${x.rel}"`).join(', ')})` : '';
    const images = files.filter(x => x.view).map(x => ({ type: 'image', source: { type: 'base64', media_type: x.viewType, data: x.view } }));
    const pdfs = files.filter(x => x.pdf).map(x => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: x.pdf }, title: x.name }));
    const undoNote = p.undoNote ? [{ type: 'text', text: `<system-reminder>${p.undoNote}</system-reminder>` }] : [];
    const planNote = opts.plan ? [{ type: 'text', text: '<system-reminder>The boss pressed "Plan First": look around without changing anything, ' +
      'then call the ExitPlanMode tool with your plan. The boss reads it in the office and approves it (or asks for changes) there, so do not ask for approval in chat.</system-reminder>' }] : [];
    content = [{ type: 'text', text: (text || (files.some(x => x.view) ? '(photo)' : '(file)')) + note }, ...images, ...pdfs, ...undoNote, ...planNote, ...voiceNudgeFor(findWorker(p.workerId))];
  }
  if (p.undoNote) p.undoNote = null;
  w.queue.push({ type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null });
  broadcast({ type: 'chat', id: p.id, items: [{ kind: 'user', uuid, text, images: files.filter(x => x.view).map(x => `data:${x.viewType};base64,${x.view}`), files: files.filter(x => !x.view).map(x => x.name) }] });
  broadcast({ type: 'busy', id: p.id, busy: true });
  changed(p, { status: 'working', inDesktop: false, desktopDone: false, handoff: null });
}

/* ---------------- Live preview ---------------- */
// When a critter starts the app (a dev server), its localhost address shows up in the chat.
// The cubicle gets an Open Preview button while that address answers.
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(?:\/[^\s'"`<>)\]]*)?/g;
function quietly(p, f) { Object.assign(p, f); save(); broadcast({ type: 'project', project: p }); }  // no "last active" bump
function notePreview(p, items) {
  let url = null;
  for (const x of items) {
    const t = x.kind === 'assistant' || x.kind === 'result' ? x.text : x.kind === 'tool' && x.name === 'Bash' ? x.input?.command : '';
    for (const m of String(t || '').matchAll(LOCAL_URL)) if (+m[1] !== PORT) url = m[0].replace('0.0.0.0', 'localhost').replace(/[.,;:!]+$/, '');
  }
  if (url && p.preview?.url !== url) { quietly(p, { preview: { url, at: Date.now() } }); setTimeout(() => checkPreview(p), 1500); }
}
function checkPreview(p) {
  if (!p.preview?.url) return;
  const r = http.get(p.preview.url, { timeout: 2000 }, res => { res.resume(); if (p.previewLive !== true) quietly(p, { previewLive: true }); });
  r.on('timeout', () => r.destroy(new Error('timeout')));
  r.on('error', () => { if (p.previewLive !== false) quietly(p, { previewLive: false }); });
}
setInterval(() => { for (const p of office.projects) if (!p.closed && p.preview) checkPreview(p); }, 20000);

/* ---------------- Save & publish (git) ---------------- */
const GH = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', ...(process.env.PATH || '').split(':').map(d => path.join(d, 'gh'))].find(f => fs.existsSync(f));
const gitNet = (cwd, args) => new Promise(resolve => execFile('git', ['-C', cwd, ...args],
  { timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 4 << 20 },
  (err, out, errOut) => resolve({ ok: !err, out: String(out || '').trim(), err: String(errOut || err?.message || '').trim() })));
async function gitInfo(folder) {
  const branch = (await git(folder, ['symbolic-ref', '--short', 'HEAD'])).out || null;
  const remotes = (await git(folder, ['remote'])).out.split('\n').filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0] || null;
  const up = await git(folder, ['rev-parse', '--abbrev-ref', '@{u}']);
  const upstream = up.ok ? up.out : null;
  const ahead = remote ? Number((await git(folder, upstream ? ['rev-list', '--count', '@{u}..HEAD'] : ['rev-list', '--count', 'HEAD', '--not', '--remotes'])).out) || 0 : 0;
  const head = remote && (await git(folder, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`])).out;
  const defaultBranch = head ? head.replace(`${remote}/`, '') : ['main', 'master'].find(b => b === branch) || 'main';
  return { branch, remote, upstream, ahead, defaultBranch, gh: !!GH };
}
async function publish(folder) {
  const info = await gitInfo(folder);
  if (!info.remote) return { error: "This project isn't on GitHub yet." };
  if (!info.branch) return { error: "The project isn't on a branch right now, so there's nothing to publish." };
  const r = await gitNet(folder, info.upstream ? ['push'] : ['push', '-u', info.remote, info.branch]);
  if (!r.ok) return { error: /could not read Username|Authentication|Permission denied|terminal prompts disabled/i.test(r.err)
    ? "GitHub didn't accept the login. Ask a critter to check the GitHub login (gh auth status), then try again." : firstLine(r.err) };
  return { ok: true, branch: info.branch };
}

/* ---------------- Recurring jobs ---------------- */
// A job is a message the office sends to the critter on a schedule ("every weekday at 9:00, check the site").
// The office has to be running (and the Mac awake) at that time; a run missed by more than 2 hours is skipped.
const EVERY = ['day', 'weekday', 'week', 'hour'];
function nextRun(job, from = Date.now()) {
  const [hh, mm] = (job.time || '09:00').split(':').map(Number);
  const n = new Date(from);
  if (job.every === 'hour') { n.setMinutes(mm, 0, 0); if (n.getTime() <= from) n.setHours(n.getHours() + 1); return n.getTime(); }
  n.setHours(hh, mm, 0, 0);
  if (n.getTime() <= from) n.setDate(n.getDate() + 1);
  for (let i = 0; i < 8; i++) {
    const day = n.getDay();
    if (job.every === 'day' || (job.every === 'weekday' && day >= 1 && day <= 5) || (job.every === 'week' && day === job.weekday)) break;
    n.setDate(n.getDate() + 1);
  }
  return n.getTime();
}
function cleanJobs(list, old = []) {
  if (!Array.isArray(list)) throw new Error('Jobs must be a list.');
  return list.slice(0, 20).map(j => {
    const text = String(j?.text || '').trim().slice(0, 2000);
    if (!text) throw new Error('Each job needs something to do.');
    const prev = (old || []).find(o => o.id === j.id);
    const job = {
      id: prev ? prev.id : uid(), text, every: EVERY.includes(j.every) ? j.every : 'day',
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(j.time || '') ? j.time : '09:00',
      weekday: Math.min(6, Math.max(0, Math.round(Number(j.weekday ?? 1)) || 0)), on: j.on !== false,
      lastRun: prev?.lastRun || null, missedAt: prev?.missedAt || null,
    };
    job.nextRun = nextRun(job);
    return job;
  });
}
setInterval(() => {
  const now = Date.now();
  for (const p of office.projects) {
    if (p.closed || !p.jobs?.length) continue;
    let touched = false;
    for (const j of p.jobs) {
      if (!j.on || !j.nextRun || j.nextRun > now) continue;
      const late = now - j.nextRun;
      j.nextRun = nextRun(j, now); touched = true;
      if (late > 2 * 3600e3 || !p.folder || !isDir(p.folder) || !CLAUDE_BIN || p.inDesktop) { j.missedAt = now; continue; }
      j.lastRun = now;
      sendMessage(p, `Recurring job: ${j.text}`);
    }
    if (touched) quietly(p, {});
  }
}, 30000);

/* ---------------- Search ---------------- */
// Look through every chat the office knows about (today's and past shifts, closed projects too).
function searchChats(q) {
  const needle = q.toLowerCase(), results = [];
  const sessions = [];
  for (const p of office.projects) {
    if (p.sessionId) sessions.push({ p, sessionId: p.sessionId, day: p.day, current: true, workerId: p.workerId });
    for (const h of p.history) if (h.sessionId) sessions.push({ p, sessionId: h.sessionId, day: h.day, current: false, workerId: h.workerId || p.workerId });
  }
  for (const s of sessions) {
    const file = sessionFile(s.sessionId);
    if (!file) continue;
    let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!raw.toLowerCase().includes(needle)) continue;
    const hits = [];
    for (const line of raw.split('\n')) {
      if (!line.toLowerCase().includes(needle)) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      if ((d.type !== 'user' && d.type !== 'assistant') || d.isMeta || d.isSidechain) continue;
      const c = d.message?.content;
      for (let t of typeof c === 'string' ? [c] : (c || []).filter(b => b.type === 'text').map(b => b.text)) {
        if (NOISE.test(t)) continue;
        t = splitNote(t).text;
        const i = t.toLowerCase().indexOf(needle);
        if (i < 0) continue;
        const a = Math.max(0, i - 70), z = Math.min(t.length, i + needle.length + 110);
        hits.push({ who: d.type, at: Date.parse(d.timestamp) || 0, snippet: (a ? '…' : '') + t.slice(a, z).replace(/\s+/g, ' ') + (z < t.length ? '…' : '') });
      }
    }
    if (hits.length) results.push({ projectId: s.p.id, sessionId: s.sessionId, day: s.day, current: s.current, workerId: s.workerId,
      count: hits.length, hits: hits.slice(-3), at: Math.max(...hits.map(h => h.at)) });
  }
  return results.sort((a, b) => b.at - a.at).slice(0, 40);
}

/* ---------------- Helpers ---------------- */
async function readChat(sessionId, dir) {
  if (!sessionId) return [];
  try {
    let msgs = await getSessionMessages(sessionId, dir ? { dir } : {}).catch(() => []);
    if (!msgs.length && dir) msgs = await getSessionMessages(sessionId, {});
    return msgs.flatMap(m => normalize(m));
  } catch (e) {
    return [{ kind: 'system', text: 'Could not load this chat: ' + e.message }];
  }
}

function desktopRecordExists(sessionId) {
  try {
    for (const a of fs.readdirSync(DESKTOP_SESSIONS)) {
      for (const b of fs.readdirSync(path.join(DESKTOP_SESSIONS, a))) {
        if (fs.existsSync(path.join(DESKTOP_SESSIONS, a, b, `local_${sessionId}.json`))) return true;
      }
    }
  } catch {}
  return false;
}

function openInDesktop(sessionId) {
  const url = desktopRecordExists(sessionId)
    ? `claude://code/continue?session=local_${sessionId}`
    : `claude://resume?session=${sessionId}`;
  execFile('open', [url]);
}

function gitChanges(folder) {
  return new Promise(resolve => {
    execFile('git', ['-C', folder, 'rev-parse', '--is-inside-work-tree'], err => {
      if (err) return resolve({ notRepo: true });
      execFile('git', ['-C', folder, 'status', '--porcelain'], { maxBuffer: 1 << 20 }, (e1, status) => {
        execFile('git', ['-C', folder, 'diff', 'HEAD', '--no-color'], { maxBuffer: 8 << 20 }, (e2, diff) => {
          if (e2) execFile('git', ['-C', folder, 'diff', '--no-color'], { maxBuffer: 8 << 20 }, (e3, d2) =>
            resolve({ status: status || '', diff: (d2 || '').slice(0, 400000) }));
          else resolve({ status: status || '', diff: (diff || '').slice(0, 400000) });
        });
      });
    });
  });
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/* ---------------- HTTP ---------------- */
const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function body(req, max = 5e6) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > max) throw new Error('too big'); }
  return s ? JSON.parse(s) : {};
}

const server = http.createServer(async (req, res) => {
  // Only answer to this Mac, or to the boss's own Tailscale login coming through "tailscale serve".
  const host = (req.headers.host || '').split(':')[0];
  const local = ['localhost', '127.0.0.1'].includes(host);
  const viaTailscale = !!TS_LOGIN && req.headers['tailscale-user-login'] === TS_LOGIN;
  if (!local && !viaTailscale) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('This office only opens for its owner.');
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  // Other devices (over Tailscale) get the chat-only page; /chat shows it on the Mac too.
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/chat') {
    const page = !local || url.pathname === '/chat' ? 'mobile.html' : 'index.html';
    const html = (await fsp.readFile(path.join(DIR, page), 'utf8')).replace('__OFFICE_TOKEN__', TOKEN);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  if (parts[0] === 'assets') {
    const file = path.normalize(path.join(DIR, decodeURIComponent(url.pathname)));
    if (!file.startsWith(ASSETS + path.sep) || !/\.(png|jpg|webp)$/.test(file) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg', 'Cache-Control': 'max-age=3600' });
    return fs.createReadStream(file).pipe(res);
  }
  if (parts[0] !== 'api') { res.writeHead(404); return res.end(); }
  const token = req.headers['x-office-token'] || url.searchParams.get('token');
  if (token !== TOKEN) return send(res, 401, { error: 'Reload the page.' });

  try {
    const m = req.method;
    const [, a, id, b] = parts;

    // From other devices: read and chat only. No hiring, closing, editing or settings.
    if (!local) {
      const allowed = (m === 'GET' && (a === 'events' || a === 'chat')) ||
        (m === 'POST' && a === 'permissions' && id) ||
        (m === 'POST' && a === 'projects' && id && ['message', 'stop', 'read'].includes(b)) ||
        (m === 'GET' && a === 'projects' && id && b === 'commands');
      if (!allowed) return send(res, 403, { error: 'That only works from the office on your Mac.' });
    }

    if (a === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({
        type: 'hello', office, busy: [...workers.entries()].filter(([, w]) => w.active).map(([k]) => k),
        build: String(fs.statSync(path.join(DIR, 'index.html')).mtimeMs),
        permissions: [...pending.values()].map(x => x.req), guardLog: guardLog.slice(0, 30), moods: moodPics(), login: loginState(),
      })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (a === 'folders' && m === 'GET') {
      let list = [];
      try {
        list = fs.readdirSync(projectsRoot(), { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => path.join(projectsRoot(), d.name));
      } catch {}
      return send(res, 200, { folders: list });
    }
    if (a === 'sessions' && m === 'GET') {
      const dir = url.searchParams.get('dir');
      if (!dir || !isDir(dir)) return send(res, 200, { sessions: [] });
      const s = await listSessions({ dir, limit: 25 });
      return send(res, 200, { sessions: s.map(x => ({ sessionId: x.sessionId, title: x.customTitle || x.summary || x.firstPrompt || 'Untitled', lastModified: x.lastModified })) });
    }
    if (a === 'chat' && m === 'GET') {
      return send(res, 200, { items: await readChat(url.searchParams.get('session'), url.searchParams.get('dir')) });
    }
    if (a === 'usage' && m === 'GET') return send(res, 200, usageReport());
    if (a === 'search' && m === 'GET') {
      const q = String(url.searchParams.get('q') || '').trim();
      return send(res, 200, { results: q.length < 2 ? [] : searchChats(q.slice(0, 100)) });
    }
    if (a === 'version' && !id && m === 'GET') return send(res, 200, await officeVersion());
    if (a === 'version' && (id === 'check' || id === 'update') && m === 'POST') {
      const v = await officeVersion();
      if (!v.git || v.reason) return send(res, 400, { error: v.git ? "This copy isn't connected to GitHub, so there's nowhere to get updates from." : "This copy of the office wasn't downloaded with git, so it can't update itself." });
      const remote = v.upstream.split('/')[0];
      const fetched = await gitNet(DIR, ['fetch', '--quiet', remote]);
      if (!fetched.ok) return send(res, 400, { error: `Couldn't reach GitHub to check for updates: ${firstLine(fetched.err)}` });
      if (id === 'check') return send(res, 200, await newCommits());
      // Update: only when the office's own files are untouched, and only a straight fast-forward.
      // Each line is a status code then the path (the helper trims the first line's leading space, so don't count columns).
      const dirty = (await git(DIR, ['status', '--porcelain', '--untracked-files=no'])).out.split('\n').filter(Boolean).map(l => l.trim().replace(/^\S+\s+/, ''));
      if (dirty.length) return send(res, 400, { error: `The office's own files have changes here (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? '…' : ''}), so updating could overwrite them. Undo or save those changes first.` });
      const { count } = await newCommits();
      if (!count) return send(res, 200, { updated: 0 });
      const before = (await git(DIR, ['rev-parse', 'HEAD'])).out;
      const pulled = await gitNet(DIR, ['pull', '--ff-only', '--quiet']);
      if (!pulled.ok) return send(res, 400, { error: /fast-forward|diverg/i.test(pulled.err)
        ? 'This copy has its own saved versions that GitHub doesn\'t have, so it can\'t update automatically.'
        : `The update didn't go through: ${firstLine(pulled.err)}` });
      const files = (await git(DIR, ['diff', '--name-only', before, 'HEAD'])).out.split('\n').filter(Boolean);
      const npm = files.some(f => f === 'package.json' || f === 'package-lock.json');
      if (npm) {
        const r = await npmCi();
        if (!r.ok) return send(res, 500, { error: `The office updated, but installing its packages failed: ${firstLine(r.err)}. In Terminal, run npm ci in the office folder, then start the office again.` });
      }
      restartPending = true;
      setTimeout(restartWhenIdle, 200);
      return send(res, 200, { updated: count, npm, appChanged: files.some(f => f.startsWith('app/')),
        waiting: [...workers.values()].filter(w => w.active).length });
    }
    // Sign in to Claude: opens Terminal on this Mac running claude /login (never from a phone).
    if (a === 'login' && m === 'POST') {
      if (!CLAUDE_BIN) return send(res, 500, { error: 'Could not find Claude Code on this Mac. Install it, then restart the office.' });
      const r = await openSignIn();
      if (!r.ok) console.error('Could not open Terminal for the sign-in:', r.err);
      return r.ok ? send(res, 200, { ok: true })
        : send(res, 500, { error: `Couldn't open Terminal. Open it yourself and type: ${CLAUDE_BIN} /login` });
    }
    if (a === 'login-status' && m === 'GET') {
      const signedIn = await checkLogin();
      let restarted = 0;
      if (signedIn) {
        if (login.needed || url.searchParams.has('fresh')) restarted = freshStartWorkers(Date.now());
        if (login.needed) { login.needed = false; login.ids.clear(); broadcast({ type: 'loginOk' }); }
      }
      console.log(`[${clock(Date.now())}] Sign-in check: ${signedIn ? 'signed in' : 'NOT signed in'}${restarted ? `, fresh start for ${restarted} critter${restarted === 1 ? '' : 's'}` : ''}.`);
      return send(res, 200, { signedIn, serverStartedAt: OFFICE_STARTED, restarted });
    }
    if (a === 'restart' && m === 'POST') {
      restartPending = true;
      send(res, 200, { ok: true, waiting: [...workers.values()].filter(w => w.active).length });
      return setTimeout(restartWhenIdle, 200);
    }
    if (a === 'settings' && m === 'PUT') {
      const f = await body(req);
      let trusted;
      if ('trustedSites' in f) {
        try { trusted = cleanTrustedSites(f.trustedSites); } catch (e) { return send(res, 400, { error: e.message }); }
      }
      if ('theme' in f && THEMES.includes(f.theme)) office.settings.theme = f.theme;
      if ('name' in f) office.settings.name = String(f.name || '').trim().slice(0, 40);
      if (f.setupDone === true) office.settings.setupDone = true;
      for (const k of ['tourDone', 'cubeTourDone']) if (typeof f[k] === 'boolean') office.settings[k] = f[k];
      if ('projectsRoot' in f) {
        const r = String(f.projectsRoot || '').trim().replace(/\/+$/, '');
        const abs = r.startsWith('~') ? path.join(HOME, r.slice(1)) : r;
        if (r && !path.isAbsolute(abs)) return send(res, 400, { error: 'Type the full path, like ~/Projects.' });
        // The welcome screen makes the folder if it isn't there yet.
        if (r && f.createRoot && !fs.existsSync(abs)) {
          try { fs.mkdirSync(abs, { recursive: true }); } catch (e) { return send(res, 400, { error: `Couldn't make that folder: ${firstLine(e.message)}` }); }
        }
        if (r && !isDir(abs)) return send(res, 400, { error: 'That folder does not exist.' });
        office.settings.projectsRoot = r;
      }
      if (trusted && trusted.join('\n') !== (office.settings.trustedSites || []).join('\n')) {
        office.settings.trustedSites = trusted;
        // The sandbox's site list is set when a critter starts: restart the free ones (busy ones after this reply).
        for (const [id, w] of workers) {
          if (find(id)?.permissionMode !== 'free') continue;
          if (w.active) w.restartAfterTurn = true; else stopWorker(id);
        }
      }
      save();
      broadcast({ type: 'settings', settings: office.settings });
      return send(res, 200, { settings: office.settings });
    }
    if (a === 'stickies' && m === 'PUT') {
      const list = (await body(req)).stickies;
      if (!Array.isArray(list) || list.length > 200) return send(res, 400, { error: 'Bad notes.' });
      const COLORS = ['mustard', 'berry', 'trip', 'team', 'ok', 'accent'];
      office.stickies = list.map(n => ({ id: String(n.id || uid()).slice(0, 20), text: String(n.text || '').slice(0, 4000), color: COLORS.includes(n.color) ? n.color : 'mustard' }));
      save();
      broadcast({ type: 'stickies', stickies: office.stickies });
      return send(res, 200, { ok: true });
    }
    if (a === 'whiteboard' && m === 'PUT') {
      office.whiteboard = String((await body(req)).text ?? '');
      save();
      broadcast({ type: 'whiteboard', text: office.whiteboard });
      return send(res, 200, { ok: true });
    }
    if (a === 'import' && m === 'POST') {
      const data = (await body(req)).office;
      if (!data || !Array.isArray(data.projects)) return send(res, 400, { error: 'No projects in that file.' });
      for (const p of office.projects) stopWorker(p.id);
      office = { whiteboard: data.whiteboard || '', workers: Array.isArray(data.workers) ? data.workers : [], projects: data.projects.map(p => ({ ...newProject(), ...p })) };
      migrate();
      save();
      broadcast({ type: 'hello', office, busy: [], permissions: [...pending.values()].map(x => x.req) });
      return send(res, 200, { ok: true });
    }
    if (a === 'permissions' && id && m === 'POST') {
      const { decision, message } = await body(req);
      return send(res, answer(id, decision, message) ? 200 : 404, { ok: true });
    }
    if (a === 'open-desktop' && m === 'POST') {
      const { sessionId } = await body(req);
      if (!sessionId) return send(res, 400, { error: 'No chat to open.' });
      openInDesktop(sessionId);
      return send(res, 200, { ok: true });
    }

    if (a === 'workers' && id && m === 'PATCH') {
      const w = findWorker(id);
      if (!w) return send(res, 404, { error: 'No such critter.' });
      const f = await body(req);
      if ('name' in f) {
        const name = String(f.name || '').trim().slice(0, 40);
        if (!name) return send(res, 400, { error: 'Give them a name.' });
        w.name = name;
      }
      if ('personality' in f) {
        if (!VOICES.includes(f.personality)) return send(res, 400, { error: 'Unknown personality level.' });
        w.personality = f.personality;
      }
      // Name and personality are part of the critter's instructions: pick them up from the next message.
      const at = office.projects.find(p => !p.closed && p.workerId === w.id);
      const live = at && workers.get(at.id);
      if (live) { if (live.active) live.restartAfterTurn = true; else stopWorker(at.id); }
      save();
      broadcast({ type: 'worker', worker: w });
      return send(res, 200, { worker: w });
    }

    if (a === 'projects') {
      if (!id && m === 'POST') {
        const f = await body(req);
        const w = findWorker(f.workerId);
        if (!w) return send(res, 400, { error: 'Pick a critter to hire.' });
        if (isHired(w.id)) return send(res, 400, { error: `${w.name} already has a cubicle.` });
        let folder = f.folder || '';
        if (f.createFolder) {
          // A fresh folder for the project inside the projects folder (Settings), named after it.
          const safe = String(f.name || '').replace(/[\/:]+/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
          if (!safe) return send(res, 400, { error: 'Give the project a name so the folder has one too.' });
          folder = path.join(projectsRoot(), safe);
          if (fs.existsSync(folder) && fs.readdirSync(folder).some(x => !x.startsWith('.'))) {
            return send(res, 400, { error: `A folder called "${safe}" already exists with files in it. Choose "Use a folder I already have" to work there.` });
          }
          fs.mkdirSync(folder, { recursive: true });
        }
        if (folder && !isDir(folder)) return send(res, 400, { error: 'That folder does not exist.' });
        const p = newProject({ workerId: w.id, name: String(f.name || '').trim() || 'New project', folder });
        office.projects.push(p);
        save();
        broadcast({ type: 'project', project: p });
        return send(res, 200, { project: p });
      }
      if (id === 'practice' && !b && m === 'POST') {
        const w = office.workers.find(x => x.critter === 'forest-fox' && !isHired(x.id)) || office.workers.find(x => !isHired(x.id));
        if (!w) return send(res, 400, { error: "Everyone's at a desk. Close a project to free a critter for the practice café." });
        // A fresh folder: "Practice Café", or "Practice Café 2" and so on if that one already has files.
        let folder, n = 1;
        do folder = path.join(projectsRoot(), `Practice Café${n > 1 ? ' ' + n : ''}`);
        while (n++ < 50 && fs.existsSync(folder) && fs.readdirSync(folder).some(x => !x.startsWith('.')));
        try { fs.mkdirSync(folder, { recursive: true }); } catch (e) { return send(res, 400, { error: `Couldn't make the practice folder: ${firstLine(e.message)}` }); }
        // Ask before everything, so the boss gets to try an approval.
        const p = newProject({ workerId: w.id, name: 'Practice Café', folder, permissionMode: 'default',
          task: 'Practice: make a menu for the office café', practice: {} });
        office.projects.push(p);
        save();
        broadcast({ type: 'project', project: p });
        return send(res, 200, { project: p });
      }
      const p = find(id);
      if (!p) return send(res, 404, { error: 'No such cubicle.' });

      if (!b && m === 'PATCH') {
        const f = await body(req);
        const clean = {};
        for (const k of EDITABLE) if (k in f) clean[k] = f[k];
        if (p.deskOf) { delete clean.name; delete clean.plate; delete clean.folder; }  // those come from the cubicle
        if ('folder' in clean && clean.folder && !isDir(clean.folder)) return send(res, 400, { error: 'That folder does not exist.' });
        if ('model' in clean && !MODELS.includes(clean.model)) return send(res, 400, { error: 'Unknown model.' });
        if ('effort' in clean && !EFFORTS.includes(clean.effort)) return send(res, 400, { error: 'Unknown effort level.' });
        if ('jobs' in clean) { try { clean.jobs = cleanJobs(clean.jobs, p.jobs); } catch (e) { return send(res, 400, { error: e.message }); } }
        if ('permissionMode' in clean && !APPROVALS.includes(clean.permissionMode)) return send(res, 400, { error: 'Unknown approval setting.' });
        const sandboxFlip = 'permissionMode' in clean && (clean.permissionMode === 'free') !== (p.permissionMode === 'free');
        const restart = ('folder' in clean && clean.folder !== p.folder) || ('useChrome' in clean && clean.useChrome !== p.useChrome);
        if ('folder' in clean && clean.folder !== p.folder) clean.sessionId = null;
        changed(p, clean);
        if (!p.deskOf && ('name' in clean || 'plate' in clean)) for (const seat of seatsOf(p)) changed(seat, { name: p.name, plate: p.plate });
        if (restart) stopWorker(p.id);
        else if (sandboxFlip) {
          const w = workers.get(p.id);
          if (w && w.active) w.restartAfterTurn = true; else stopWorker(p.id);
        } else if ('permissionMode' in clean) workers.get(p.id)?.q.setPermissionMode(
          clean.permissionMode === 'auto' ? 'auto' : clean.permissionMode === 'default' ? 'default' : 'acceptEdits').catch(() => {});
        if ('model' in clean) workers.get(p.id)?.q.setModel(clean.model || undefined).catch(() => {});
        if ('effort' in clean) workers.get(p.id)?.q.applyFlagSettings({ effortLevel: clean.effort || null }).catch(() => {});
        return send(res, 200, { project: p });
      }
      if (!b && m === 'DELETE') {
        if ((await body(req)).confirm !== 'DELETE') return send(res, 400, { error: 'Type DELETE to confirm deleting a project.' });
        for (const seat of seatsOf(p)) await sendHome(seat, true).catch(e => console.error(e));
        stopWorker(p.id);
        office.projects = office.projects.filter(x => x.id !== p.id);
        save();
        broadcast({ type: 'deleted', id: p.id });
        return send(res, 200, { ok: true });
      }
      if (b === 'message' && m === 'POST') {
        const { text, photos, plan } = await body(req, 80e6);
        if (p.closed) return send(res, 400, { error: 'This project is closed. Reopen it to keep working.' });
        if (!p.folder || !isDir(p.folder)) return send(res, 400, { error: 'Pick a project folder for this cubicle first.' });
        if (!CLAUDE_BIN) return send(res, 500, { error: 'Could not find the claude command. Install Claude Code, then restart the office.' });
        const list = Array.isArray(photos) ? photos.slice(0, MAX_PHOTOS) : [];
        if (!text?.trim() && !list.length) return send(res, 400, { error: 'Empty message.' });
        let saved;
        try { saved = await saveAttachments(p, list); } catch (e) { return send(res, 400, { error: e.message }); }
        changed(p, { lastMessagedAt: Date.now() });  // for sorting the floor by "Last messaged"
        sendMessage(p, (text || '').trim(), saved, { plan: !!plan });
        practiceTick(p, 'sent');
        return send(res, 200, { ok: true });
      }
      if (b === 'read' && m === 'POST') {
        if (p.unread) changed(p, { unread: false });
        return send(res, 200, { ok: true });
      }
      if (b === 'stop' && m === 'POST') {
        await workers.get(p.id)?.q.interrupt().catch(() => {});
        return send(res, 200, { ok: true });
      }
      if (b === 'new-day' && m === 'POST') {
        const { now } = await body(req);
        practiceTick(p, 'shift');
        // With a chat today, the critter wraps up first; the day flips when they finish.
        if (!now && !p.closed && p.sessionId && p.folder && isDir(p.folder) && CLAUDE_BIN) {
          if (!p.wrapping) { changed(p, { wrapping: true }); sendMessage(p, wrapUp()); }
          return send(res, 200, { wrapping: true });
        }
        startNewDay(p);
        return send(res, 200, { project: p });
      }
      if (b === 'create-folder' && m === 'POST') {
        const safe = String(p.name || '').replace(/[\/:]+/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
        if (!safe) return send(res, 400, { error: 'Give the project a name first.' });
        const folder = path.join(projectsRoot(), safe);
        if (fs.existsSync(folder) && fs.readdirSync(folder).some(x => !x.startsWith('.'))) {
          return send(res, 400, { error: `"${safe}" already exists with files in it. Type its path in the folder box to use it.` });
        }
        fs.mkdirSync(folder, { recursive: true });
        stopWorker(p.id);
        changed(p, { folder, sessionId: null });
        return send(res, 200, { project: p });
      }
      if (b === 'practice-open' && m === 'POST') {
        const file = p.practice && p.folder && path.join(p.folder, 'index.html');
        if (!file || !fs.existsSync(file)) return send(res, 400, { error: `${workerName(p)} hasn't made the menu yet. Send the first message and approve the change.` });
        execFile('open', [file]);
        practiceTick(p, 'looked');
        return send(res, 200, { ok: true });
      }
      if (b === 'open-folder' && m === 'POST') {
        if (!p.folder || !isDir(p.folder)) return send(res, 400, { error: 'This cubicle has no project folder yet.' });
        execFile('open', [p.folder]);
        return send(res, 200, { ok: true });
      }
      if (b === 'close' && m === 'POST') {
        if (p.deskOf) return send(res, 400, { error: 'Send a desk mate home instead.' });
        for (const seat of seatsOf(p)) await sendHome(seat, true).catch(e => console.error(e));
        stopWorker(p.id);
        fileToday(p);
        changed(p, { closed: true, closedAt: Date.now(), status: 'home', task: '', note: '', sessionId: null, unread: false, inDesktop: false, day: p.day + 1 });
        practiceTick(p, 'closed');
        return send(res, 200, { project: p });
      }
      if (b === 'reopen' && m === 'POST') {
        const w = findWorker((await body(req)).workerId);
        if (!w) return send(res, 400, { error: 'Pick a critter to hire.' });
        if (isHired(w.id)) return send(res, 400, { error: `${w.name} already has a cubicle.` });
        changed(p, { closed: false, closedAt: null, workerId: w.id, status: 'out', dayStartedAt: Date.now() });
        return send(res, 200, { project: p });
      }
      if (b === 'attach' && m === 'POST') {
        const { sessionId } = await body(req);
        stopWorker(p.id);
        changed(p, { sessionId: sessionId || null });
        return send(res, 200, { project: p });
      }
      if (b === 'open-desktop' && m === 'POST') {
        if (!p.sessionId) return send(res, 400, { error: 'This cubicle has no chat yet today.' });
        stopWorker(p.id);
        openInDesktop(p.sessionId);
        changed(p, { inDesktop: true, desktopDone: false, status: 'away', desktopSince: Date.now() });
        return send(res, 200, { ok: true });
      }
      if (b === 'changes' && m === 'GET') {
        if (!p.folder || !isDir(p.folder)) return send(res, 200, { noFolder: true });
        const out = await gitChanges(p.folder);
        if (!out.notRepo) out.info = await gitInfo(p.folder);
        if (p.worktree) {
          // What this desk mate has saved that isn't in the main copy yet.
          const target = await mainBranch(p);
          if (target) {
            out.waiting = (await git(p.repo, ['log', '--format=%s', `${target}..${p.branch}`])).out.split('\n').filter(Boolean);
            out.waitingFiles = (await git(p.repo, ['diff', '--name-status', `${target}...${p.branch}`])).out.split('\n').filter(Boolean);
          }
        }
        return send(res, 200, out);
      }
      if (b === 'rewind' && m === 'POST') {
        const { uuid, dryRun, text } = await body(req);
        if (!p.sessionId || !uuid) return send(res, 400, { error: 'Nothing to undo in this chat yet.' });
        let w = workers.get(p.id);
        if (w?.active) return send(res, 400, { error: `${workerName(p)} is working. Press Stop first, then undo.` });
        if (!w) w = startWorker(p);
        let r;
        try {
          r = await w.q.rewindFiles(uuid, { dryRun: true });
          // A real rewind doesn't list the files it put back, so keep the dry run's list.
          if (r.canRewind && !dryRun) r = { ...await w.q.rewindFiles(uuid, { dryRun: false }), filesChanged: r.filesChanged };
        } catch (e) { return send(res, 400, { error: firstLine(e.message) }); }
        if (r.canRewind && !dryRun) {
          const n = r.filesChanged?.length || 0;
          p.undoNote = `The boss pressed Undo: the files you changed were put back the way they were before their message "${String(text || '').slice(0, 120)}". ` +
            `${n} file${n === 1 ? ' was' : 's were'} restored${n ? `: ${r.filesChanged.map(f => path.relative(p.folder, f) || f).slice(0, 15).join(', ')}` : ''}. ` +
            `Work you did after that message is no longer in those files (changes made by commands, not file edits, were not undone). Re-read files before editing them.`;
          save();
          practiceTick(p, 'undo');
          broadcast({ type: 'chat', id: p.id, items: [{ kind: 'system', text: `Undo: ${n} file${n === 1 ? '' : 's'} put back to before "${String(text || '').slice(0, 60)}".` }] });
        }
        return send(res, 200, r);
      }
      if (b === 'commands' && m === 'GET') {
        if (!p.folder || !isDir(p.folder) || !CLAUDE_BIN || p.closed) return send(res, 200, { commands: [] });
        const w = workers.get(p.id) || startWorker(p);
        try {
          const list = await Promise.race([w.q.supportedCommands(), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 20000))]);
          return send(res, 200, { commands: list.map(c => ({ name: c.name, description: c.description || '', hint: c.argumentHint || '' })) });
        } catch { return send(res, 200, { commands: [] }); }
      }
      if (b === 'preview' && m === 'POST') {
        if (!p.preview?.url) return send(res, 400, { error: 'No preview yet.' });
        execFile('open', [p.preview.url]);
        return send(res, 200, { ok: true });
      }
      if (b === 'save' && m === 'POST') {
        const msg = String((await body(req)).message || '').trim().slice(0, 200) || `Saved from the office${p.task ? `: ${p.task}` : ''}`;
        if (!p.folder || !isDir(p.folder)) return send(res, 400, { error: 'No project folder.' });
        await git(p.folder, ['add', '-A']);
        const c = await git(p.folder, ['commit', '-m', msg]);
        if (!c.ok) return send(res, 400, { error: /nothing to commit/i.test(c.out + c.err) ? 'Nothing new to save.' : /user\.(name|email)|identity/i.test(c.err)
          ? 'git needs your name and email first. In Terminal: git config --global user.name "Your Name" and git config --global user.email "you@example.com"' : firstLine(c.err || c.out) });
        return send(res, 200, { ok: true });
      }
      if (b === 'publish' && m === 'POST') {
        if (!p.folder || !isDir(p.folder)) return send(res, 400, { error: 'No project folder.' });
        const r = await publish(p.folder);
        return send(res, r.error ? 400 : 200, r);
      }
      if (b === 'pull-request' && m === 'POST') {
        if (!GH) return send(res, 400, { error: 'Pull requests need the GitHub command (gh). Ask a critter to install and log in to it.' });
        const info = await gitInfo(p.folder);
        if (info.branch === info.defaultBranch) return send(res, 400, { error: `This is the main branch (${info.branch}), so Publish puts it live directly. Pull requests are for side branches, like a desk mate's.` });
        const pushed = await publish(p.folder);
        if (pushed.error) return send(res, 400, pushed);
        const r = await new Promise(resolve => execFile(GH, ['pr', 'create', '--fill', '--head', info.branch, '--base', info.defaultBranch], { cwd: p.folder, timeout: 60000 },
          (err, out, errOut) => resolve({ ok: !err, out: String(out || '').trim(), err: String(errOut || err?.message || '').trim() })));
        const url = (r.out + '\n' + r.err).match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
        if (url) { execFile('open', [url]); return send(res, 200, { ok: true, url, existed: !r.ok }); }
        if (/known GitHub host/i.test(r.err)) return send(res, 400, { error: `Saved and published ${info.branch}, but this project's copy online isn't on GitHub, so there's no pull request to open.` });
        return send(res, 400, { error: firstLine(r.err || r.out) });
      }
      if (b === 'deskmate' && m === 'POST') {
        const f = await body(req);
        const w = findWorker(f.workerId);
        if (p.deskOf || p.closed) return send(res, 400, { error: 'Add desk mates from the main cubicle.' });
        if (!p.folder || !isDir(p.folder)) return send(res, 400, { error: 'Pick a project folder for this cubicle first.' });
        if (!w) return send(res, 400, { error: 'Pick a critter.' });
        if (isHired(w.id)) return send(res, 400, { error: `${w.name} already has a cubicle.` });
        let seat;
        try { seat = await addDeskMate(p, w); } catch (e) { return send(res, 400, { error: e.message }); }
        office.projects.push(seat);
        save();
        broadcast({ type: 'project', project: seat });
        const task = String(f.task || '').trim();
        if (task && CLAUDE_BIN) sendMessage(seat, task);
        return send(res, 200, { project: seat });
      }
      if (b === 'bring-back' && m === 'POST') {
        if (!p.worktree) return send(res, 400, { error: 'This desk mate shares the main folder, so their work is already there.' });
        try { return send(res, 200, await bringBack(p)); } catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (b === 'sort-clash' && m === 'POST') {
        const { files, target } = await body(req);
        if (!p.worktree) return send(res, 400, { error: 'Not a desk mate.' });
        sendMessage(p, `Your work clashes with the main copy in: ${(files || []).join(', ') || 'a few files'}. Please sort it out in your own copy:\n` +
          `1. Run \`git merge ${target || 'main'}\` in your folder to pull in the main copy's latest work.\n` +
          `2. Fix the clashing files so both sets of changes work together.\n` +
          `3. Commit, then tell me it's ready to bring back.`);
        return send(res, 200, { ok: true });
      }
      if (b === 'send-home' && m === 'POST') {
        if (!p.deskOf) return send(res, 400, { error: 'Not a desk mate.' });
        const { force } = await body(req);
        try {
          const r = await sendHome(p, !!force);
          return send(res, r.unmerged || r.error ? 409 : 200, r);
        } catch (e) { return send(res, 400, { error: e.message }); }
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

// The one Tailscale account allowed in from other devices (tailscale serve adds this header).
let TS_LOGIN = process.env.OFFICE_TAILSCALE_LOGIN || '';
if (!TS_LOGIN) {
  const tsBin = ['/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'].find(f => fs.existsSync(f));
  if (tsBin) execFile(tsBin, ['status', '--json'], { timeout: 5000 }, (err, out) => {
    try {
      const d = JSON.parse(out);
      TS_LOGIN = d.User?.[String(d.Self?.UserID)]?.LoginName || '';
      if (TS_LOGIN) console.log(`  Tailscale: open to ${TS_LOGIN} from their other devices.`);
    } catch {}
  });
}

// The Mac app's Restart the Office stops the office this way: end the critters' claude processes and save first.
process.on('SIGTERM', () => {
  console.log(`[${clock(Date.now())}] Stopping the office (pid ${process.pid}).`);
  for (const id of [...workers.keys()]) stopWorker(id);
  try { saveNow(); } catch (e) { console.error(e); }
  setTimeout(() => process.exit(0), 300);
});

let listenTries = 0;
server.on('error', e => {
  if (e.code === 'EADDRINUSE' && listenTries++ < 40) return setTimeout(() => server.listen(PORT, '127.0.0.1'), 250);
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  🏢 Agent Office is open: http://localhost:${PORT}\n`);
  if (!CLAUDE_BIN) console.log('  ⚠ Could not find the claude command on your PATH. Chats will not work until it is installed.\n');
  console.log('  Leave this window open while you use the office. Press Ctrl+C to close it.\n');
});
