// Everything that differs between a Mac, a Windows PC and a Linux computer: where things live,
// how to open a file or a sign-in window, the words the page uses, and each system's guardrails.
// The Mac is the original; Windows and Linux run the same office in a browser (no Mac app).
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { execFile, spawn } from 'node:child_process';

export const OS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
const WIN = OS === 'windows';
// Same as node:path on each system; spelled out so the Windows rules can be tested on a Mac.
const path = WIN ? nodePath.win32 : nodePath.posix;
const HOME = os.homedir();
const env = (k, fallback) => process.env[k] || fallback;
const APPDATA = env('APPDATA', path.join(HOME, 'AppData', 'Roaming'));
const LOCALAPPDATA = env('LOCALAPPDATA', path.join(HOME, 'AppData', 'Local'));
const XDG_CONFIG = env('XDG_CONFIG_HOME', path.join(HOME, '.config'));

/* ---------------- Paths ---------------- */
// Windows paths compare without caring about case or which slash is used.
export const norm = f => WIN ? String(f).replace(/\//g, '\\').toLowerCase() : String(f);
// Is f the folder d, or inside it?
export function within(f, d) {
  if (typeof f !== 'string' || !f || !d) return false;
  const a = norm(f), b = norm(d).replace(/[\\/]+$/, '');
  return a === b || a.startsWith(b + path.sep);
}
// Git Bash on Windows writes C:\Users as /c/Users. Turn that back into a Windows path.
export const fromShell = f => WIN && /^\/[a-zA-Z](\/|$)/.test(f) ? `${f[1].toUpperCase()}:\\${f.slice(3).replace(/\//g, '\\')}` : f;

// Look for a program on the PATH (with .exe on Windows).
export function which(name) {
  const exts = WIN ? ['.exe'] : [''];
  for (const d of env('PATH', '').split(path.delimiter).filter(Boolean)) {
    for (const x of exts) { const f = path.join(d, name + x); if (fs.existsSync(f)) return f; }
  }
  return null;
}
const firstFile = list => list.filter(Boolean).find(f => fs.existsSync(f)) || null;

// The installed claude. On Windows only claude.exe works here (the npm claude.cmd can't be started directly).
export const findClaude = () => process.env.CLAUDE_BIN || which('claude') ||
  firstFile([path.join(HOME, '.local', 'bin', WIN ? 'claude.exe' : 'claude'), path.join(HOME, '.claude', 'local', 'claude')]);
export const findGh = () => firstFile(OS === 'mac' ? ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'] : []) || which('gh') ||
  (WIN ? firstFile([path.join(env('ProgramFiles', 'C:\\Program Files'), 'GitHub CLI', 'gh.exe')]) : null);
export const findTailscale = () => firstFile({
  mac: ['/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'],
  windows: [path.join(env('ProgramFiles', 'C:\\Program Files'), 'Tailscale', 'tailscale.exe')],
  linux: ['/usr/bin/tailscale', '/usr/local/bin/tailscale'],
}[OS]) || which('tailscale');

// The Claude desktop app's own files. There is no Claude desktop app for Linux.
const CLAUDE_APP_DIR = { mac: path.join(HOME, 'Library', 'Application Support', 'Claude'), windows: path.join(APPDATA, 'Claude'), linux: null }[OS];
export const DESKTOP_SESSIONS = CLAUDE_APP_DIR ? path.join(CLAUDE_APP_DIR, 'claude-code-sessions') : null;
export const PLAN_FILE = CLAUDE_APP_DIR ? path.join(CLAUDE_APP_DIR, 'plan-usage-history.json') : null;
export const TEMP_DIRS = (() => {
  const uid = os.userInfo().uid;
  return [...new Set([os.tmpdir(), ...(WIN ? [] : [`/tmp/claude-${uid}`]), ...(OS === 'mac' ? [`/private/tmp/claude-${uid}`] : [])])];
})();

/* ---------------- Opening things ---------------- */
// Open a file, folder or web address with the computer's usual app.
export function openThing(target) {
  const [cmd, args] = { mac: ['open', [target]], windows: ['explorer.exe', [target]], linux: ['xdg-open', [target]] }[OS];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch {}
}

// Open a window running `claude /login`. It starts a clean shell, so none of a desktop session's variables leak in.
const LINUX_TERMINALS = [['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['konsole', ['-e']], ['xfce4-terminal', ['-x']],
  ['mate-terminal', ['-x']], ['tilix', ['-e']], ['kitty', []], ['alacritty', ['-e']], ['wezterm', ['start', '--']], ['xterm', ['-e']]];
export function openSignIn(claudeBin) {
  const bin = String(claudeBin || 'claude');
  if (OS === 'mac') {
    const sh = `'${bin.replace(/'/g, `'\\''`)}' /login`;
    const script = `tell application "Terminal" to do script "${sh.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    return new Promise(resolve => execFile('osascript', ['-e', 'tell application "Terminal" to activate', '-e', script], { timeout: 20000 },
      (err, out, errOut) => resolve({ ok: !err, err: String(errOut || err?.message || '').trim() })));
  }
  // Windows gives a detached program its own console window; Linux needs a terminal app and a desktop to show it on.
  let cmd = bin, args = ['/login'];
  if (!WIN) {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return Promise.resolve({ ok: false, err: 'No desktop to open a terminal on.' });
    const term = LINUX_TERMINALS.map(([t, a]) => [which(t), a]).find(([t]) => t);
    if (!term) return Promise.resolve({ ok: false, err: 'No terminal app found.' });
    cmd = term[0]; args = [...term[1], bin, '/login'];
  }
  return new Promise(resolve => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', e => resolve({ ok: false, err: e.message }));
      child.on('spawn', () => { child.unref(); resolve({ ok: true }); });
    } catch (e) { resolve({ ok: false, err: e.message }); }
  });
}

