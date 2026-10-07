#!/usr/bin/env node

import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

// Apps may start this tool without the user's full PATH, so look in the usual
// places first.
const CODEX_CANDIDATES = [
  "/Applications/Codex.app/Contents/Resources/codex",
  `${process.env.HOME}/.local/bin/codex`,
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
];
const CODEX = process.env.CODEX_CLI_PATH || CODEX_CANDIDATES.find((p) => fs.existsSync(p)) || "codex";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const activeServers = new Map();

const tools = [
  {
    name: "codex",
    description:
      "Start a visible Codex desktop app thread and optionally wait for the turn to finish. Use this instead of a headless Codex call when the user wants to see delegated work in the Codex app.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "Self-contained instructions for Codex." },
        cwd: { type: "string", description: "Absolute project path Codex should work in." },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          default: "workspace-write",
        },
        "approval-policy": {
          type: "string",
          enum: ["untrusted", "on-failure", "on-request", "never"],
          default: "never",
        },
        model: { type: "string", description: "Optional Codex model override." },
        effort: {
          type: "string",
          enum: ["minimal", "low", "medium", "high", "xhigh"],
          description: "Optional reasoning effort override.",
        },
        title: { type: "string", description: "Optional visible Codex thread title." },
        waitForCompletion: {
          type: "boolean",
          default: false,
          description:
            "Defaults to false. Return immediately after the visible Codex turn starts so the user can watch it in the app. Set true only for short tasks.",
        },
        timeoutMs: {
          type: "number",
          default: DEFAULT_TIMEOUT_MS,
          description: "Maximum wait time when waitForCompletion is true.",
        },
      },
      additionalProperties: true,
    },
  },
  {
    name: "codex-reply",
    description:
      "Continue an existing visible Codex desktop app thread by threadId and optionally wait for the turn to finish.",
    inputSchema: {
      type: "object",
      required: ["threadId", "prompt"],
      properties: {
        threadId: { type: "string", description: "Existing visible Codex thread id." },
        prompt: { type: "string", description: "Follow-up instructions for Codex." },
        cwd: { type: "string", description: "Absolute project path Codex should work in." },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
        },
        "approval-policy": {
          type: "string",
          enum: ["untrusted", "on-failure", "on-request", "never"],
        },
        model: { type: "string", description: "Optional Codex model override." },
        effort: {
          type: "string",
          enum: ["minimal", "low", "medium", "high", "xhigh"],
          description: "Optional reasoning effort override.",
        },
        waitForCompletion: {
          type: "boolean",
          default: false,
          description:
            "Defaults to false. Return immediately after the visible Codex turn starts so the user can watch it in the app. Set true only for short tasks.",
        },
        timeoutMs: {
          type: "number",
          default: DEFAULT_TIMEOUT_MS,
          description: "Maximum wait time when waitForCompletion is true.",
        },
      },
      additionalProperties: true,
    },
  },
  {
    name: "codex-read",
    description: "Read a visible Codex desktop app thread by threadId.",
    inputSchema: {
      type: "object",
      required: ["threadId"],
      properties: {
        threadId: { type: "string" },
        includeTurns: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function asError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

function approvalPolicy(args) {
  return args["approval-policy"] || args.approvalPolicy || "never";
}

function compactThread(thread) {
  if (!thread) return null;
  return {
    id: thread.id,
    title: thread.title || null,
    preview: thread.preview || null,
    cwd: thread.cwd || null,
    status: thread.status || null,
    createdAt: thread.createdAt || null,
    updatedAt: thread.updatedAt || null,
  };
}

class AppServer {
  constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.proc = spawn(CODEX, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.agentText = "";
    this.commands = [];
    this.turnCompleted = null;
    this.stderr = "";
    this.timeoutMs = timeoutMs;
    this.ready = this.readLoop();
  }

  readLoop() {
    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.stderr += `\nCould not parse app-server stdout: ${line}`;
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      this.handleNotification(message);
    });
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
    this.proc.on("exit", (code, signal) => {
      const error = new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
    });
    return this.request("initialize", {
      clientInfo: {
        name: "claude_visible_codex_bridge",
        title: "Claude Visible Codex Bridge",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    }).then((result) => {
      this.notify("initialized", {});
      return result;
    });
  }

  handleNotification(message) {
    this.notifications.push(message);
    const params = message.params || {};
    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      this.agentText += params.delta;
    }
    if (message.method === "item/completed") {
      const item = params.item || {};
      if (item.type === "agent_message" && typeof item.text === "string") {
        this.agentText = item.text;
      }
      if (item.type === "command_execution") {
        this.commands.push({
          command: item.command || item.cmd || null,
          status: item.status || null,
        });
      }
    }
    if (message.method === "turn/completed") {
      this.turnCompleted = params;
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const payload = { method, id, params: params || {} };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  requestNoWait(method, params) {
    const id = this.nextId++;
    const payload = { method, id, params: params || {} };
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    return id;
  }

  notify(method, params) {
    this.proc.stdin.write(`${JSON.stringify({ method, params: params || {} })}\n`);
  }

  waitForTurn(timeoutMs) {
    if (this.turnCompleted) return Promise.resolve(this.turnCompleted);
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const interval = setInterval(() => {
        if (this.turnCompleted) {
          clearInterval(interval);
          resolve(this.turnCompleted);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(interval);
          reject(new Error("Timed out waiting for Codex turn to complete"));
        }
      }, 250);
    });
  }

  close() {
    this.proc.kill("SIGTERM");
  }
}

// Bring the thread up in the ChatGPT app (Codex tab), so the user sees the
// work without searching for it. While this bridge's own Codex copy runs the
// turn, the app shows the thread as "open in another app". When that copy
// closes, the app does not notice by itself: the user presses Retry once.
function showInApp(threadId) {
  if (!threadId) return;
  const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (opener) execFile(opener, [`codex://threads/${threadId}`], () => {});
}

const LOCKED_HELP =
  "Codex has this thread open in the ChatGPT app, so it cannot take a message from outside right now. " +
  "I opened the thread in the app for the user. Either ask them to close it there or wait until it is idle, then send again, " +
  "or ask them whether to start a new thread (codex tool) instead. Do not start a new thread without asking.";

function keepServerUntilTurnEnds(threadId, server) {
  activeServers.set(threadId, server);
  const cleanup = setInterval(() => {
    if (server.turnCompleted) {
      clearInterval(cleanup);
      activeServers.delete(threadId);
      server.close();
      setTimeout(() => showInApp(threadId), 1500);
    }
    if (server.proc.exitCode !== null || server.proc.killed) {
      clearInterval(cleanup);
      activeServers.delete(threadId);
    }
  }, 1000);
}

// The way that works with the ChatGPT app: leave the message on the thread
// with `codex queue` and open the thread in the app. The app runs it there,
// live, so there is no second copy of Codex holding the thread, no "open in
// another app" notice and no Retry. Tested 7 Oct 2026 (Codex 0.160).
function queueMessage(threadId, prompt, args) {
  const cli = ["queue", "--thread", threadId, "--message", prompt];
  if (args.sandbox) cli.push("--sandbox", args.sandbox);
  return new Promise((resolve, reject) => {
    execFile(CODEX, cli, { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`codex queue failed: ${(stderr || error.message).trim()}`));
      else resolve(stdout.trim());
    });
  });
}

