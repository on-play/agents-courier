// Codex threads (the Codex tab of the ChatGPT app) as courier recipients.
// Claude Code's own safety checks may stop this from being built or used
// until the user allows it in their permission settings (see README).
//
// A message is left on the thread with Codex's own `codex queue` command, and
// the thread is opened in the ChatGPT app, which runs it there, live. The
// courier then watches the thread and, when Codex has answered, hands the
// answer back to whoever sent the message. Codex itself needs no courier tools.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFile } from 'node:child_process';
import { HOME, THIS_MACHINE, IS_MAC, IS_LINUX } from './config.js';

const CANDIDATES = [
  path.join(HOME, '.local', 'bin', 'codex'),
  '/Applications/Codex.app/Contents/Resources/codex',
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  '/usr/bin/codex',
];
export const CODEX = process.env.CODEX_CLI_PATH || CANDIDATES.find((p) => fs.existsSync(p)) || null;

// Threads touched within this window are listed as "recent".
const RECENT_MS = 3 * 24 * 60 * 60 * 1000;
const LIST_CACHE_MS = 30_000;
const WATCH_LIMIT_MS = 30 * 60 * 1000;

// A short-lived connection to Codex, used only for reading threads. Reading
// does not lock a thread, so the app keeps working normally.
async function withCodex(fn) {
  const proc = spawn(CODEX, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let nextId = 1;
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    try {
      const m = JSON.parse(line);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(m.error.message || 'Codex error')) : resolve(m.result);
      }
    } catch {}
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex did not answer ${method}`));
    }, 20_000);
    pending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await request('initialize', { clientInfo: { name: 'home_courier', title: 'Home courier', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
    return await fn(request);
  } finally {
    proc.kill('SIGTERM');
  }
}

function toParticipant(t) {
  return {
    machine: THIS_MACHINE,
    kind: 'codex',
    pid: null,
    threadId: t.id,
    id: `codex:${t.id}`,
    name: t.name || (t.preview || '').split('\n')[0].slice(0, 50) || null,
    namedByHand: Boolean(t.name),
    folder: t.cwd || null,
    status: 'recent',
    app: 'Codex',
    appSessionId: null,
    updatedAt: (t.updatedAt || 0) * 1000,
  };
}

let cache = { at: 0, list: [] };

export async function listCodexThreads() {
  if (!CODEX) return [];
  if (Date.now() - cache.at < LIST_CACHE_MS) return cache.list;
  const list = await withCodex(async (request) => {
    const r = await request('thread/list', { limit: 25 });
    const cutoff = Date.now() - RECENT_MS;
    const seen = new Set();
    return (r.data || []).map(toParticipant).filter((t) => t.updatedAt >= cutoff && !seen.has(t.id) && seen.add(t.id));
  });
  cache = { at: Date.now(), list };
  return list;
}

async function readThread(threadId, includeTurns) {
  return withCodex(async (request) => (await request('thread/read', { threadId, includeTurns }))?.thread || null);
}

// The courier runs as a background service; on Linux point the opener at the
// desktop session, which a service often does not know about.
export function openInApp(threadId) {
  const link = `codex://threads/${threadId}`;
  if (IS_MAC) return execFile('open', [link], () => {});
  if (IS_LINUX) {
    const uid = process.getuid();
    const env = {
      ...process.env,
      DISPLAY: process.env.DISPLAY || ':0',
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
    };
    execFile('xdg-open', [link], { env }, () => {});
  }
}

function queue(threadId, text) {
  return new Promise((resolve, reject) => {
    execFile(CODEX, ['queue', '--thread', threadId, '--message', text], { timeout: 60_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(`codex queue failed: ${(stderr || err.message).trim()}`)) : resolve(stdout.trim()));
  });
}

// Leaves the message on the thread, opens it in the app, and calls onAnswer
// with Codex's answer when the turn is finished.
export async function deliverToCodex(threadId, text, onAnswer) {
  if (!CODEX) throw new Error('Codex is not installed on this machine');
  const file = (await readThread(threadId, false))?.path || null;
  const offset = file && fs.existsSync(file) ? fs.statSync(file).size : 0;
  await queue(threadId, text);
  openInApp(threadId);
  if (file) watchFile(file, offset, onAnswer).catch(() => onAnswer(null));
  else onAnswer(null);
}

// Codex writes every thread to a file as it works and ends each finished turn
// with a "task_complete" line holding its final answer. Waiting on that file,
// instead of asking Codex about the thread, never disturbs the running turn.
// (Reading the whole thread from Codex mid-turn interrupted it, 7 Oct 2026.)
async function watchFile(file, offset, onAnswer) {
  const started = Date.now();
  let pos = offset;
  let carry = '';
  while (Date.now() - started < WATCH_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, 3000));
    const size = fs.existsSync(file) ? fs.statSync(file).size : pos;
    if (size <= pos) continue;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - pos);
    fs.readSync(fd, buf, 0, buf.length, pos);
    fs.closeSync(fd);
    pos = size;
    const lines = (carry + buf.toString('utf8')).split('\n');
    carry = lines.pop();
    for (const line of lines) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const type = e?.payload?.type;
      if (e.type === 'event_msg' && type === 'task_complete') return onAnswer(e.payload.last_agent_message || null);
      if (e.type === 'event_msg' && (type === 'turn_aborted' || type === 'task_aborted')) return onAnswer(null);
    }
  }
  return onAnswer(null);
}
