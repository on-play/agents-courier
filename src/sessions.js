// Reads the live Claude Code sessions on this machine from the small file each
// open session keeps in ~/.claude/sessions/<pid>.json.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SESSIONS_DIR, THIS_MACHINE } from './config.js';

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readSessionFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function toSession(d) {
  return {
    machine: THIS_MACHINE,
    pid: d.pid,
    id: `${THIS_MACHINE}:${d.pid}`,
    name: d.name || null,
    namedByHand: d.nameSource === 'user',
    folder: d.cwd || null,
    status: d.status || 'unknown',
    app: d.entrypoint === 'claude-desktop' ? 'desktop app' : 'terminal',
    appSessionId: d.hostSessionId || null,
    inbox: d.messagingSocketPath || null,
    updatedAt: d.updatedAt || null,
  };
}

// Files stay behind when a session closes badly, so a session counts as live
// only when its process is running and its inbox exists.
export function listLocalSessions() {
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const d = readSessionFile(path.join(SESSIONS_DIR, f));
    if (!d || !d.pid || !isRunning(d.pid)) continue;
    const s = toSession(d);
    if (!s.inbox || !fs.existsSync(s.inbox)) continue;
    out.push(s);
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function getLocalSession(pid) {
  return listLocalSessions().find((s) => s.pid === Number(pid)) || null;
}

function parentOf(pid) {
  try {
    return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()) || 0;
  } catch {
    return 0;
  }
}

// The courier tool runs as a child of the session that started it. Walk up the
// parent processes until one of them is a session with a file.
export function findOwnSession(startPid = process.ppid) {
  const live = new Map(listLocalSessions().map((s) => [s.pid, s]));
  let pid = startPid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    if (live.has(pid)) return live.get(pid);
    pid = parentOf(pid);
  }
  return null;
}
