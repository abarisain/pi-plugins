# @abarisain/pi-markdown-memory

No bullshit memory store. Folders & Markdown, global & project stores, that's it.

One file per memory, one line per file in a `MEMORY.md` index. Only the index goes
into the prompt, so the store has no size limit — the agent reads a body when a line
looks relevant.

```
~/.pi/agent/memory/
├── MEMORY.md                     # the index, loaded every turn
├── user-prefers-tabs.md
├── grafana-dashboards.md
└── projects/
    └── -home-you-code-app-3f2a1b9c/
        ├── MEMORY.md             # loaded only while working in that repo
        └── migration-plan.md
```

## Two layers

**Global** is what stays true wherever the agent works: who you are, this machine,
standing preferences. **Project** is keyed to the repository root, so subdirectory
sessions and worktrees share one store, and it is only in the prompt while the agent
is in that repo.

Saving defaults to project inside a repository and global outside one; the agent can
say which explicitly.

## The index

`MEMORY.md` is the point. It is the only thing loaded every turn, so each line is a
hook — name, then a one-line description — and the body stays on disk until something
reads it. Both indexes together are bounded at 200 lines / 25KB: the project layer
gets what the global one leaves, so adding a second store never doubles the prompt.

A save that would push an index past the bound is refused rather than silently
dropped, which is the agent's cue to merge overlapping memories. Updating an existing
entry is always allowed.

## Tool

`memory` — `save`, `read`, `delete`, `list`, `check`, `reindex`.

`save` takes a `name`, a `description` (the index line), the `content`, an optional
`type` (`user` / `feedback` / `project` / `reference`) and an optional `scope`.
Frontmatter is written for you.

`check` reports index lines with no file and files with no index line. `reindex`
rebuilds an index from the files' own frontmatter. Both exist because an index that
drifts from its files is a store that has silently lost memories: reads fail one at a
time while the index still looks healthy.

## Install

```bash
pi install npm:@abarisain/pi-markdown-memory
```

Restart pi afterwards.

| Variable | Effect |
|---|---|
| `PI_MEMORY_DIR` | Move the store root (absolute or `~/…`). Default `$PI_CODING_AGENT_DIR/memory` |
| `PI_MEMORY_DISABLED` | `1` to load and write nothing |

## Credit

The index format, the overflow rule and the tool shape come from the memory extension
in [pi-code](https://github.com/ilovepixelart/pi-code) (MIT), which is worth using
whole if you want the rest of the Claude Code experience in pi. This packages that
idea standalone and adds the second layer, the frontmatter contract and the index
repair.