async function readThreadMeta(threadId, includeTurns = false) {
  const server = new AppServer(60_000);
  await server.ready;
  try {
    const r = await server.request("thread/read", { threadId, includeTurns });
    return r?.thread || null;
  } finally {
    server.close();
  }
}

// Waits until the thread stops changing after the queued message, then
// returns Codex's last answer. Reading a thread does not lock it.
async function waitForQueuedAnswer(threadId, before, timeoutMs) {
  const started = Date.now();
  let last = before;
  let stableSince = null;
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5000));
    const t = await readThreadMeta(threadId);
    const updated = t?.updatedAt || 0;
    if (updated !== last) {
      last = updated;
      stableSince = Date.now();
    } else if (updated !== before && stableSince && Date.now() - stableSince > 20_000) {
      const full = await readThreadMeta(threadId, true);
      const turn = (full?.turns || []).slice(-1)[0];
      const text = (turn?.items || []).filter((i) => i.type === "agentMessage").map((i) => i.text).pop() || "";
      return { status: turn?.status || "completed", finalText: text };
    }
  }
  return { status: "still running", finalText: "" };
}

async function runQueuedTurn(args, mode) {
  let threadId = args.threadId;
  if (mode === "start") {
    // A new thread is only saved once it has a first message, and `codex
    // queue` needs a saved thread. So this copy of Codex gives it one short
    // first message, waits for it, and then lets go so the app can own it.
    const server = new AppServer(120_000);
    await server.ready;
    try {
      const started = await server.request("thread/start", clean({
        cwd: args.cwd || null,
        sandbox: args.sandbox || "workspace-write",
        approvalPolicy: approvalPolicy(args),
        model: args.model || null,
        threadSource: "codex_cli",
      }));
      threadId = started?.thread?.id;
      if (!threadId) throw new Error(`thread/start did not return a thread id: ${JSON.stringify(started)}`);
      if (args.title) await server.request("thread/name/set", { threadId, name: args.title });
      await server.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "This thread was opened by a Claude Code session. The task follows in the next message. Reply with one word: ready." }],
      });
      await server.waitForTurn(120_000);
    } finally {
      server.close();
    }
  }
  const before = (await readThreadMeta(threadId))?.updatedAt || 0;
  const queued = await queueMessage(threadId, args.prompt, args);
  showInApp(threadId);
  const result = {
    threadId,
    visibleInCodexApp: true,
    status: "queued",
    queued,
    note: "Message queued and the thread opened in the ChatGPT app (Codex tab). Codex runs it there, live, when the app has the thread open; no Retry needed. Read the answer later with codex-read, or pass waitForCompletion to wait for it.",
  };
  if (args.waitForCompletion === true) {
    Object.assign(result, await waitForQueuedAnswer(threadId, before, Number(args.timeoutMs || DEFAULT_TIMEOUT_MS)));
  }
  return result;
}

