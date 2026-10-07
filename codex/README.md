# Optional: hand work from Claude to Codex

A small tool that lets any Claude Code session hand a task to Codex (the coding helper in the ChatGPT app) and follow up in the same thread, with the work happening live in the app where you can see it. It is separate from the courier: install it only if you use Codex.

## What it gives Claude

- `codex`: start a new Codex thread with a task, in a project folder you choose.
- `codex-reply`: send a follow-up into an existing Codex thread by its id.
- `codex-read`: read a Codex thread.

## How it works

The message is left on the thread with Codex's own `codex queue` command, and the thread is opened in the ChatGPT app. The app runs it there, live, like any message you type. So the work shows up in the app, and the thread is never locked.

A brand-new thread first gets one short message ("The task follows in the next message. Reply: ready."), because Codex only saves a thread once it has a message, and `codex queue` needs a saved thread.

A Claude session can wait for the answer (`waitForCompletion: true`) or read it later with `codex-read`.

## Install

You need the `codex` command on your PATH (or set `CODEX_CLI_PATH`). Then:

```bash
claude mcp add --scope user codex -- node ~/agents-courier/codex/codex-tool.mjs
```

## You have to allow it

Claude Code's own safety checks may stop a Claude session from handing work to Codex on its own. That is a decision for you, not for the tool: if you want it, allow it in your Claude Code permission settings. There is no way around that, and the tool does not try.

## Good to know

- The queued message runs when the thread is open in the ChatGPT app. The tool opens it for you; if the app is closed, it starts the app.
- **Codex works with the access the ChatGPT app is set to.** A queued message runs inside the app, so it uses the app's setting (for example "Full access": Codex can change any file and use the internet without asking), not whatever the Claude session asked for. Set the access in the app to what you're comfortable with before handing Codex work this way.
- `direct: true` uses the older way: a separate copy of Codex runs the task. The app then shows "This is open in another app" until you press Retry. Only use it when the app isn't available.
