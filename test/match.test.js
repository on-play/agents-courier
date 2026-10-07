// Session matching, checked against a set of sessions like the ones a real
// two-machine setup has: some named by hand, most named by Claude.
import assert from 'node:assert/strict';
import { matchSession, machineWords, pickIntroTargets } from '../src/match.js';
const WORDS = machineWords(['mac', 'linux']);

const S = (machine, pid, name, folder, namedByHand = false) => ({ machine, pid, id: `${machine}:${pid}`, name, folder, namedByHand });
const sessions = [
  S('mac', 11044, 'API pricing research', '/Users/me/Projects/shop-app', true),
  S('mac', 66190, 'Search page backend', '/Users/me/Projects/shop-app'),
  S('mac', 7847, 'Brainstorm new feature', '/Users/me/Projects/shop-app', true),
  S('mac', 21218, 'New session', '/Users/me/Projects/agents-courier', true),
  S('linux', 107620, 'checkout-51', '/home/me/Projects/services/checkout'),
  S('linux', 13292, 'billing-email-templates-c5', '/home/me/Projects/services/billing-email-templates'),
  S('linux', 333592, 'payment-form-v2', '/home/me/Projects/services/checkout', true),
  S('linux', 580127, 'billing-email-templates-a5', '/home/me/Projects/services/billing-email-templates'),
  S('linux', 9106, 'billing-30', '/home/me/Projects/services/billing'),
];

const pick = (t) => matchSession(t, sessions, WORDS);
const ids = (r) => (r.match ? [r.match.id] : r.candidates.map((c) => c.id)).sort();

// exact id and exact name win outright
assert.equal(pick('linux:9106').match.id, 'linux:9106');
assert.equal(pick('payment-form-v2').match.id, 'linux:333592');
assert.equal(pick('Brainstorm New Feature').match.id, 'mac:7847');

// plain descriptions
assert.equal(pick('whoever is on the payment form').match.id, 'linux:333592');
assert.equal(pick('the search page backend session').match.id, 'mac:66190');
assert.equal(pick('billing email templates a5').match.id, 'linux:580127');
assert.equal(pick('the agents courier session').match.id, 'mac:21218');

// several fit: nothing is picked, the sender asks the user
const billing = pick('whoever is on the billing work');
assert.equal(billing.match, undefined);
assert.deepEqual(ids(billing), ['linux:13292', 'linux:580127', 'linux:9106']);
assert.deepEqual(ids(pick('billing email templates')), ['linux:13292', 'linux:580127']);

// machine words narrow the pool
assert.deepEqual(ids(pick('the shop-app session on the mac')).length, 3);

// nothing fits
assert.equal(pick('the kubernetes migration').candidates.length, 0);

console.log('match: all checks passed');

// introductions
const others = sessions.filter((s) => s.id !== 'mac:21218');
const intro = (hint, machine) => pickIntroTargets(hint, others, machine, WORDS).map((s) => s.id).sort();
assert.deepEqual(intro('', 'linux').length, 5);
assert.deepEqual(intro('payment form', 'linux'), ['linux:333592']);
assert.deepEqual(intro('billing', 'linux'), ['linux:13292', 'linux:580127', 'linux:9106']);
assert.deepEqual(intro('the kubernetes migration', 'linux').length, 5); // nothing fits: ask all
assert.deepEqual(intro('search page', 'mac'), ['mac:66190']);
console.log('introductions: all checks passed');
