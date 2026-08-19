/**
 * pi-markdown-memory — persistent memory as markdown files, in two layers.
 *
 * One file per memory, one index line per file. Only the INDEX is injected into
 * the prompt, so the store itself has no size limit: bodies are read on demand
 * through the tool. That is the whole trick, and it is why this exists instead of
 * a character-capped store that rewrites or evicts entries to stay under budget.
 *
 * TWO LAYERS, because one store is wrong in both directions:
 * - GLOBAL — the user, their machine, standing preferences: true wherever the
 *   agent works. Always in the prompt.
 * - PROJECT — facts about ONE repository, keyed to its root so subdirectory
 *   sessions share it. In the prompt only while the agent works there.
 *
 * Global-only means an agent fixing a typo carries every unrelated decision in its
 * prompt forever. Project-only means the machine's GPU count is knowledge it has
 * in one repo and lacks in the next.
 *
 * The index format, the overflow rule and the tool shape come from pi-code's
 * memory extension (MIT, © 2025 Mario Zechner, © 2026 ilovepixelart); the layering,
 * the frontmatter contract and the consistency check are this package's.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const INDEX_FILE = "MEMORY.md";

/** What a session loads, across BOTH layers together — the budget belongs to the
 * prompt, not to each store, so a project layer never doubles what is carried. */
export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25_000;
/** Cap on a single body returned by `read`, so one file cannot flood a turn. */
const BODY_MAX_BYTES = 24_000;

const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];

/** A flag set to "0" is off, not "set therefore on". */
function envFlag(name: string): boolean {
	return /^(1|true|yes|on)$/i.test((process.env[name] ?? "").trim());
}

