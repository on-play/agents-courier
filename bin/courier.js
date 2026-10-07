#!/usr/bin/env node
// Agents Courier setup and control.
//   node bin/courier.js pair <this-name> <this-address> <other-name> <other-address>   name the two machines
//   node bin/courier.js setup [secret]  make the shared secret (or save the one from the other machine)
//   node bin/courier.js install         start the courier at login, give every session the courier tool, write the rule into ~/.claude/CLAUDE.md
//   node bin/courier.js rule            rewrite the rule and the /courier command (after editing rules/)
//   node bin/courier.js uninstall       undo install
//   node bin/courier.js run             run the courier in this terminal (for testing)
//   node bin/courier.js status          show sessions on both machines and held messages
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, SECRET_FILE, MACHINES_FILE, HOME, PORT, IS_MAC, readSecret } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The node found on this shell's PATH (for example
// /opt/homebrew/opt/node@22/bin/node) keeps working across updates;
// process.execPath points into a versioned folder.
function stableNode() {
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, 'node');
    try {
      if (dir.startsWith('/') && fs.realpathSync(p) === fs.realpathSync(process.execPath)) return p;
    } catch {}
  }
  return process.execPath;
}
const NODE = stableNode();
const DAEMON = path.join(ROOT, 'src', 'daemon.js');
const MCP = path.join(ROOT, 'src', 'mcp.js');
const LABEL = 'agents-courier';
// What the project was called before; install removes those leftovers.
const OLD_LABEL = 'home-courier';
const OLD_PLIST = path.join(HOME, 'Library', 'LaunchAgents', `com.${OLD_LABEL}.plist`);
const OLD_UNIT = path.join(HOME, '.config', 'systemd', 'user', `${OLD_LABEL}.service`);
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `com.${LABEL}.plist`);
const UNIT = path.join(HOME, '.config', 'systemd', 'user', `${LABEL}.service`);
const RULE = path.join(ROOT, 'rules', 'courier-rule.md');
const SKILL_SRC = path.join(ROOT, 'rules', 'courier-skill.md');
const SKILL_DIR = path.join(HOME, '.claude', 'skills', 'courier');
const CLAUDE_MD = path.join(HOME, '.claude', 'CLAUDE.md');
const RULE_START = '<!-- agents-courier rule: start (written by agents-courier install, edit rules/courier-rule.md instead) -->';
const RULE_END = '<!-- agents-courier rule: end -->';
// Rule blocks written under either name are replaced.
const RULE_MARKERS = [
  ['<!-- agents-courier rule: start', '<!-- agents-courier rule: end -->'],
  ['<!-- home-courier rule: start', '<!-- home-courier rule: end -->'],
];

function pair(args) {
  const [thisName, thisAddress, otherName, otherAddress] = args;
  const okName = (n) => /^[a-z0-9][a-z0-9-]{0,30}$/.test(n || '');
  if (!okName(thisName) || !okName(otherName) || !thisAddress || !otherAddress || thisName === otherName) {
    throw new Error('Usage: node bin/courier.js pair <this-name> <this-address> <other-name> <other-address>\n' +
      'Names: short, lowercase, different (for example mac and linux). Addresses: each machine\'s Tailscale or home network address.');
  }
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const pairing = { this: { name: thisName, address: thisAddress }, other: { name: otherName, address: otherAddress } };
  fs.writeFileSync(MACHINES_FILE, JSON.stringify(pairing, null, 2) + '\n', { mode: 0o600 });
  console.log(`This machine is "${thisName}" (${thisAddress}); the other is "${otherName}" (${otherAddress}).`);
  restartIfInstalled();
}

function setup(given) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (given) {
    // Pasting often adds spaces or line breaks, or drops characters; strip the
    // first and refuse the second, so both machines end up with the same value.
    given = given.replace(/\s+/g, '');
    if (!/^[0-9a-f]{64}$/.test(given)) {
      throw new Error(`That is not the whole secret (${given.length} characters, need 64 letters and numbers). Copy the line again.`);
    }
    fs.writeFileSync(SECRET_FILE, given + '\n', { mode: 0o600 });
    console.log(`Saved the shared secret. Fingerprint ${fingerprint(given)}; it must match the other machine's.`);
    restartIfInstalled();
    return;
  }
  let s = readSecret();
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, s + '\n', { mode: 0o600 });
    console.log('Made a new shared secret.');
  }
  console.log(`Fingerprint ${fingerprint(s)}.`);
  console.log(`\nThe secret is in ${SECRET_FILE}. Show it in your own terminal with:\n  cat ${SECRET_FILE}\nthen on the other machine run:\n  node bin/courier.js setup <the secret>\n`);
}

// A short hash both machines can show to compare secrets without revealing them.
function fingerprint(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8);
}

// The courier reads the secret when it starts, so a new secret needs a restart.
function restartIfInstalled() {
  if (IS_MAC && fs.existsSync(PLIST)) {
    spawnSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.${LABEL}`], { stdio: 'inherit' });
    console.log('Restarted the courier.');
  } else if (!IS_MAC && fs.existsSync(UNIT)) {
    spawnSync('systemctl', ['--user', 'restart', `${LABEL}.service`], { stdio: 'inherit' });
    console.log('Restarted the courier.');
  }
}

function installService() {
  const logFile = path.join(DATA_DIR, 'courier.log');
  if (IS_MAC) {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.${LABEL}</string>
  <key>ProgramArguments</key><array><string>${NODE}</string><string>${DAEMON}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
</dict></plist>
`);
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, PLIST], { stdio: 'ignore' });
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, PLIST], { stdio: 'inherit' });
  } else {
    fs.mkdirSync(path.dirname(UNIT), { recursive: true });
    fs.writeFileSync(UNIT, `[Unit]
Description=Agents Courier
After=network-online.target tailscaled.service

[Service]
ExecStart=${NODE} ${DAEMON}
Restart=always
RestartSec=5
StandardOutput=append:${logFile}
StandardError=append:${logFile}

[Install]
WantedBy=default.target
`);
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    execFileSync('systemctl', ['--user', 'enable', '--now', `${LABEL}.service`], { stdio: 'inherit' });
  }
  console.log('Courier starts at login and is running now.');
}

