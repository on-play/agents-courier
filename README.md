# home-courier

**Your Claude Code sessions on two computers can't talk to each other, so you end up carrying their messages by hand.**

## The story, told by the message

I am a message.

I was written by a Claude Code session on a Mac. I am meant for another Claude Code session, one working on a Linux machine. The two computers sit on the same desk, on the same home internet.

I still go the long way round. A person selects me, copies me, and pastes me into Telegram Saved Messages. My words leave the house, sit on a server somewhere, and come back down to the same desk. The person opens Telegram on the Linux machine, finds the right terminal among six, and pastes me in. Then they wait for the answer and carry that back the same way.

Before nine in the morning I had made that trip seven times.

There was a built-in fix, almost. Claude Code has a feature called Remote Control, made for reaching one session from anywhere: your phone, a browser. Switch it on everywhere, and Claude Code can also pass messages between different sessions on different machines, through Anthropic's servers. My person asked one question about it: does it store the information on Anthropic's servers? It does. So they said no, and asked for something else: *"an intelligent home network message server is what I'm imagining"*.

Later that morning I travelled differently. A session on the Linux machine introduced itself to a session on the Mac: who it was, what it was working on, what they had been asked to do together. The Mac session answered "Yes, that's me." I went back and forth between them eleven times, carrying cost figures and fixes, and nobody touched me. I never left the house.

This project is that courier.

## What it does

- **Lists every live session on both machines**: name, machine, folder, busy or idle.
- **Finds the right session from plain words.** "Whoever is on the checkout page" works. If several sessions fit, nothing is sent and you're asked which one.
- **Delivers messages, and replies come back.** Every message has an id; the receiving session answers with `reply`, and the answer finds its way home, even across machines.
- **Starts working conversations when you ask.** Type `/courier` with who to find and what to do together. Your session introduces itself to the sessions on the other machine; only the one that fits answers, and the two get to work.
- **Brings a session to the front** of the Claude desktop app when you say "I'll continue in that session" (desktop app sessions on macOS and Linux).
- **Talks to Codex too.** Say "codex" and the thread's name, and the message goes to that Codex thread (the Codex tab of the ChatGPT app) on either machine. The thread opens in the app, Codex answers there, and the courier brings the answer back to you.
- **Holds messages** for a session that isn't running, and delivers them when it's back.
- **Keeps the delivery at home.** The two couriers talk only to each other, directly, over Tailscale or your home network, with a shared secret. No outside service carries or stores your messages. (See below for what that does and doesn't cover.)

## What it is, and isn't

- **It isn't an AI.** home-courier is a plain program with no outside packages, and it never calls an AI model. Finding a session is plain word matching against names and folders; delivering is writing a line into the session's inbox (or `codex queue` for Codex). The intelligence is at both ends: Claude or Codex decides what to send, and works out what you meant when your words fit more than one session.
- **It isn't Remote Control.** Remote Control makes one session reachable from other devices. home-courier connects different sessions to each other, across two machines, without Remote Control and without storing your conversations anywhere else.
- **What stays at home, and what doesn't.** The delivery stays at home: the two couriers talk only to each other, and only they keep a log, on your own machines. But a message that lands in a session becomes part of that session's conversation, and that session sends its conversation to its own AI company to think, exactly as it does with everything you type there (Anthropic for Claude, OpenAI for Codex). The courier adds no new outside service; it doesn't make your sessions offline.
- **About Tailscale.** If you use Tailscale, its servers help your two machines find each other. The messages themselves go directly between the machines when they can, and are encrypted end to end either way.

## What you need

- Two computers (macOS or Linux), each with [Claude Code](https://code.claude.com) 2.1.224 or later. The courier uses Claude Code's own inbox for each session.
- Node.js 22 or later on both.
- A way for the two machines to reach each other: [Tailscale](https://tailscale.com) (easiest) or fixed addresses on your home network.
- Optional, for Codex: the `codex` command (it comes with the ChatGPT app's Codex) on the machine whose Codex threads you want to reach.

## Set it up

On **both** machines, get the code:

```bash
git clone https://github.com/on-play/home-courier.git ~/home-courier
```

On the **first** machine, name the two machines (any short names) with their addresses, then make the shared secret:

```bash
cd ~/home-courier
node bin/courier.js pair mac 100.64.0.1 linux 100.64.0.2
node bin/courier.js setup
```

`setup` prints a short fingerprint. Show the secret itself with `cat ~/.home-courier/secret` and copy it to the second machine however you like.

On the **second** machine, the same names, swapped, and the secret you copied:

```bash
cd ~/home-courier
node bin/courier.js pair linux 100.64.0.2 mac 100.64.0.1
node bin/courier.js setup PASTE_THE_SECRET
```

Its fingerprint must match the first machine's. Then, on **both** machines:

```bash
node bin/courier.js install
node bin/courier.js status
```

`status` should list sessions from both machines and say `Other machine: reachable`.

`install` does four things, and `node bin/courier.js uninstall` undoes them:
1. Starts the courier at login (a LaunchAgent on macOS, a systemd user service on Linux).
2. Gives every Claude Code session the courier tools (`claude mcp add --scope user`).
3. Adds a short section to `~/.claude/CLAUDE.md` telling sessions how to use the courier ([the exact words](rules/courier-rule.md)).
4. Adds the `/courier` command (`~/.claude/skills/courier`).

Sessions that were already open get the tools after a restart. For `/courier`, type `/reload-skills` once.

## Use it

```text
/courier the Mac session on the search page ; work together on the new filters
```

```text
/courier ; I want someone on the other machine to review the API response format with you
```

```text
/courier send a hello to the Courier test thread on Codex on the Linux machine
```

You can also just ask any session: "send the checkout session on Linux what we just found", "ask the codex thread on the landing page what it changed", or "list the sessions on both machines".

## How it works

[docs/how-it-works.md](docs/how-it-works.md) explains it in plain words: how sessions are found, how a message gets into a session, how replies find their way back, and what happens when a session is closed.

## Codex: you have to allow it

Reaching Codex means the courier hands a message to another AI agent by itself. Claude Code's own safety checks may stop a session from building or using that until **you** allow it in your Claude Code permission settings (for example, by switching that session to Manual mode and approving each step). There is no way around this, and the courier does not try.

Two more things to know:
- The courier only sends to Codex when the words say "codex" (or give a `codex:` id), so ordinary messages never land there by accident. Codex threads are not part of `/courier` introductions.
- Codex works with whatever access the ChatGPT app is set to (for example "Full access"), not what the sender asks for. Set it in the app to what you're comfortable with.

The message is left on the thread with Codex's own `codex queue` command and the thread is opened in the app, so the work happens there, live, in front of you.

There is also [codex/](codex/): a separate, optional tool that lets a Claude session hand a task to a new or existing Codex thread directly, without the courier.

## Limits

- Two machines. Not more, for now.
- Bringing a session to the front works for Claude desktop app sessions. Terminal sessions (including VS Code) can receive and send, but can't be brought to the front yet.
- Codex can answer, but can't start a conversation through the courier yet.
- Sessions don't start conversations on their own. You start them; the sessions take it from there.
- Picking a session from plain words uses session names and folders. Vague names (Claude makes some up) mean you'll be asked to choose more often.

## License

[MIT](LICENSE)