function agentHome(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

/** Nearest enclosing repository root, so subdirectory sessions share one store. */
function repoRoot(cwd: string): string | undefined {
	let dir = path.resolve(cwd);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Readable dashed path plus a short digest: the digest is what keeps the slug
 * injective, since every separator collapses to a dash and /a/b, /a-b and \a\b
 * would otherwise share one store. */
export function projectSlug(cwd: string): string {
	const readable = cwd.replace(/[/\\]/g, "-").replace(/^-+/, "-");
	const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
	return `${readable}-${digest}`;
}

/** Root of the whole store. PI_MEMORY_DIR relocates it (absolute or ~/…). */
export function memoryRoot(): string {
	const override = process.env.PI_MEMORY_DIR?.trim();
	if (override?.startsWith("~/")) return path.join(os.homedir(), override.slice(2));
	if (override && path.isAbsolute(override)) return override;
	return path.join(agentHome(), "memory");
}

export type Scope = "global" | "project";

export interface Layer {
	scope: Scope;
	dir: string;
	/** What this layer is about: a repository path, or the user themselves. */
	subject: string;
}

/** The project a store belongs to: the repository root, or the directory itself
 * when there is no repo. */
export function projectOf(cwd: string): string {
	return repoRoot(cwd) ?? path.resolve(cwd);
}

export function layersFor(cwd: string): { global: Layer; project: Layer } {
	const root = memoryRoot();
	const subject = projectOf(cwd);
	return {
		global: { scope: "global", dir: root, subject: "everywhere" },
		project: { scope: "project", dir: path.join(root, "projects", projectSlug(subject)), subject },
	};
}

function memoryEnabled(): boolean {
	return !envFlag("PI_MEMORY_DISABLED");
}

/** Compose the frontmatter, rather than trusting each save to write it by hand —
 * the index is generated from these fields, so they cannot be allowed to drift.
 * A body that already carries its own frontmatter is left alone apart from the
 * `modified:` stamp. */
export function composeMemory(
	name: string,
	description: string,
	type: MemoryType,
	body: string,
	now: string,
): string {
	if (/^---\r?\n/.test(body)) return stampModified(body, now);
	const today = now.slice(0, 10);
	return (
		"---\n" +
		`name: ${name}\n` +
		`description: ${description.replace(/\s+/g, " ").trim()}\n` +
		"metadata:\n" +
		`  type: ${type}\n` +
		`  created: ${today}\n` +
		`modified: ${now}\n` +
		"---\n\n" +
		`${body.trim()}\n`
	);
}

/** Set or replace the ISO `modified:` field in frontmatter. A file without
 * frontmatter is left untouched rather than growing one. */
export function stampModified(content: string, iso: string): string {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!match) return content;
	const rest = content.slice(match[0].length);
	const inner = match[1]
		.split("\n")
		.filter((line) => !/^\s*modified\s*:/.test(line))
		.join("\n");
	const body = inner.length > 0 ? `${inner}\n` : "";
	return `---\n${body}modified: ${iso}\n---${rest}`;
}

/** The part of an index that loads: frontmatter and HTML comments are stripped, so
 * they neither reach the prompt nor count against the bounds. That is what makes
 * the `<!-- project: … -->` marker free to keep. */
export function stripNonLoaded(text: string): string {
	return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").replace(/<!--[\s\S]*?-->\r?\n?/g, "");
}

const entryPrefix = (name: string): string => `- [${name}](${name}.md):`;

/** Add or replace this memory's line, keyed by its link target. */
export function upsertIndexLine(index: string, name: string, description: string): string {
	const line = `${entryPrefix(name)} ${description.replace(/\s+/g, " ").trim()}`;
	const lines = index.split("\n").filter((l) => l.trim().length > 0 && !l.startsWith(entryPrefix(name)));
	if (lines.length === 0 || !lines[0].startsWith("#")) lines.unshift("# Memory index");
	lines.push(line);
	return `${lines.join("\n")}\n`;
}

export function removeIndexLine(index: string, name: string): string {
	const lines = index.split("\n").filter((l) => l.trim().length > 0 && !l.startsWith(entryPrefix(name)));
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** Whether adding this memory would push one layer's index past what a session
 * loads. Replacing an existing entry is not growth, and must stay allowed so a
 * full index can still be revised back under the bound. */
export function indexWouldOverflow(index: string, name: string, description: string): boolean {
	if (index.split("\n").some((entry) => entry.startsWith(entryPrefix(name)))) return false;
	const next = stripNonLoaded(upsertIndexLine(index, name, description));
	return next.split("\n").length > INDEX_MAX_LINES || Buffer.byteLength(next, "utf-8") > INDEX_MAX_BYTES;
}

/** One index, bounded to what is left of the prompt budget. */
export function capIndexForPrompt(index: string, maxLines = INDEX_MAX_LINES, maxBytes = INDEX_MAX_BYTES): string {
	// The file's own "# Memory index" heading is redundant under the layer heading
	// the prompt already gives it, and it costs a line of the budget.
	const loaded = stripNonLoaded(index).replace(/^#[^\n]*\n+/, "").trimEnd();
	if (!loaded) return "";
	const lines = loaded.split("\n");
	const kept = lines.slice(0, Math.max(maxLines, 1));
	let dropped = lines.length - kept.length;
	let text = kept.join("\n");
	while (Buffer.byteLength(text, "utf-8") > maxBytes && kept.length > 1) {
		kept.pop();
		dropped++;
		text = kept.join("\n");
	}
	if (dropped <= 0) return loaded;
	return `${text}\n(${dropped} more memories not shown; use the memory tool with action "list")`;
}

export function slugifyName(name: string): string {
	return (
		name
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/g, "-")
			.replaceAll(/^-|-$/g, "")
			.slice(0, 64) || "memory"
	);
}

function indexPath(layer: Layer): string {
	return path.join(layer.dir, INDEX_FILE);
}

function readIndex(layer: Layer): string {
	try {
		return fs.readFileSync(indexPath(layer), "utf-8");
	} catch (error) {
		// Only a missing file is an empty index: treating any other failure as empty
		// would let the next read-modify-write erase every entry.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

function readIndexQuietly(layer: Layer): string {
	try {
		return readIndex(layer);
	} catch {
		return "";
	}
}

/** Replace an index through a rename, so a crash mid-write cannot truncate it. */
function writeIndex(layer: Layer, content: string): void {
	fs.mkdirSync(layer.dir, { recursive: true });
	const target = indexPath(layer);
	const tmp = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, target);
}

/** A project index records which project it belongs to: the slug is a one-way
 * hash, and a store nobody can identify is a store nobody dares delete. */
function projectHeader(layer: Layer): string {
	return layer.scope === "project" ? `<!-- project: ${layer.subject} -->\n` : "";
}

function entryNames(index: string): string[] {
	return [...index.matchAll(/^- \[([^\]]+)\]\([^)]+\.md\):/gm)].map((m) => m[1]);
}

function bodyFiles(layer: Layer): string[] {
	try {
		return fs
			.readdirSync(layer.dir)
			.filter((f) => f.endsWith(".md") && f !== INDEX_FILE)
			.map((f) => f.slice(0, -3));
	} catch {
		return [];
	}
}

/** Index and bodies disagreeing is the failure that hides: reads fail one at a
 * time while the index still looks healthy. This is what finds it. */
export function checkLayer(layer: Layer): { missing: string[]; orphans: string[] } {
	const listed = entryNames(readIndexQuietly(layer));
	const files = bodyFiles(layer);
	return {
		missing: listed.filter((name) => !files.includes(name)),
		orphans: files.filter((name) => !listed.includes(name)),
	};
}

/** A memory's own view of itself, for rebuilding an index that drifted. */
function frontmatterOf(layer: Layer, name: string): { name: string; description: string } | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(layer.dir, `${name}.md`), "utf-8");
	} catch {
		return undefined;
	}
	const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
	const description = block ? /^\s*description\s*:\s*(.+)$/m.exec(block[1])?.[1]?.trim() : undefined;
	// A file with no description still deserves a line: its first prose line beats
	// being invisible, which is the whole failure mode this repairs.
	const firstLine = stripNonLoaded(raw)
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	return { name, description: description || firstLine?.slice(0, 120) || "(no description)" };
}

