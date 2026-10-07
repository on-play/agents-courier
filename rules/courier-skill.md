---
name: courier
description: Start working with another session, or a Codex thread, on either machine through Agents Courier. Type /courier with who to find and what to do together.
argument-hint: [who to find] ; [what to work on together]
disable-model-invocation: true
---

The user wants you to work together with another session through Agents Courier. Their words:

$ARGUMENTS

First decide which kind of session they mean.

## If they mean Codex (they say "Codex", "ChatGPT" or name a Codex thread)

Codex threads do not take part in introductions. Reach them directly:

1. Use `list_sessions`. Codex threads show as "Codex on the Mac" or "Codex on the Linux", with the thread's name and folder.
2. Pick the thread their words point to. If several could fit, or they named none, show them the Codex threads on the machine they mean and ask which one. Never pick one at random.
3. If they did not say what to send or do, ask them.
4. Use `send` with `to` set to that thread's id (it starts with `codex:`), and a complete, self-contained message.
5. Tell the user in one line which thread you sent it to. The ChatGPT app opens on that thread and Codex answers there.
6. Codex's answer arrives here as a courier reply. Tell the user what it said. To continue, `reply` to that answer's id; the courier passes it back to the same Codex thread.

## If they mean a Claude session

1. Work out from their words who to look for (a session name, a folder, or what it is working on) and what the two of you should do together. If they named neither, ask them before going on.
2. Use the courier `introduce` tool. Give it the task in one or two plain sentences, a hint about who to look for if they gave one, and one line on what you yourself are working on right now.
3. Tell the user in one line who you introduced yourself to. Then wait: answers arrive as courier replies.
4. When a session answers yes, reply to it to confirm, and give the task in full: what needs doing, what you already know, which files are involved. Then work together through `reply` until the task is done.
5. If several sessions say yes, or none answers after a few minutes, ask the user which one.
6. When the task is done, send a short closing reply saying what was settled, and tell the user the result.
