// Picks the session a plain description points at ("whoever is on the
// checkout page"). Exact ids and names win outright. Otherwise each word of the
// description is looked for in the session's name, folder and machine. When
// more than one session fits equally well, nothing is picked and the sending
// session gets the list to ask the user.

const FILLER = new Set(
  'a an and the to of on in at for with from by is are was who whoever which that this one ones session sessions claude working works work doing does about please tell send message machine'.split(' ')
);

import { MACHINES } from './config.js';

// Words that point at one machine: each machine's own name and label, plus a
// few everyday words for a machine named mac or linux.
const ALIASES = {
  mac: ['mac', 'macbook', 'desktop', 'app'],
  linux: ['linux', 'ubuntu', 'vscode', 'terminal'],
};

export function machineWords(names = Object.keys(MACHINES)) {
  const out = {};
  for (const name of names) {
    out[name.toLowerCase()] = name;
    for (const w of ALIASES[name.toLowerCase()] || []) out[w] = name;
  }
  return out;
}

function stem(w) {
  return w.replace(/(ers|er|ing|es|s)$/, '') || w;
}

function words(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function sessionWords(s) {
  const folderParts = (s.folder || '').split('/').filter(Boolean).slice(-2).join(' ');
  return new Set(words(`${s.name || ''} ${folderParts}`).map(stem));
}

export function matchSession(target, sessions, MACHINE_WORDS = machineWords()) {
  const t = String(target || '').trim();
  if (!t) return { candidates: [], reason: 'No target given.' };
  const lower = t.toLowerCase();

  const byId = sessions.find((s) => s.id === lower);
  if (byId) return { match: byId };

  const byName = sessions.filter((s) => (s.name || '').toLowerCase() === lower);
  if (byName.length === 1) return { match: byName[0] };
  if (byName.length > 1) return { candidates: byName, reason: `${byName.length} sessions are named "${t}".` };

  const all = words(t);
  const machine = all.map((w) => MACHINE_WORDS[w]).find(Boolean) || null;
  const wanted = all.filter((w) => !FILLER.has(w) && !MACHINE_WORDS[w]).map(stem);
  const pool = machine ? sessions.filter((s) => s.machine === machine) : sessions;

  if (wanted.length === 0) {
    if (pool.length === 1) return { match: pool[0] };
    return { candidates: pool, reason: 'The description has no words to match on.' };
  }

  const scored = pool
    .map((s) => {
      const have = sessionWords(s);
      const hits = wanted.filter((w) => [...have].some((h) => h === w || (w.length >= 4 && h.length >= 4 && (h.startsWith(w) || w.startsWith(h)))));
      return { s, score: hits.length / wanted.length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { candidates: [], reason: `No session matches "${t}".` };
  const best = scored[0].score;
  const top = scored.filter((x) => x.score === best).map((x) => x.s);
  if (top.length === 1) return { match: top[0] };
  return { candidates: top, reason: `${top.length} sessions fit "${t}" equally well.` };
}

// Who gets an introduction: the live sessions on the chosen machine, narrowed
// to the ones that fit the user's hint when any do. When nothing fits the
// hint, everyone on that machine is asked, since only the right one answers.
export function pickIntroTargets(hint, sessions, machine, words = machineWords()) {
  const pool = machine === 'both' ? sessions : sessions.filter((s) => s.machine === machine);
  if (!hint || !String(hint).trim()) return pool;
  const r = matchSession(hint, pool, words);
  if (r.match) return [r.match];
  return r.candidates.length ? r.candidates : pool;
}