/** Rebuild an index from the files themselves. The index is the only part of the
 * store that is loaded, so an index that has drifted from the files is a store
 * that has silently lost memories — this is the repair. */
export function reindexLayer(layer: Layer): { added: string[]; removed: string[]; total: number } {
	const before = entryNames(readIndexQuietly(layer));
	const files = bodyFiles(layer);
	let index = projectHeader(layer);
	for (const name of files.sort()) {
		const meta = frontmatterOf(layer, name);
		if (meta) index = upsertIndexLine(index, meta.name, meta.description);
	}
	if (files.length > 0) writeIndex(layer, index);
	else fs.rmSync(indexPath(layer), { force: true });
	return {
		added: files.filter((name) => !before.includes(name)),
		removed: before.filter((name) => !files.includes(name)),
		total: files.length,
	};
}

function capBody(body: string): string {
	if (Buffer.byteLength(body, "utf-8") <= BODY_MAX_BYTES) return body;
	return `${body.slice(0, BODY_MAX_BYTES)}\n\n[memory truncated — split it into smaller memories]`;
}

export function saveMemory(
	layer: Layer,
	name: string | undefined,
	description: string | undefined,
	content: string | undefined,
	type: MemoryType = "reference",
	now: string = new Date().toISOString(),
): string {
	if (!name || !description || !content) return "save requires name, description, and content.";
	const index = readIndex(layer);
	if (indexWouldOverflow(index, name, description)) {
		return `The ${layer.scope} memory index is full (${INDEX_MAX_LINES} entries or ${INDEX_MAX_BYTES} bytes of index — the files themselves are unlimited). Merge or delete entries before saving ${name}.`;
	}
	fs.mkdirSync(layer.dir, { recursive: true });
	fs.writeFileSync(path.join(layer.dir, `${name}.md`), composeMemory(name, description, type, content, now));
	writeIndex(layer, upsertIndexLine(index || projectHeader(layer), name, description));
	return `Saved ${layer.scope} memory ${name}.`;
}

const MemoryParams = Type.Object({
	action: StringEnum(["save", "read", "delete", "list", "check", "reindex"] as const, { description: "What to do" }),
	name: Type.Optional(Type.String({ description: "Short kebab-case memory name (save/read/delete)" })),
	description: Type.Optional(
		Type.String({ description: "One-line hook for the always-loaded index (save)" }),
	),
	content: Type.Optional(Type.String({ description: "The memory itself, in markdown. Frontmatter is added for you." })),
	type: Type.Optional(
		StringEnum(MEMORY_TYPES, {
			description:
				"user (who they are, their setup) | feedback (guidance and corrections they gave you) | project (goals, constraints, decisions) | reference (pointers to external resources)",
		}),
	),
	scope: Type.Optional(
		StringEnum(["global", "project"] as const, {
			description:
				'Which layer. "global" = true wherever you work. "project" = true of THIS repository only. Defaults to project inside a repository, global outside one. For read/delete, omit it to search both.',
		}),
	),
});

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }], details: {} });

