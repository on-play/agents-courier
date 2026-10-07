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
// with Codex's answer once the thread has stopped changing.
export async function deliverToCodex(threadId, text, onAnswer) {
  if (!CODEX) throw new Error('Codex is not installed on this machine');
  const before = (await readThread(threadId, false))?.updatedAt || 0;
  await queue(threadId, text);
  openInApp(threadId);
  watch(threadId, before, onAnswer).catch(() => {});
}

async function watch(threadId, before, onAnswer) {
  const started = Date.now();
  let last = before;
  let stableSince = null;
  while (Date.now() - started < WATCH_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, 5000));
    const updated = (await readThread(threadId, false).catch(() => null))?.updatedAt || last;
    if (updated !== last) {
      last = updated;
      stableSince = Date.now();
    } else if (updated !== before && stableSince && Date.now() - stableSince > 20_000) {
      const full = await readThread(threadId, true);
      const turn = (full?.turns || []).slice(-1)[0];
      const answer = (turn?.items || []).filter((i) => i.type === 'agentMessage').map((i) => i.text).pop();
      if (answer) await onAnswer(answer);
      return;
    }
  }
  await onAnswer(null);
}
