# @abarisain/pi-telegram-thinking

Live thinking on Telegram that deletes itself when the answer lands.

[pi-telegram](https://github.com/llblab/pi-telegram) can show provider thinking with
`assistant.activity: "thinking"`, but that message is persistent by design — it stays
in the chat, under the answer, forever. Thinking is useful exactly while you are
waiting for a reply and is clutter the moment one arrives.

This owns the thinking message instead: one message, sent on the first reasoning
delta, edited as the stream grows, deleted when the run settles.

```
🧠 thinking                      →   (gone)
                                     Yun: the 402 is OpenRouter, not the model —
…checking which provider the           you have no balance on that account.
account is on, then whether the
error is billing or auth…
```

## Install

```bash
pi install npm:@abarisain/pi-telegram-thinking
```

Then turn pi-telegram's own thinking off, or you get both:

```json
{ "assistant": { "activity": "quiet" } }
```

`quiet` hides tool rows too. Use `"tools"` to keep those and let this own thinking.

## Why it deletes at settlement

`agent-settled` is pi's only boundary after automatic retries, compaction and queued
continuations — `agent-end` fires earlier and would take the thinking away mid-flight
on a retried turn. The final assistant segment clears it too, so the message
disappears as the reply appears rather than a tick later.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `PI_TELEGRAM_THINKING_INTERVAL_MS` | `2000` | Minimum gap between edits (min 500) |
| `PI_TELEGRAM_THINKING_MAX_CHARS` | `900` | Visible tail of the stream (max 3500) |
| `PI_TELEGRAM_THINKING_HEADER` | `🧠 thinking` | First line of the message |

The tail is shown rather than the head: where the reasoning currently is beats where
it started. Text is sent unformatted — a reasoning stream is arbitrary prose, and half
a Markdown construct is a delivery failure rather than a rendering quirk.

## No fork

This is a companion extension: it registers a handler through pi-telegram's public
Activity API and uses the target-bound `send` / `edit` / `delete` its context provides.
It owns no bot loop, no polling, no transport, and patches nothing.

A chat error (blocked bot, deleted message) is absorbed: the run producing the text
never sees it, and a message that cannot be deleted is left for you to remove rather
than throwing inside the bridge.
