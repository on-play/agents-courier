// The courier tool every session gets. It speaks MCP over stdin/stdout and
// passes each request to the courier program running on this machine.
import readline from 'node:readline';
import { PORT, THIS_MACHINE, OTHER_MACHINE, readSecret, machineLabel } from './config.js';
import { findOwnSession } from './sessions.js';
import { pickIntroTargets } from './match.js';

const SECRET = readSecret();
// Looked up when first needed, in case the session file appears after this starts.
let mine = null;
function self() {
  if (!mine) mine = findOwnSession();
  return mine;
}

const TOOLS = [
  {
    name: 'list_sessions',
    description:
      'List the live Claude Code sessions on both machines (Mac and Linux): name, machine, folder, busy or idle. Use it to see who is around before sending.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'send',
    description:
      'Send a message to another Claude Code session, or to a Codex thread (say "codex" in `to`), on either machine, through Agents Courier (never through outside servers). A Codex thread answers by itself; its answer comes back to you as a courier reply. "to" can be a session name, an id like "linux:9106", or a plain description like "whoever is on the checkout page". If more than one session fits, nothing is sent and you get the list back: ask the user which one, then send again using the id. To start a new working conversation the user asked for, use introduce instead. Using this tool means the message is ready; write it so the other session can act on it without this conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Session name, id, or plain description.' },
        text: { type: 'string', description: 'The message, complete and self-contained.' },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'reply',
    description:
      'Answer a courier message. Every courier message starts with an id like c-1a2b3c4d. Use this instead of a normal reply, which cannot reach a session on the other machine.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The courier message id you are answering.' },
        text: { type: 'string', description: 'Your answer.' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'introduce',
    description:
      'Start a courier conversation the user asked for: introduce yourself to the live sessions on the other machine and ask which one fits. Only use it when the user asked you to work with a session there (usually through /courier). Sessions that fit answer with reply; the others stay quiet.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What the user wants the two sessions to do together, in one or two plain sentences.' },
        about_me: { type: 'string', description: 'One line on what you are working on right now.' },
        hint: { type: 'string', description: 'Who to look for, if the user said: a name, folder, or what it works on. Leave empty to ask every session there.' },
        machine: { type: 'string', enum: ['other', 'this', 'both'], description: 'Where to look. Default: the other machine.' },
      },
      required: ['task', 'about_me'],
    },
  },
  {
    name: 'bring_to_front',
    description:
      'Switch the user\'s screen to another session, for example when they say "I\'ll continue in that session". Works for Claude desktop app sessions on macOS and Linux; terminal sessions cannot be brought to the front. "to" takes the same forms as in send.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string', description: 'Session name, id, or plain description.' } },
      required: ['to'],
    },
  },
];

async function courier(method, route, body) {
  if (!SECRET) throw new Error('The courier has no shared secret on this machine. Run setup first: node bin/courier.js setup.');
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${PORT}${route}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-courier-secret': SECRET },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('The courier program is not running on this machine.');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `courier answered ${res.status}`);
  return data;
}

function describe(s) {
  const name = s.name ? `"${s.name}"` : '(unnamed)';
  const where = s.kind === 'codex' ? `Codex on the ${machineLabel(s.machine)}` : machineLabel(s.machine);
  return `${s.id}  ${name}  ${where}  ${s.folder}  ${s.status}`;
}

async function runTool(name, args) {
  if (name === 'list_sessions') {
    const r = await courier('GET', '/sessions');
    const lines = r.sessions.map((s) => describe(s) + (self() && s.id === self().id ? '  (you)' : ''));
    return `${lines.join('\n')}\n\nOther machine: ${r.otherMachine}`;
  }
  const me = self();
  if (!me) throw new Error('Could not tell which session this is, so the courier cannot sign the message.');
  if (name === 'send' || name === 'reply') {
    const body = name === 'send'
      ? { fromPid: me.pid, to: args.to, text: args.text }
      : { fromPid: me.pid, replyTo: args.id, text: args.text };
    const r = await courier('POST', '/send', body);
    if (r.status === 'not sent') {
      const list = (r.candidates || []).map(describe).join('\n');
      return `Not sent. ${r.reason}${list ? `\n\nSessions that fit:\n${list}\n\nAsk the user which one they mean, then send again with its id.` : ''}`;
    }
    const where = `${r.to.name ? `"${r.to.name}"` : r.to.id} on the ${machineLabel(r.to.machine)}`;
    return r.status === 'held'
      ? `Message ${r.id} for ${where} is held: ${r.reason}.`
      : `Message ${r.id} delivered to ${where}.`;
  }
  if (name === 'introduce') {
    const where = !args.machine || args.machine === 'other' ? OTHER_MACHINE : args.machine === 'this' ? THIS_MACHINE : 'both';
    const { sessions } = await courier('GET', '/sessions');
    const targets = pickIntroTargets(args.hint, sessions.filter((s) => s.id !== me.id && s.kind !== 'codex'), where);
    if (targets.length === 0) return `No live sessions on ${where === 'both' ? 'either machine' : `the ${machineLabel(where)}`}. Tell the user.`;
    const text = `Introduction: I am ${me.name ? `"${me.name}"` : 'an unnamed session'} on the ${machineLabel(me.machine)}, folder ${me.folder}. Right now I am working on: ${args.about_me}\n\nThe user started me to work together with a session on: ${args.task}\n\nIf that is you, answer with the courier reply tool: yes, and two or three lines on what you are working on. If it is not you, do not reply.`;
    const lines = [];
    for (const t of targets) {
      const r = await courier('POST', '/send', { fromPid: me.pid, to: t.id, text });
      lines.push(`${describe(t)}: ${r.status === 'not sent' ? `not reached (${r.reason})` : `${r.status}, message ${r.id}`}`);
    }
    return `Introduced yourself to ${targets.length} session(s):\n${lines.join('\n')}\n\nAnswers arrive as courier replies. One yes: confirm and give the full task. Several or none: ask the user.`;
  }
  if (name === 'bring_to_front') {
    const r = await courier('POST', '/front', { to: args.to });
    if (r.ok) return `Brought ${r.session.name ? `"${r.session.name}"` : r.session.id} to the front.`;
    const list = (r.candidates || []).map(describe).join('\n');
    return `Could not bring it to the front: ${r.reason || r.why}${list ? `\n\n${list}` : ''}`;
  }
  throw new Error(`unknown tool ${name}`);
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function fail(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications need no answer
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'agents-courier', version: '0.1.0' },
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const text = await runTool(params.name, params.arguments || {});
      return reply(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: e.message }], isError: true });
    }
  }
  fail(id, -32601, `unknown method ${method}`);
});