async function runVisibleTurn(args, mode) {
  const timeoutMs = Number(args.timeoutMs || DEFAULT_TIMEOUT_MS);
  const server = new AppServer(timeoutMs);
  await server.ready;
  const waitForCompletion = args.waitForCompletion === true;
  let threadId = args.threadId;
  let keepRunning = false;
  try {
    if (mode === "start") {
      const startParams = {
        cwd: args.cwd || null,
        sandbox: args.sandbox || "workspace-write",
        approvalPolicy: approvalPolicy(args),
        model: args.model || null,
        threadSource: "codex_cli",
      };
      const started = await server.request("thread/start", clean(startParams));
      threadId = started?.thread?.id;
      if (!threadId) throw new Error(`thread/start did not return a thread id: ${JSON.stringify(started)}`);
      if (args.title) {
        await server.request("thread/name/set", { threadId, name: args.title });
      }
    } else {
      const resumeParams = {
        threadId,
        cwd: args.cwd || null,
        sandbox: args.sandbox || null,
        approvalPolicy: args["approval-policy"] || args.approvalPolicy || null,
        model: args.model || null,
      };
      try {
        await server.request("thread/resume", clean(resumeParams));
      } catch (error) {
        if (/active writer/i.test(error.message || "")) {
          showInApp(threadId);
          throw new Error(LOCKED_HELP);
        }
        throw error;
      }
    }

    const turnParams = {
      threadId,
      cwd: args.cwd || null,
      approvalPolicy: args["approval-policy"] || args.approvalPolicy || null,
      model: args.model || null,
      effort: args.effort || null,
      input: [{ type: "text", text: args.prompt }],
    };

    let turnStarted;
    try {
      turnStarted = waitForCompletion
        ? server.request("turn/start", clean(turnParams))
        : null;
      if (!waitForCompletion) server.requestNoWait("turn/start", clean(turnParams));
    } catch (error) {
      if (/active writer/i.test(error.message || "")) {
        showInApp(threadId);
        throw new Error(LOCKED_HELP);
      }
      throw error;
    }
    showInApp(threadId);

    if (waitForCompletion) {
      try {
        await turnStarted;
      } catch (error) {
        if (/active writer/i.test(error.message || "")) throw new Error(LOCKED_HELP);
        throw error;
      }
      await server.waitForTurn(timeoutMs);
    } else {
      keepRunning = true;
      keepServerUntilTurnEnds(threadId, server);
    }

    const result = {
      threadId,
      visibleInCodexApp: true,
      status: waitForCompletion ? "completed" : "started",
      finalText: server.agentText || "",
      commands: server.commands,
      turn: server.turnCompleted?.turn || null,
      note: waitForCompletion
        ? "Visible Codex app thread completed."
        : "Visible Codex app thread started and opened in the ChatGPT app (Codex tab). While Codex works, the app shows it as \"open in another app\"; when Codex finishes, the user presses Retry once in the app to take the thread back and see the finished answer (the app does not notice on its own).",
    };
    return result;
  } finally {
    if (!keepRunning) {
      server.close();
      if (waitForCompletion) setTimeout(() => showInApp(threadId), 1500);
    }
  }
}

