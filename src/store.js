// The courier's memory: one log file per day of every message and reply, and a
// list of messages held for sessions that were not running.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, LOG_DIR, HELD_FILE } from './config.js';

fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });

export function newMessageId() {
  return 'c-' + crypto.randomBytes(4).toString('hex');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function logEvent(event) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
  fs.appendFileSync(path.join(LOG_DIR, `${today()}.jsonl`), line, { mode: 0o600 });
}

// Finds a message by id, newest day first, so a reply knows where to go.
export function findMessage(id) {
  let days = [];
  try {
    days = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.jsonl')).sort().reverse();
  } catch {
    return null;
  }
  for (const day of days.slice(0, 30)) {
    const lines = fs.readFileSync(path.join(LOG_DIR, day), 'utf8').split('\n');
    for (const l of lines) {
      if (!l.includes(id)) continue;
      try {
        const e = JSON.parse(l);
        if (e.kind === 'sent' && e.message?.id === id) return e.message;
      } catch {}
    }
  }
  return null;
}

export function readHeld() {
  try {
    return JSON.parse(fs.readFileSync(HELD_FILE, 'utf8'));
  } catch {
    return [];
  }
}

export function writeHeld(list) {
  const tmp = HELD_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, HELD_FILE);
}

export { DATA_DIR };
