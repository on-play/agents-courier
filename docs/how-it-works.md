# How Agents Courier works

## The pieces

- **One small program on each machine** (`src/daemon.js`). It starts at login and keeps running. It knows the sessions on its own machine and talks to the program on the other machine.
- **Five tools in every Claude Code session** (`src/mcp.js`): `list_sessions`, `send`, `reply`, `introduce` and `bring_to_front`. A session uses them like any other tool; behind them is the program on its own machine.
- **A short rule** in `~/.claude/CLAUDE.md` ([rules/courier-rule.md](../rules/courier-rule.md)) so every session knows when and how to use those tools.
- **The `/courier` command** ([rules/courier-skill.md](../rules/courier-skill.md)) for starting a working conversation.

No outside packages. Plain Node.

## Finding sessions

Every open Claude Code session keeps a small file at `~/.claude/sessions/<process number>.json` with its name, folder, whether it's busy or idle, and where its inbox is. The courier reads those files. A session counts as live only if its process is still running and its inbox still exists, because files stay behind when a session closes badly.

For the other machine, the courier asks the program over there for its list, and puts the two lists together.

## Getting a message into a session

Since version 2.1.224, Claude Code gives every session an inbox: a small socket file on the machine (the path is in the session's file). Claude Code uses it so sessions on one machine can message each other. Anything that connects to that inbox and writes one line like this gets its message delivered:

```json
{"type":"user","message":{"role":"user","content":"the message text"}}
```

The session sees it as a message from another Claude session. It arrives with no return address, so the courier adds its own header: who sent it, from which machine and folder, and an id to reply to.

Claude Code still checks every arriving message against the receiving session's own settings (`crossSessionInbound`). A message from another session can't approve anything or change settings in the session that receives it.

## Knowing who is sending

The courier tool runs as a child of the session that uses it. To sign a message, it walks up its parent processes until it reaches one with a session file. No session has to introduce itself to the courier.

## Picking a session from plain words

1. An exact id (`linux:9106`) or exact name wins.
2. Otherwise each word of the description is looked for in the session's name and last two folder names ("the billing work" matches a folder called `billing`). Words like "mac" or "linux" narrow it to one machine.
3. If one session fits best, that's the one. If several fit equally well, nothing is sent: the sending session gets the list and asks you, or uses `introduce` to ask the sessions themselves.

## Replies

Every message gets an id like `c-1a2b3c4d`. When a session replies with that id, the courier looks the original up in its log and sends the answer to whoever sent it, on whichever machine. All messages in one back-and-forth share the id of the first one.

## Starting a working conversation

`/courier` asks your session to use `introduce`. That sends a short message to the live sessions on the other machine (or only the ones your words point to):

> Introduction: I am "payment-form-v2" on the Linux, folder checkout. Right now I am working on: ... The user started me to work together with a session on: ... If that is you, answer with the courier reply tool. If it is not you, do not reply.

Sessions that don't fit stay quiet, so nobody wastes a turn. One yes and the two start. Several or none, and your session asks you.

## Between the two machines

The two programs talk over HTTP on port 47321, on each machine's Tailscale (or home network) address and nowhere else. Every request must carry the shared secret, and requests from the network are accepted only from the other machine's address. Requests from the machine itself come over `127.0.0.1`.

## What leaves your machines

The courier itself sends nothing anywhere except to the courier on your other machine. It calls no AI model and no outside service. What does leave, as it always has: each Claude or Codex session sends its own conversation to its AI company to think, and a delivered message becomes part of that conversation like anything you type.

## Sessions that are closed

If a message is for a session that isn't running, or the other machine can't be reached, the courier holds it in `~/.agents-courier/held.json` and tries again every 15 seconds for up to a week. If the exact session is gone but a new one clearly took its place (the same name you gave it, or the only session in that folder), the new one gets it.

## The log

Every message, reply, delivery and hold is written to `~/.agents-courier/log/<date>.jsonl` on the machine that handled it. Nothing else keeps a copy.

## Codex threads

On a machine with the `codex` command, the courier also lists recent Codex threads (the last three days), by asking Codex for its thread list. A message for a Codex thread is left on it with `codex queue --thread <id> --message <text>`, and the thread is opened in the ChatGPT app (`codex://threads/<id>`), which runs it there like a message you typed. The courier then reads the thread every few seconds (reading never locks it), and once Codex has finished, sends its last answer back to the sender as a normal courier reply. Codex needs no courier tools of its own.

Codex threads are only considered when the words say "codex" or give a `codex:` id.

## Bringing a session to the front

Every Claude desktop app session has an app link, `claude://claude.ai/epitaxy/<id>`, built from the id in its session file. Opening that link switches the app's window to the session. Terminal sessions have no such link yet.

## Files the courier writes

| Where | What |
| --- | --- |
| `~/.agents-courier/machines.json` | the two machines' names and addresses |
| `~/.agents-courier/secret` | the shared secret (only you can read it) |
| `~/.agents-courier/log/` | one log file per day |
| `~/.agents-courier/held.json` | messages waiting to be delivered |
| `~/.agents-courier/courier.log` | the program's own output |
| `~/.claude/CLAUDE.md` | the rule, between two marked lines |
| `~/.claude/skills/courier/` | the `/courier` command |