async function readVisibleThread(args) {
  const server = new AppServer(60_000);
  await server.ready;
  try {
    const response = await server.request("thread/read", {
      threadId: args.threadId,
      includeTurns: args.includeTurns !== false,
    });
    return {
      thread: compactThread(response?.thread),
      turns: response?.thread?.turns || response?.turns || [],
    };
  } finally {
    server.close();
  }
}

function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => [k, clean(v)]),
    );
  }
  return value;
}

function textResult(result) {
  const summary = [
    `threadId: ${result.threadId || result.thread?.id || "unknown"}`,
    `visibleInCodexApp: ${result.visibleInCodexApp ?? true}`,
    result.status ? `status: ${result.status}` : null,
    result.note || null,
    result.finalText ? `\nFinal answer:\n${result.finalText}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    content: [{ type: "text", text: summary || JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    send(asError(null, -32700, "Parse error"));
    return;
  }

  if (request.id === undefined || request.id === null) return;

  try {
    if (request.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "claude-visible-codex-bridge", version: "0.1.0" },
          instructions:
            "Use this server when the user wants Codex work to appear as visible Codex desktop app threads. Use codex for new delegated tasks and codex-reply for follow-ups using the same threadId.",
        },
      });
      return;
    }

    if (request.method === "tools/list") {
      send({ jsonrpc: "2.0", id: request.id, result: { tools } });
      return;
    }

    if (request.method === "tools/call") {
      const name = request.params?.name;
      const args = request.params?.arguments || {};
      let result;
      // `direct: true` keeps the older way (a separate Codex copy runs the turn;
      // the app needs Retry afterwards). The default queues through the app.
      if (name === "codex") result = args.direct ? await runVisibleTurn(args, "start") : await runQueuedTurn(args, "start");
      else if (name === "codex-reply") result = args.direct ? await runVisibleTurn(args, "reply") : await runQueuedTurn(args, "reply");
      else if (name === "codex-read") result = await readVisibleThread(args);
      else throw new Error(`Unknown tool: ${name}`);
      send({ jsonrpc: "2.0", id: request.id, result: textResult(result) });
      return;
    }

    send(asError(request.id, -32601, `Method not found: ${request.method}`));
  } catch (error) {
    send(asError(request.id, -32000, error.message || String(error), { stack: error.stack }));
  }
});