// Claude Code's sandbox ("Free in the project folder") works on Macs, and on Linux with bubblewrap and socat.
// Windows has none, so critters there ask before running commands.
export const SANDBOX = OS === 'mac' || (OS === 'linux' && !!which('bwrap') && !!which('socat'));
export const SANDBOX_MISSING = OS === 'windows'
  ? 'Windows has no sandbox for Claude Code, so commands ask you first.'
  : OS === 'linux' && !SANDBOX ? 'The sandbox needs bubblewrap and socat (for example: sudo apt install bubblewrap socat), so commands ask you first until they are installed.' : '';

/* ---------------- Words ---------------- */
// What the page and the critters call things on this computer.
export const WORDS = {
  mac: { os: 'mac', computer: 'Mac', system: 'Mac', files: 'Finder', terminal: 'Terminal', termWindow: 'Terminal window',
    admin: 'admin (sudo)', keys: 'the keychain', adminLine: 'Admin (sudo) commands, shutting down, disks, background services' },
  windows: { os: 'windows', computer: 'PC', system: 'Windows', files: 'File Explorer', terminal: 'a terminal window', termWindow: 'new window',
    admin: 'administrator (Run as administrator)', keys: 'Credential Manager',
    adminLine: 'Administrator commands, the registry, shutting down, disks, services and scheduled tasks' },
  linux: { os: 'linux', computer: 'computer', system: 'Linux', files: 'your file manager', terminal: 'a terminal', termWindow: 'terminal window',
    admin: 'admin (sudo)', keys: 'the keyring', adminLine: 'Admin (sudo) commands, shutting down, disks, services (systemctl) and desktop settings' },
}[OS];

/* ---------------- Guardrails ---------------- */
// Labels starting "deleting the whole" are blocked outright; every other match asks the boss first.
const WIPE = 'deleting the whole disk or home folder';
const PUSH = [/\bgit\s+push\b/, 'pushing code'];
const PUBLISH = [/\b(npm|pnpm|yarn)\s+publish\b/, 'publishing a package'];
const RM_R = [/\brm\s+(-\w*[rR]\w*)\b/, 'deleting folders'];
const NPM_G = [/\b(npm|pnpm)\s+(i|install|add)\s+(-g|--global)\b/, 'installing global tools'];
const CURL_SH = [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'running scripts straight from the internet'];
const CRON = [/\bcrontab\b/, 'scheduled system jobs'];
const CHMOD_R = [/\b(chmod|chown)\s+-R\s+\S*\s*(\/|~|\$HOME)(\s|$)/, 'changing permissions on the whole disk or home folder'];
const claudeFiles = [`${HOME}/.claude/settings.json`, `${HOME}/.claude/settings.local.json`, `${HOME}/.claude.json`, `${HOME}/.claude/plugins`];
const shellFiles = ['.zshrc', '.zprofile', '.zshenv', '.bash_profile', '.bashrc', '.profile', '.gitconfig'].map(f => path.join(HOME, f));

