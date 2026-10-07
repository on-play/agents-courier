// The courier program that runs in the background on each machine. It answers
// the sessions on its own machine, and talks to the courier on the other
// machine over Tailscale. Every request must carry the shared secret, and
// requests from the network are accepted only from the other machine.
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  PORT, MACHINES, THIS_MACHINE, OTHER_MACHINE, HAS_MACHINES, IS_MAC, IS_LINUX, HELD_RETRY_MS, HELD_MAX_AGE_MS, readSecret, machineLabel,
} from './config.js';
import { listLocalSessions, getLocalSession } from './sessions.js';
import { postToInbox } from './inbox.js';
import { matchSession } from './match.js';
import { newMessageId, logEvent, findMessage, readHeld, writeHeld } from './store.js';
import { CODEX, listCodexThreads, deliverToCodex } from './codex.js';

const SECRET = readSecret();
if (!SECRET) {
  console.error('No shared secret. Run: node bin/courier.js setup');
  process.exit(1);
}

if (!HAS_MACHINES) {
  console.error('No machine pair yet. Run: node bin/courier.js setup <this-name> <this-address> <other-name> <other-address>');
  process.exit(1);
}

const PEER = MACHINES[OTHER_MACHINE];

// ---------- talking to the other machine ----------

async function callPeer(method, route, body) {
  const res = await fetch(`http://${PEER.address}:${PORT}${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-courier-secret': SECRET },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `other machine answered ${res.status}`);
  return data;
}

function publicView(s) {
  const { inbox, ...rest } = s;
  return rest;
}

// Claude Code sessions plus recent Codex threads on this machine.
async function localParticipants() {
  const claude = listLocalSessions().map((s) => ({ kind: 'claude', ...publicView(s) }));
  const codex = await listCodexThreads().catch((e) => {
    console.error('could not list Codex threads:', e.message);
    return [];
  });
  return [...claude, ...codex];
}

async function allSessions() {
  const local = await localParticipants();
  try {
    const peer = await callPeer('GET', '/local-sessions');
    return { sessions: [...local, ...peer.sessions], otherMachine: 'reachable' };
  } catch (e) {
    return { sessions: local, otherMachine: `not reachable (${e.message})` };
  }
}

// ---------- delivery ----------

function folderName(f) {
  return (f || '').split('/').filter(Boolean).pop() || f;
}

function envelope(m) {
  const where = m.from.kind === 'codex' ? `Codex on the ${machineLabel(m.from.machine)}` : machineLabel(m.from.machine);
  const from = `"${m.from.name || 'unnamed session'}" (${where}, folder ${folderName(m.from.folder)})`;
  const head = m.replyTo
    ? `[Courier reply ${m.id} from ${from}, answering your message ${m.replyTo}]`
    : `[Courier message ${m.id} from ${from}]`;
  const footer = m.to.kind === 'codex'
    ? '[Answer here as usual. The courier sends your answer back to the sender.]'
    : `[To answer, use the courier "reply" tool with id ${m.id}. A normal reply will not reach the sender.]`;
  return `${head}\n\n${m.text}\n\n${footer}`;
}

// When the exact session is gone, a new session that is clearly its successor
// takes the message: same hand-given name, or the only session in that folder.
function findRecipient(to) {
  const live = listLocalSessions();
  const same = live.find((s) => s.pid === to.pid);
  if (same) return same;
  if (to.namedByHand && to.name) {
    const named = live.filter((s) => s.name === to.name);
    if (named.length === 1) return named[0];
  }
  const inFolder = live.filter((s) => s.folder === to.folder);
  return inFolder.length === 1 ? inFolder[0] : null;
}

async function deliverHere(m) {
  if (m.to.kind === 'codex') {
    await deliverToCodex(m.to.threadId, envelope(m), (answer) => answerFromCodex(m, answer));
    return { id: m.to.id };
  }
  const s = findRecipient(m.to);
  if (!s) throw new Error('session is not running');
  await postToInbox(s.inbox, envelope(m));
  return s;
}

// Codex has no courier tools, so the courier carries its answer back as a
// normal courier reply from that thread.
async function answerFromCodex(m, answer) {
  if (!answer) {
    logEvent({ kind: 'codex-no-answer', id: m.id, thread: m.to.id });
    return;
  }
  const reply = { id: newMessageId(), thread: m.thread, from: slim(m.to), to: m.from, text: answer, replyTo: m.id };
  logEvent({ kind: 'sent', message: reply });
  await route(reply);
}

function hold(m, where, reason) {
  const held = readHeld();
  if (!held.some((h) => h.message.id === m.id)) {
    held.push({ message: m, where, reason, since: Date.now() });
    writeHeld(held);
  }
  logEvent({ kind: 'held', id: m.id, where, reason });
}

// Delivers a message to its machine, or holds it if that cannot happen now.
async function route(m) {
  if (m.to.machine === THIS_MACHINE) {
    try {
      const s = await deliverHere(m);
      logEvent({ kind: 'delivered', id: m.id, to: s.id });
      return { status: 'delivered', to: s.id };
    } catch (e) {
      hold(m, 'here', e.message);
      return { status: 'held', reason: `${e.message}; the courier will deliver it when the session is back` };
    }
  }
  try {
    const r = await callPeer('POST', '/deliver', { message: m });
    return r;
  } catch (e) {
    hold(m, 'forward', e.message);
    return { status: 'held', reason: `other machine not reachable (${e.message}); the courier will retry` };
  }
}

async function retryHeld() {
  const held = readHeld();
  if (held.length === 0) return;
  const keep = [];
  for (const h of held) {
    if (Date.now() - h.since > HELD_MAX_AGE_MS) {
      logEvent({ kind: 'expired', id: h.message.id });
      continue;
    }
    try {
      if (h.where === 'here') {
        const s = await deliverHere(h.message);
        logEvent({ kind: 'delivered', id: h.message.id, to: s.id, afterHolding: true });
      } else {
        await callPeer('POST', '/deliver', { message: h.message });
        logEvent({ kind: 'forwarded', id: h.message.id, afterHolding: true });
      }
    } catch {
      keep.push(h);
    }
  }
  writeHeld(keep);
}

function slim(s) {
  return {
    machine: s.machine, kind: s.kind || 'claude', pid: s.pid ?? null, threadId: s.threadId ?? null,
    id: s.id, name: s.name, namedByHand: s.namedByHand, folder: s.folder,
  };
}

// ---------- bringing a session to the front ----------

function bringToFront(s) {
  return new Promise((resolve) => {
    if (s.machine !== THIS_MACHINE) return resolve({ ok: false, why: 'wrong machine' });
    if (s.appSessionId && (IS_MAC || IS_LINUX)) {
      const link = `claude://claude.ai/epitaxy/${s.appSessionId}`;
      if (IS_MAC) {
        execFile('open', [link], (err) => resolve(err ? { ok: false, why: err.message } : { ok: true }));
        return;
      }
      // The courier runs as a background service, which on Linux often has no
      // idea which screen to use; point xdg-open at the desktop session.
      const uid = process.getuid();
      const env = {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ':0',
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
      };
      execFile('xdg-open', [link], { env }, (err) => resolve(err ? { ok: false, why: err.message } : { ok: true }));
      return;
    }
    resolve({ ok: false, why: 'only Claude desktop app sessions can be brought to the front; terminal sessions cannot yet' });
  });
}

