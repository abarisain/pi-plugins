# pi-claude-transcript

A small extension for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent)
that keeps the transcript readable. Finished tool rows are replaced with one
summary per turn:

```
✻ Thought for 2s · searched 1 pattern · read 3 files · ran 1 shell command · called github ×2
```

Running tools and failures stay visible. `edit` and `write` still use pi's
normal renderer, so diffs and written content are not hidden.

![pi transcript screenshot](https://raw.githubusercontent.com/abarisain/pi-plugins/master/plugins/pi-claude-transcript/pi-transcript.png)

This is a fork of [pi-compact-transcript](https://github.com/avhagedorn/pi-compact-transcript)
by avhagedorn (MIT). See [Credits](#credits).

## Install

```bash
pi install npm:@abarisain/pi-claude-transcript
```

Or point pi at a checkout of the [pi-plugins](https://github.com/abarisain/pi-plugins)
monorepo this lives in:

```bash
pi install /path/to/pi-plugins/plugins/pi-claude-transcript
# or, for a single session:
pi --extension /path/to/pi-plugins/plugins/pi-claude-transcript/index.ts
```

Restart pi afterwards — extensions load at startup.

## What it does

- Adds one `✻` summary after every turn, including thinking time, searches,
  reads, edits, shell commands, and MCP calls.
- Hides completed tool rows. Running tools and failures remain visible.
- `alt+t` shows or hides completed rows; `ctrl+o` still expands one row.
- Keeps normal diffs, written files, and images visible.
- Groups MCP calls by server, for example `called github ×2`.
- Combines tool-only turns instead of leaving a stack of summaries.

## Engine support

| | pi | omp ([oh-my-pi](https://github.com/can1357/oh-my-pi)) |
|---|---|---|
| `✻` per-turn summaries | yes | yes |
| Hidden/compact tool rows | yes | no — see below |
| `alt+t` toggle | yes | toggles state, no rows to reveal |
| Diffs and images | yes | n/a (rows are omp's own) |

On pi, the plugin can hide finished tool rows while keeping running tools,
errors, diffs, and images visible. omp does not expose enough of its transcript
UI for that, so only the summaries work there. To hide all tool activity in omp,
add this setting:

```json
{ "display.hideToolActivity": true }
```

## Credits

Forked from **pi-compact-transcript** by **avhagedorn**, MIT licensed. The
compact tool line, the thought ticker and the component-wrapping approach come
from that project.

This fork adds a summary after every turn, hides finished rows behind an
`alt+t` toggle, keeps diffs and images visible, groups MCP calls by server,
combines silent turns, and supports both pi and omp.

MIT — see [LICENSE](LICENSE), which carries both copyright lines.