export default function markdownMemory(pi: ExtensionAPI) {
	let layers = layersFor(process.cwd());
	let inRepository = false;

	const resolveTarget = (scope: Scope | undefined, forWriting: boolean): Layer => {
		if (scope) return scope === "global" ? layers.global : layers.project;
		// Saving without saying: a repository's session is usually saying something
		// about that repository. Outside one there is nothing else it could mean.
		return forWriting && inRepository ? layers.project : layers.global;
	};

	/** Where a named memory actually is — project first, since a project memory
	 * shadowing a global one is the specific case that wants the specific answer. */
	const locate = (name: string, scope?: Scope): Layer | undefined => {
		const candidates = scope ? [resolveTarget(scope, false)] : [layers.project, layers.global];
		return candidates.find((layer) => fs.existsSync(path.join(layer.dir, `${name}.md`)));
	};

	pi.on("session_start", async (_event, ctx) => {
		layers = layersFor(ctx.cwd);
		inRepository = repoRoot(ctx.cwd) !== undefined;
		if (!memoryEnabled()) return;
		const counts = [layers.global, layers.project].map((layer) => entryNames(readIndexQuietly(layer)).length);
		if (counts[0] + counts[1] > 0) {
			ctx.ui.notify(`Memory: ${counts[0]} global, ${counts[1]} for this project`, "info");
		}
		for (const layer of [layers.global, layers.project]) {
			const { missing } = checkLayer(layer);
			if (!missing.length) continue;
			ctx.ui.notify(
				`Memory: ${missing.length} ${layer.scope} ${missing.length === 1 ? "entry has" : "entries have"} no file (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}) — run the memory tool with action "check"`,
				"warning",
			);
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!memoryEnabled()) return;
		const globalIndex = capIndexForPrompt(readIndexQuietly(layers.global));
		// The project layer gets what the global one left of the shared budget, so
		// two indexes never cost more than one did.
		const usedLines = globalIndex ? globalIndex.split("\n").length : 0;
		const usedBytes = Buffer.byteLength(globalIndex, "utf-8");
		const projectIndex = capIndexForPrompt(
			readIndexQuietly(layers.project),
			INDEX_MAX_LINES - usedLines,
			INDEX_MAX_BYTES - usedBytes,
		);
		if (!globalIndex && !projectIndex) return;

		const sections = [
			globalIndex && `### Everywhere\n\n${globalIndex}`,
			projectIndex && `### ${layers.project.subject}\n\n${projectIndex}`,
		].filter(Boolean);

		return {
			systemPrompt: `${event.systemPrompt}

# Memory

You keep a persistent memory across sessions: one markdown file per memory, with a
one-line index per layer. Only the index below is loaded every turn — read a memory
with the memory tool (action "read") when its line looks relevant to what you are
doing. A one-line hook is a pointer, not a fact to act on.

Two layers. **Everywhere** is what stays true wherever you work: the user, this
machine, standing preferences. The other is scoped to one repository and is only
here while you are working in it.

${sections.join("\n\n")}

Save (action "save") the moment something proves durable — a fact about this setup, a
decision and its reason, a correction from the user, anything you would otherwise
rediscover. Give it a \`type\`:

- **user** — who they are, their setup, how they like to work.
- **feedback** — guidance they gave you, corrections and confirmed approaches. Follow
  the body with **Why:** and **How to apply:** lines, so a later session can act on it.
- **project** — goals, constraints and decisions not derivable from the code or git
  history. Convert relative dates to absolute ones.
- **reference** — pointers to external resources: URLs, dashboards, tickets.

Scope it honestly: "project" for what is only true of this repository (the default
while you are in one), "global" for what you would want in any session. The
\`description\` becomes the index line, so write it as a hook someone scanning would
follow — that index is what you carry every turn.

Maintain it, do not just append. Before saving, check whether a memory already covers
the subject and update that one instead of adding a near-duplicate; link related
memories with [[name]]; delete what turns out to be wrong. Do not save what the
repository already records — its structure, past fixes, git history, existing docs —
or what only matters to this conversation. When the index grows unwieldy, merge
overlapping memories rather than letting them accumulate.`,
		};
	});

	pi.registerTool({
		name: "memory",
		label: "Memory",
		description:
			"Your persistent memory across sessions, in two layers: global (true wherever you work) and project (true of this repository only). Save durable facts, decisions, corrections and preferences that are not derivable from the code. Actions: save (name + description + content, plus type and scope), read (name), delete (name), list, check (report index/file disagreements), reindex (rebuild an index from the files). Both indexes are already in your prompt; use read for a body.",
		parameters: MemoryParams,
		async execute(_id, params) {
			if (!memoryEnabled()) {
				return text("Memory is disabled (PI_MEMORY_DISABLED). Nothing was read or written.");
			}
			const name = params.name ? slugifyName(params.name) : undefined;

			if (params.action === "save") {
				const layer = resolveTarget(params.scope, true);
				try {
					return text(saveMemory(layer, name, params.description, params.content, params.type));
				} catch (error) {
					return text(
						`Memory save failed: ${error instanceof Error ? error.message : String(error)}. The index was left untouched.`,
					);
				}
			}

			if (params.action === "read") {
				if (!name) return text("read requires name.");
				const layer = locate(name, params.scope);
				if (!layer) return text(`No memory named ${name}.`);
				try {
					return text(capBody(fs.readFileSync(path.join(layer.dir, `${name}.md`), "utf-8")));
				} catch {
					return text(`No memory named ${name}.`);
				}
			}

			if (params.action === "delete") {
				if (!name) return text("delete requires name.");
				const layer = locate(name, params.scope);
				if (!layer) return text(`No memory named ${name}.`);
				// Read the index before removing anything: refusing on a failed read must
				// leave both the file and the index as they were.
				let index: string;
				try {
					index = readIndex(layer);
				} catch (error) {
					return text(
						`Memory delete failed: ${error instanceof Error ? error.message : String(error)}. Nothing was deleted.`,
					);
				}
				fs.rmSync(path.join(layer.dir, `${name}.md`), { force: true });
				const remaining = removeIndexLine(index, name);
				if (stripNonLoaded(remaining).trim()) writeIndex(layer, remaining);
				else fs.rmSync(indexPath(layer), { force: true });
				return text(`Deleted ${layer.scope} memory ${name}.`);
			}

			if (params.action === "check") {
				const targets = params.scope ? [resolveTarget(params.scope, false)] : [layers.global, layers.project];
				const report = targets.map((layer) => {
					const { missing, orphans } = checkLayer(layer);
					const where = layer.scope === "global" ? "global" : `project (${layer.subject})`;
					if (!missing.length && !orphans.length) {
						const n = entryNames(readIndexQuietly(layer)).length;
						return `${where}: ${n} ${n === 1 ? "memory" : "memories"}, index and files agree.`;
					}
					const lines = [`${where}:`];
					if (missing.length) lines.push(`  indexed but no file: ${missing.join(", ")}`);
					if (orphans.length) lines.push(`  file but not indexed: ${orphans.join(", ")}`);
					lines.push(`  store: ${layer.dir}`);
					lines.push(`  fix with action "reindex" (rebuilds the index from the files).`);
					return lines.join("\n");
				});
				return text(report.join("\n"));
			}

			if (params.action === "reindex") {
				const targets = params.scope ? [resolveTarget(params.scope, false)] : [layers.global, layers.project];
				const report = targets.map((layer) => {
					const { added, removed, total } = reindexLayer(layer);
					const where = layer.scope === "global" ? "global" : `project (${layer.subject})`;
					const changes = [
						added.length ? `recovered ${added.length} (${added.join(", ")})` : "",
						removed.length ? `dropped ${removed.length} dead ${removed.length === 1 ? "line" : "lines"} (${removed.join(", ")})` : "",
					].filter(Boolean);
					return `${where}: ${total} ${total === 1 ? "memory" : "memories"} indexed${changes.length ? `, ${changes.join(", ")}` : ", nothing to fix"}.`;
				});
				return text(report.join("\n"));
			}

			const listing = [layers.global, layers.project]
				.map((layer) => {
					const index = stripNonLoaded(readIndexQuietly(layer)).trim();
					const where = layer.scope === "global" ? "### Everywhere" : `### ${layer.subject}`;
					return index ? `${where}\n\n${index}` : "";
				})
				.filter(Boolean);
			return text(listing.join("\n\n") || "No memories saved yet.");
		},
	});
}
