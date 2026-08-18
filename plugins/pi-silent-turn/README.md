# pi-silent-turn

Suppresses the final reply on background turns started by a messaging bridge,
another agent, or a scheduled job.

This is useful with Telegram and similar bridges, pi-intercom messages, cron
jobs, scheduled notifications, and peer-session messages. It is not useful for
normal interactive terminal turns, where someone is waiting for a reply.

```text
end_turn_silently({ reason: "duplicate of the report already sent" })
```

The tool stops the current run before it produces a final assistant message.
Useful results still go out normally; this is a way to discard duplicate or
unnecessary background replies.

## How it works

The tool checks how the turn started:

- **User-facing turns** start with typed input or a bridge-delivered user
  message. The tool refuses to silence these turns.
- **Background turns** start with a custom message from a bridge, another
  agent, scheduler, cron job, or peer extension. These turns can be silenced.

The agent should inspect the incoming report before deciding. Tool calls are not
sent to the user, but prose written before calling the tool may already have
been delivered by a bridge.

## Install

```bash
pi install npm:@abarisain/pi-silent-turn
```

`/silent-turn-last` shows why the last turn was dropped. The reason is stored
locally and is not sent to the user.

## Notes

- Bridges that forward partial output may still deliver text written before the
  tool call.
- The extension is available on every turn, but refuses user-facing turns.
- Your agent prompt should explain when this tool is appropriate.

MIT — see [LICENSE](LICENSE).
