# pi-plugins

Personal collection of plugins for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent)
(and [omp](https://github.com/can1357/oh-my-pi) where they work there).

| Plugin | What it does | Engines |
|---|---|---|
| [@abarisain/pi-claude-transcript](plugins/pi-claude-transcript) | Claude-Code-style compact transcript: one `✻` summary per turn instead of a wall of tool rows | pi, omp (summaries only) |
| [@abarisain/pi-silent-turn](plugins/pi-silent-turn) | `end_turn_silently` — suppress unsolicited replies from Telegram, pi-intercom, cron jobs, and other background turns | pi |
| [@abarisain/pi-markdown-memory](plugins/pi-markdown-memory) | No bullshit memory store. Folders & Markdown, global & project stores, that's it | pi |
| [@abarisain/pi-telegram-thinking](plugins/pi-telegram-thinking) | Live thinking on Telegram that deletes itself when the answer lands | pi + pi-telegram |

## Install

```bash
pi install npm:@abarisain/pi-silent-turn        # one plugin
pi install git:github.com/abarisain/pi-plugins  # all of them
```

Restart pi afterwards; extensions load at startup. To take only some of a
whole-repo install, filter it in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/abarisain/pi-plugins",
      "extensions": ["plugins/pi-claude-transcript/index.ts"]
    }
  ]
}
```

## Development

npm workspaces, TypeScript only, no build step — pi runs the `.ts` files directly.

```bash
npm install       # pi types for the editor, links workspaces
npm run typecheck # tsc --noEmit over every plugin
npm publish -w plugins/<name>
```

A new plugin is a directory under `plugins/` with `index.ts` (default-exporting
`(pi: ExtensionAPI) => void`), a `package.json` carrying the `pi.extensions` /
`omp.extensions` manifests, a README and a LICENSE, plus a row in the table
above. Anything pi bundles (`@earendil-works/*`, `typebox`) belongs in
`peerDependencies` at `"*"`, not `dependencies`.

## License

MIT — see [LICENSE](LICENSE). Plugins forked from other work carry their own
`LICENSE` with the upstream copyright lines too.
