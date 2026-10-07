// Decided values, plus the two things that differ per home: which two machines
// take part (in ~/.home-courier/machines.json) and the shared secret (in
// ~/.home-courier/secret). Both are written by `node bin/courier.js setup`.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const PORT = 47321;

export const HOME = os.homedir();
export const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
export const DATA_DIR = path.join(HOME, '.home-courier');
export const LOG_DIR = path.join(DATA_DIR, 'log');
export const HELD_FILE = path.join(DATA_DIR, 'held.json');
export const SECRET_FILE = path.join(DATA_DIR, 'secret');
export const MACHINES_FILE = path.join(DATA_DIR, 'machines.json');

export const IS_MAC = os.platform() === 'darwin';
export const IS_LINUX = os.platform() === 'linux';

// How often the courier retries messages held for sessions that were not running.
export const HELD_RETRY_MS = 15_000;
// Held messages older than this are given up on and logged as expired.
export const HELD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function label(name) {
  return name[0].toUpperCase() + name.slice(1);
}

// machines.json: {"this": {"name": "mac", "address": "100.x.y.z"},
//                 "other": {"name": "linux", "address": "100.x.y.z"}}
function readMachines() {
  try {
    const m = JSON.parse(fs.readFileSync(MACHINES_FILE, 'utf8'));
    if (m?.this?.name && m?.this?.address && m?.other?.name && m?.other?.address) return m;
  } catch {}
  return null;
}

const PAIR = readMachines();
export const HAS_MACHINES = Boolean(PAIR);
export const THIS_MACHINE = PAIR ? PAIR.this.name : os.hostname().split('.')[0].toLowerCase();
export const OTHER_MACHINE = PAIR ? PAIR.other.name : 'other';
export const MACHINES = PAIR
  ? {
      [PAIR.this.name]: { label: PAIR.this.label || label(PAIR.this.name), address: PAIR.this.address },
      [PAIR.other.name]: { label: PAIR.other.label || label(PAIR.other.name), address: PAIR.other.address },
    }
  : { [THIS_MACHINE]: { label: label(THIS_MACHINE), address: null } };

export function machineLabel(name) {
  return MACHINES[name]?.label || name;
}

export function readSecret() {
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    return s.length >= 32 ? s : null;
  } catch {
    return null;
  }
}