// ---------- requests ----------

const handlers = {
  'GET /local-sessions': async () => ({ sessions: await localParticipants() }),

  'GET /sessions': async () => allSessions(),

  'POST /send': async ({ fromPid, to, text, replyTo }, { local }) => {
    if (!local) throw httpError(403, 'send only from this machine');
    if (!text || !String(text).trim()) throw httpError(400, 'empty message');
    const from = getLocalSession(fromPid);
    if (!from) throw httpError(400, 'could not tell which session is sending');
    const { sessions, otherMachine } = await allSessions();
    const others = sessions.filter((s) => s.id !== from.id);
    let match;
    if (replyTo) {
      // A reply goes back to whoever sent the original, even if that session
      // has since closed; delivery then holds it or finds its successor.
      const original = findMessage(replyTo);
      if (!original) throw httpError(404, `no courier message with id ${replyTo}`);
      match = others.find((s) => s.id === original.from.id) || original.from;
    } else {
      // Codex threads are only considered when the words say "codex" (or give
      // a codex: id), so ordinary messages never land in Codex by accident.
      const wantsCodex = /\bcodex\b/i.test(String(to));
      const pool = others.filter((s) => (s.kind === 'codex') === wantsCodex);
      const words = wantsCodex && !String(to).startsWith('codex:') ? String(to).replace(/\bcodex\b/gi, ' ') : to;
      const r = matchSession(words, pool);
      if (!r.match) return { status: 'not sent', reason: r.reason, candidates: r.candidates.map(publicView), otherMachine };
      match = r.match;
    }
    const id = newMessageId();
    // Every message in one back-and-forth shares the id of the first message.
    const thread = replyTo ? (findMessage(replyTo)?.thread || replyTo) : id;
    const m = { id, thread, from: slim(from), to: slim(match), text: String(text), replyTo: replyTo || null };
    logEvent({ kind: 'sent', message: m });
    const result = await route(m);
    return { id: m.id, ...result, to: match };
  },

  'POST /deliver': async ({ message }) => {
    if (!message?.id || message.to?.machine !== THIS_MACHINE) throw httpError(400, 'not a message for this machine');
    if (!findMessage(message.id)) logEvent({ kind: 'sent', message });
    return route(message);
  },

  'POST /front': async ({ to }, { local }) => {
    const { sessions } = await allSessions();
    const r = matchSession(to, sessions);
    if (!r.match) return { ok: false, reason: r.reason, candidates: r.candidates };
    if (r.match.machine !== THIS_MACHINE) {
      if (!local) throw httpError(400, 'session is not on this machine');
      return callPeer('POST', '/front', { to: r.match.id });
    }
    const res = await bringToFront(getLocalSession(r.match.pid) || r.match);
    logEvent({ kind: 'front', to: r.match.id, ok: res.ok, why: res.why });
    return { ...res, session: r.match };
  },
};