// Stops and removes an installation made under the old name, home-courier.
// The settings folder has already moved (src/config.js does that on start).
function removeOldName() {
  let found = false;
  if (IS_MAC && fs.existsSync(OLD_PLIST)) {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, OLD_PLIST], { stdio: 'ignore' });
    fs.rmSync(OLD_PLIST, { force: true });
    found = true;
  }
  if (!IS_MAC && fs.existsSync(OLD_UNIT)) {
    spawnSync('systemctl', ['--user', 'disable', '--now', `${OLD_LABEL}.service`], { stdio: 'ignore' });
    fs.rmSync(OLD_UNIT, { force: true });
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    found = true;
  }
  const removed = spawnSync('claude', ['mcp', 'remove', '--scope', 'user', OLD_LABEL], { stdio: 'ignore' });
  if (removed.status === 0) found = true;
  if (found) console.log('Removed the old home-courier installation.');
}

function installTool() {
  spawnSync('claude', ['mcp', 'remove', '--scope', 'user', LABEL], { stdio: 'ignore' });
  execFileSync('claude', ['mcp', 'add', '--scope', 'user', LABEL, '--', NODE, MCP], { stdio: 'inherit' });
  console.log('Every new Claude Code session now has the courier tool. Sessions already open get it after a restart.');
}

// The rule lives in rules/courier-rule.md so both machines carry the same
// words. Install writes it into ~/.claude/CLAUDE.md between markers, replacing
// any earlier copy, so every Claude Code session on the machine reads it.
function stripRule(text) {
  for (const [start, end] of RULE_MARKERS) {
    const a = text.indexOf(start);
    const b = text.indexOf(end);
    if (a === -1 || b === -1) continue;
    text = (text.slice(0, a).trimEnd() + '\n' + text.slice(b + end.length).replace(/^\n+/, '\n')).trimEnd() + '\n';
  }
  return text;
}

function installRule() {
  const current = fs.existsSync(CLAUDE_MD) ? fs.readFileSync(CLAUDE_MD, 'utf8') : '';
  const rule = fs.readFileSync(RULE, 'utf8').trim();
  const next = stripRule(current).trimEnd() + `\n\n${RULE_START}\n${rule}\n${RULE_END}\n`;
  fs.mkdirSync(path.dirname(CLAUDE_MD), { recursive: true });
  fs.writeFileSync(CLAUDE_MD, next);
  console.log(`Courier rule written into ${CLAUDE_MD}.`);
  fs.mkdirSync(SKILL_DIR, { recursive: true });
  fs.copyFileSync(SKILL_SRC, path.join(SKILL_DIR, 'SKILL.md'));
  console.log(`/courier command written into ${SKILL_DIR}.`);
}

function uninstall() {
  if (IS_MAC) {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, PLIST], { stdio: 'inherit' });
    fs.rmSync(PLIST, { force: true });
  } else {
    spawnSync('systemctl', ['--user', 'disable', '--now', `${LABEL}.service`], { stdio: 'inherit' });
    fs.rmSync(UNIT, { force: true });
  }
  spawnSync('claude', ['mcp', 'remove', '--scope', 'user', LABEL], { stdio: 'inherit' });
  if (fs.existsSync(CLAUDE_MD)) fs.writeFileSync(CLAUDE_MD, stripRule(fs.readFileSync(CLAUDE_MD, 'utf8')));
  fs.rmSync(SKILL_DIR, { recursive: true, force: true });
  console.log('Courier removed. Its log and secret stay in ~/.agents-courier.');
}

async function status() {
  if (!fs.existsSync(MACHINES_FILE)) return console.log('No machine pair yet. Run: node bin/courier.js pair ...');
  const s = readSecret();
  if (!s) return console.log('No shared secret yet. Run setup.');
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/sessions`, { headers: { 'x-courier-secret': s } });
    const d = await r.json();
    for (const x of d.sessions) console.log(`${x.id.padEnd(14)} ${(x.name || '(unnamed)').padEnd(40)} ${x.status.padEnd(6)} ${x.folder}`);
    console.log(`\nOther machine: ${d.otherMachine}`);
  } catch {
    console.log('The courier is not running on this machine.');
  }
  const held = JSON.parse(fs.existsSync(path.join(DATA_DIR, 'held.json')) ? fs.readFileSync(path.join(DATA_DIR, 'held.json'), 'utf8') : '[]');
  console.log(`Held messages: ${held.length}`);
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'pair') pair(process.argv.slice(3));
  else if (cmd === 'setup') setup(arg);
  else if (cmd === 'install') {
    if (!fs.existsSync(MACHINES_FILE)) throw new Error('Run pair first.');
    if (!readSecret()) throw new Error('Run setup first.');
    removeOldName();
    installService();
    installTool();
    installRule();
  } else if (cmd === 'rule') installRule();
  else if (cmd === 'uninstall') uninstall();
  else if (cmd === 'run') await import(DAEMON);
  else if (cmd === 'status') await status();
  else console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n').replace(/^\/\/ ?/gm, ''));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