const PROFILES = {
  mac: {
    system: ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/private/var/db', '/Applications',
      '/opt/homebrew', '/usr/local', `${HOME}/Library/Preferences`, `${HOME}/Library/LaunchAgents`, `${HOME}/Library/Application Support/Claude`,
      ...claudeFiles, ...shellFiles],
    secret: [`${HOME}/.ssh`, `${HOME}/.gnupg`, `${HOME}/.aws`, `${HOME}/.config/gh`, `${HOME}/.netrc`, `${HOME}/.npmrc`,
      `${HOME}/Library/Keychains`, `${HOME}/Library/Cookies`, `${HOME}/Library/Application Support/Google/Chrome`,
      `${HOME}/Library/Application Support/Firefox`, `${HOME}/Library/Safari`],
    neverRun: [
      [/\b(sudo|doas)\b|(^|[;&|]\s*)su\s/, 'admin (sudo) commands'],
      [/\b(shutdown|reboot|halt|pmset|nvram|csrutil|spctl|kextload|kextunload|systemsetup|networksetup|dscl|tccutil|softwareupdate|diskutil|mdutil)\b/, 'Mac system settings and disks'],
      [/\blaunchctl\s+(load|unload|bootstrap|bootout|enable|disable|remove|submit|kickstart)\b/, 'background services on the Mac'],
      [/\bdefaults\s+(write|delete|import)\b/, 'Mac app preferences'],
      CRON,
      [/\bsecurity\s+(delete|add|set|import|export|dump|unlock|find-\w+-password\b.*\s-[wg]\b)/, 'the keychain (passwords)'],
      [/\brm\s+(-\w+\s+)*(\/|~|\$HOME|\/Users\/[^\s/]+)\/?(\s|\*|$)/, WIPE],
      CHMOD_R, CURL_SH,
    ],
    alwaysAsk: [PUSH, PUBLISH, RM_R,
      [/\bbrew\s+(install|uninstall|upgrade|reinstall)\b/, 'installing or removing Mac apps with Homebrew'], NPM_G],
    writers: /^\s*(sudo\s+)?(cp|mv|rm|rmdir|tee|chmod|chown|chflags|ln|touch|mkdir|install|rsync|ditto|unzip|sed\s+-i|tar\s+-?[a-z]*x)\b/,
    deleters: /^\s*(sudo\s+)?(rm|rmdir|unlink|srm|shred)\b/,
  },

  linux: {
    system: ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/boot', '/opt', '/srv', '/var/lib', '/var/spool', '/snap',
      '/sys', '/proc', '/dev', '/root', `${XDG_CONFIG}/autostart`, `${XDG_CONFIG}/systemd`, `${XDG_CONFIG}/environment.d`,
      `${HOME}/.local/share/applications`, `${HOME}/.local/bin`, `${HOME}/.pam_environment`, ...claudeFiles, ...shellFiles],
    secret: [`${HOME}/.ssh`, `${HOME}/.gnupg`, `${HOME}/.aws`, `${XDG_CONFIG}/gh`, `${HOME}/.netrc`, `${HOME}/.npmrc`, `${HOME}/.kube`,
      `${HOME}/.docker/config.json`, `${HOME}/.local/share/keyrings`, `${HOME}/.password-store`, `${XDG_CONFIG}/google-chrome`,
      `${XDG_CONFIG}/chromium`, `${XDG_CONFIG}/BraveSoftware`, `${HOME}/.mozilla`, `${HOME}/snap/firefox`, '/etc/shadow', '/etc/sudoers'],
    neverRun: [
      [/\b(sudo|doas|pkexec|run0)\b|(^|[;&|]\s*)su\s/, 'admin (sudo) commands'],
      // Only as a command (so a commit message that says "mount" doesn't ask).
      [/(^|[;&|(`]\s*|\$\(\s*|\bxargs\s+|\benv\s+)(shutdown|reboot|halt|poweroff|mkfs(\.\w+)?|fdisk|sfdisk|parted|gparted|wipefs|mount|umount|modprobe|insmod|rmmod|sysctl|iptables|nft|ufw|update-grub|grub-install|efibootmgr|useradd|usermod|userdel|groupadd|passwd|chpasswd|visudo|hostnamectl|timedatectl|nmcli)\b/, 'Linux system settings and disks'],
      [/\bdd\b[^;&|]*\bof=\/dev\//, 'Linux system settings and disks'],
      [/\bsystemctl\b(?!\s+(--user\s+)?(status|show|list-\w+|is-\w+|cat)\b)/, 'background services on the computer'],
      [/\b(gsettings\s+(set|reset)|dconf\s+(write|reset|load)|xdg-mime\s+default|update-alternatives)\b/, 'desktop and app settings'],
      CRON, [/(^|[;&|]\s*)(at\s+(now|\d|-f)|batch\b)/, 'scheduled system jobs'],
      [/\b(secret-tool\s+(store|clear|lookup)|pass\s+(insert|rm|show|edit|generate)|gpg\s+--(export-secret|delete-secret))/, 'the keyring (passwords)'],
      [/\brm\s+(-\w+\s+)*(\/|~|\$HOME|\/home\/[^\s/]+|\/root)\/?(\s|\*|$)/, WIPE],
      CHMOD_R, CURL_SH,
    ],
    alwaysAsk: [PUSH, PUBLISH, RM_R,
      [/\b(apt|apt-get|aptitude|dnf|yum|zypper|snap|flatpak|brew|nix-env)\s+(install|remove|purge|uninstall|upgrade|dist-upgrade|full-upgrade|autoremove|reinstall|erase)\b|\bpacman\s+-[SRU]|\bdpkg\s+-[iPr]\b|\brpm\s+-[iUe]\b/, 'installing or removing software'],
      NPM_G],
    writers: /^\s*(sudo\s+)?(cp|mv|rm|rmdir|tee|chmod|chown|chattr|ln|touch|mkdir|install|rsync|unzip|sed\s+-i|tar\s+-?[a-z]*x|truncate|dd)\b/,
    deleters: /^\s*(sudo\s+)?(rm|rmdir|unlink|shred)\b/,
  },

  // Claude Code on Windows runs commands in Git Bash, and may also use PowerShell, so both spellings are covered.
  windows: (() => {
    const sysRoot = env('SystemRoot', 'C:\\Windows'), pf = env('ProgramFiles', 'C:\\Program Files');
    const docs = path.join(HOME, 'Documents');
    return {
      system: [sysRoot, pf, env('ProgramFiles(x86)', 'C:\\Program Files (x86)'), env('ProgramData', 'C:\\ProgramData'),
        path.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), path.join(APPDATA, 'Claude'),
        path.join(LOCALAPPDATA, 'Microsoft', 'WindowsApps'), path.join(docs, 'PowerShell'), path.join(docs, 'WindowsPowerShell'),
        ...claudeFiles, ...shellFiles],
      secret: [`${HOME}/.ssh`, `${HOME}/.gnupg`, `${HOME}/.aws`, path.join(APPDATA, 'GitHub CLI'), `${HOME}/.netrc`, `${HOME}/_netrc`,
        `${HOME}/.npmrc`, `${HOME}/.kube`, `${HOME}/.docker/config.json`, path.join(APPDATA, 'Microsoft', 'Credentials'),
        path.join(LOCALAPPDATA, 'Microsoft', 'Credentials'), path.join(APPDATA, 'Microsoft', 'Protect'), path.join(APPDATA, 'Microsoft', 'Vault'),
        path.join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data'), path.join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data'),
        path.join(LOCALAPPDATA, 'BraveSoftware'), path.join(APPDATA, 'Mozilla', 'Firefox')],
      neverRun: [
        [/\b(sudo|gsudo|runas)\b|-verb\s+runas\b/i, 'administrator (Run as administrator) commands'],
        [/\b(shutdown|bcdedit|diskpart|format(\.com)?\s+[a-z]:|vssadmin|wbadmin|cipher\s+\/w|takeown|icacls|netsh|wevtutil\s+cl|manage-bde|Set-ExecutionPolicy|Set-MpPreference|Add-MpPreference|Disable-WindowsOptionalFeature|Enable-WindowsOptionalFeature|Restart-Computer|Stop-Computer|Clear-Disk|Format-Volume|Initialize-Disk)\b/i, 'Windows system settings and disks'],
        [/\breg(\.exe)?\s+(add|delete|import|load|unload|restore|copy)\b|\b(Set|New|Remove|Rename)-Item(Property)?\b[^;|&]*\bHK(LM|CU|CR|U|CC|EY_)/i, 'the Windows registry'],
        [/\bsc(\.exe)?\s+(create|delete|config|stop|start|failure)\b|\b(New|Set|Stop|Start|Restart|Remove)-Service\b/i, 'background services on the PC'],
        [/\bschtasks\b|\b(Register|Set|Unregister)-ScheduledTask\b/i, 'scheduled system jobs'],
        [/\b(cmdkey|vaultcmd)\b|\bGet-StoredCredential\b|\bConvertFrom-SecureString\b/i, 'Windows Credential Manager (passwords)'],
        // rm -rf on a drive or the user folder, from Git Bash or PowerShell.
        [/\brm\s+(-\w+\s+)*(\/|~|\$HOME|\$USERPROFILE|\/[a-z]|[a-z]:[\\/]?|\/[a-z]\/Users\/[^\s/]+|[a-z]:[\\/]Users[\\/][^\s\\/]+)[\\/]?(\s|\*|$)/i, WIPE],
        [/\b(Remove-Item|rd|rmdir|del|erase)\b[^;|&]*\s("?)([a-z]:[\\/]?|~|\$env:USERPROFILE|\$HOME|%USERPROFILE%|[a-z]:[\\/]Users[\\/][^\s\\/"]+)\2[\\/]?(\s|\*|$)/i, WIPE],
        CHMOD_R, CURL_SH,
        [/\b(iwr|irm|curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(iex|Invoke-Expression)\b|\bInvoke-Expression\b[^;]*\b(DownloadString|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b/i, 'running scripts straight from the internet'],
      ],
      alwaysAsk: [PUSH, PUBLISH, RM_R,
        [/\bRemove-Item\b[^;|&]*-Recurse\b|\b(rd|rmdir)\s+\/s\b|\bdel\s+(\/\w\s+)*\/s\b/i, 'deleting folders'],
        [/\b(winget|choco|scoop)\s+(install|uninstall|upgrade|remove|update)\b|\bmsiexec\b|\b(Install|Uninstall)-(Package|Module)\b|\bAdd-AppxPackage\b/i, 'installing or removing software'],
        NPM_G],
      writers: /^\s*(sudo\s+)?(cp|mv|rm|rmdir|tee|chmod|ln|touch|mkdir|install|rsync|unzip|sed\s+-i|tar\s+-?[a-z]*x|copy|xcopy|robocopy|move|del|erase|rd|ren|Copy-Item|Move-Item|Remove-Item|Set-Content|Add-Content|Out-File|New-Item|Rename-Item|Expand-Archive)\b/i,
      deleters: /^\s*(sudo\s+)?(rm|rmdir|unlink|shred|del|erase|rd|Remove-Item)\b/i,
    };
  })(),
};
// Tidy every place into this system's own spelling (C:\Users\me/.ssh becomes C:\Users\me\.ssh).
export const GUARD = { ...PROFILES[OS], system: PROFILES[OS].system.map(f => path.normalize(f)), secret: PROFILES[OS].secret.map(f => path.normalize(f)) };
// The command tools a critter can run. PowerShell is Claude Code's Windows shell tool.
export const SHELL_TOOLS = ['Bash', 'PowerShell'];
// Harmless places that look like system paths.
export const SAFE_DEVICES = ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', 'nul', 'NUL', '$null'];

// What the page needs to know about this computer.
export const pageInfo = () => ({ ...WORDS, sandbox: SANDBOX, sandboxMissing: SANDBOX_MISSING, desktop: !!CLAUDE_APP_DIR });