function httpError(code, message) {
  return Object.assign(new Error(message), { code });
}

function sameSecret(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

async function handle(req, res) {
  const send = (code, data) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const addr = req.socket.remoteAddress;
  const local = isLoopback(addr);
  const fromPeer = addr === PEER.address || addr === `::ffff:${PEER.address}`;
  if (!local && !fromPeer) return send(403, { error: 'not allowed' });
  if (!sameSecret(req.headers['x-courier-secret'])) return send(401, { error: 'wrong secret' });

  const key = `${req.method} ${req.url.split('?')[0]}`;
  const h = handlers[key];
  if (!h) return send(404, { error: `unknown request ${key}` });

  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2_000_000) return send(413, { error: 'too large' });
  }
  try {
    const data = await h(body ? JSON.parse(body) : {}, { local });
    send(200, data);
  } catch (e) {
    send(e.code && Number.isInteger(e.code) ? e.code : 500, { error: e.message });
  }
}

// ---------- start ----------

function listen(host) {
  const server = http.createServer(handle);
  server.on('error', (e) => {
    console.error(`could not listen on ${host}:${PORT} (${e.code}); trying again in 30s`);
    setTimeout(() => listen(host), 30_000);
  });
  server.listen(PORT, host, () => console.log(`courier listening on ${host}:${PORT}`));
}

listen('127.0.0.1');
listen(MACHINES[THIS_MACHINE].address);
setInterval(() => retryHeld().catch((e) => console.error('retry failed', e.message)), HELD_RETRY_MS);
logEvent({ kind: 'started', machine: THIS_MACHINE, pid: process.pid });
