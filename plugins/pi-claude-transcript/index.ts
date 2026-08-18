/**
 * pi-claude-transcript — a Claude-Code-style compact transcript for pi and omp.
 *
 * A fork of pi-compact-transcript (MIT, avhagedorn) — see LICENSE and README.
 *
 * What it adds over the transcript you get by default:
 * - A summary line after EVERY turn ("✻ Thought for 2s · searched 1 pattern ·
 *   ran 1 shell command"), not one summary at the end of the agentic loop.
 * - The thought ticker from upstream (the "↳ <thinking headline>" line);
 *   thinking time ALSO totals up in the turn summary.
 * - `edit` and `write` keep the host's ORIGINAL renderer, so file diffs and
 *   written content stay visible. Same for any result carrying an image.
 * - Finished tool rows are HIDDEN by default — a turn leaves only its ✻ summary
 *   behind (rows stay visible while running, and failures stay). alt+t toggles
 *   the hidden rows back; ctrl+o still expands any single row.
 * - MCP calls are summarized by server ("called github ×2").
 *
 * ENGINES. Row compaction works by wrapping the host's transcript components,
 * which only pi exposes; omp keeps its own fields hard-private and gives
 * extensions no transcript access. So:
 *   pi  — everything above.
 *   omp — the ✻ turn summaries. Pair them with omp's own
 *         `display.hideToolActivity: true` for the same overall shape.
 * Nothing is patched unless the host actually offers the seam, so loading this
 * on an unknown build degrades to summaries instead of failing.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";

// ── engine resolution ───────────────────────────────────────────────────────
// The host package differs per engine (pi vs omp) and its transcript component
// classes are not part of either published extension API, so everything host-
// specific is imported at runtime and every use is guarded. A missing piece
// costs a feature, never a crash.

type AnyCtor = new (...args: any[]) => any;

const AGENT_PACKAGES = ["@earendil-works/pi-coding-agent", "@oh-my-pi/pi-coding-agent"];
const TUI_PACKAGES = ["@earendil-works/pi-tui", "@oh-my-pi/pi-tui"];

let Text: AnyCtor | undefined;
let Markdown: AnyCtor | undefined;
let Spacer: AnyCtor | undefined;
let ToolExecutionComponent: { prototype: any } | undefined;
let AssistantMessageComponent: { prototype: any } | undefined;

async function importFirst(specifiers: string[], has: (mod: any) => boolean): Promise<any> {
	for (const specifier of specifiers) {
		try {
			const mod = await import(specifier);
			if (has(mod)) return mod;
		} catch {
			// not this engine — try the next specifier
		}
	}
	return undefined;
}

let enginePromise: Promise<void> | undefined;

function resolveEngine(): Promise<void> {
	enginePromise ??= (async () => {
		const tui = await importFirst(TUI_PACKAGES, (m) => typeof m?.Text === "function");
		if (tui) {
			Text = tui.Text;
			Markdown = tui.Markdown;
			Spacer = tui.Spacer;
		}
		const agent = await importFirst(AGENT_PACKAGES, (m) => typeof m?.ToolExecutionComponent === "function");
		if (agent) {
			ToolExecutionComponent = agent.ToolExecutionComponent;
			AssistantMessageComponent = agent.AssistantMessageComponent;
		}
	})();
	return enginePromise;
}

const SUMMARY_ENTRY_TYPE = "claude-transcript-turn-summary";

const MIN_PREVIEW_WIDTH = 20;
const MAX_PREVIEW_WIDTH = 104;
const PREVIEW_MARGIN = 6;
const BLINK_INTERVAL_MS = 400;
const MARKER_WIDTH = 2;

// Tools that keep pi's original (full) renderer — diffs must stay visible.
const FULL_RENDER_TOOLS = new Set(["edit", "write"]);

type ToolInfo = {
	id: string;
	name: string;
	args: any;
	preview: string;
	hidden?: boolean;
	running?: boolean;
	burstCount?: number;
	startedAt?: number;
	durationMs?: number;
	burstDurationMs?: number;
	result?: string;
	isError?: boolean;
	invalidate?: () => void;
};

type TurnStats = {
	thinkingMs: number;
	thinkingStartedAt?: number;
	searches: number;
	commands: number;
	readFiles: Set<string>;
	editFiles: Set<string>;
	named: Record<string, number>;
	failed: number;
};

type SummaryData = {
	thinkingMs: number;
	searches: number;
	commands: number;
	reads: number;
	edits: number;
	named: Record<string, number>;
	failed: number;
};

type RuntimeState = {
	turnHadText: boolean;
	toolsById: Map<string, ToolInfo>;
	currentBurst: ToolInfo[];
	runningToolIds: Set<string>;
	blinkOn: boolean;
	blinkTimer?: ReturnType<typeof setInterval>;
	turnStats: TurnStats;
	currentTheme?: Theme;
	rowsVisible: boolean;
	toolComponents: Set<any>;
	thinkingHidden: boolean;
	currentThoughtHeading?: string;
	thoughtAnchorId?: string;
};

const STATE_KEY = Symbol.for("claude-transcript.state");
const TOOL_PATCH_KEY = Symbol.for("claude-transcript.tool-patch");
const ASSISTANT_PATCH_KEY = Symbol.for("claude-transcript.assistant-patch");

function newTurnStats(): TurnStats {
	return {
		thinkingMs: 0,
		searches: 0,
		commands: 0,
		readFiles: new Set(),
		editFiles: new Set(),
		named: {},
		failed: 0,
	};
}

function getState(): RuntimeState {
	const g = globalThis as typeof globalThis & { [STATE_KEY]?: RuntimeState };
	g[STATE_KEY] ??= {
		turnHadText: false,
		toolsById: new Map(),
		currentBurst: [],
		runningToolIds: new Set(),
		blinkOn: true,
		turnStats: newTurnStats(),
		rowsVisible: false,
		toolComponents: new Set(),
		thinkingHidden: true,
	};
	return g[STATE_KEY]!;
}

const state = getState();

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function shortenPath(path: unknown): string {
	if (typeof path !== "string" || !path) return "";
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function oneLine(value: unknown): string {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

function previewWidth(base = process.stdout.columns || 100): number {
	return Math.max(MIN_PREVIEW_WIDTH, Math.min(MAX_PREVIEW_WIDTH, base - PREVIEW_MARGIN));
}

function limitPlain(text: string, max = previewWidth()): string {
	const clean = oneLine(text);
	if (clean.length <= max) return clean;
	return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function quote(s: string): string {
	return JSON.stringify(s);
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value ?? {});
	} catch {
		return String(value);
	}
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 1000) return "";
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
}

const PREFERRED_ARG_KEYS = [
	"command",
	"code",
	"query",
	"pattern",
	"path",
	"file_path",
	"filePath",
	"file",
	"url",
	"prompt",
	"text",
	"description",
	"name",
];
const PATH_ARG_KEYS = new Set(["path", "file_path", "filePath", "file"]);

function previewFor(name: string, args: any): string {
	switch (name) {
		case "bash":
			return `$ ${oneLine(args?.command || "...")}`;
		case "read": {
			let out = `read ${shortenPath(args?.path) || "..."}`;
			if (args?.offset !== undefined || args?.limit !== undefined) {
				const start = args.offset ?? 1;
				const end = args.limit !== undefined ? start + args.limit - 1 : "";
				out += `:${start}${end ? `-${end}` : ""}`;
			}
			return out;
		}
		case "grep": {
			const pattern = args?.pattern ? quote(String(args.pattern)) : "...";
			const path = shortenPath(args?.path) || ".";
			return `grep ${pattern} ${path}${args?.glob ? ` (${args.glob})` : ""}`;
		}
		case "find":
			return `find ${args?.pattern ? quote(String(args.pattern)) : "..."} ${shortenPath(args?.path) || "."}`;
		case "ls":
			return `ls ${shortenPath(args?.path) || "."}`;
		default: {
			if (args && typeof args === "object") {
				for (const key of PREFERRED_ARG_KEYS) {
					const value = (args as Record<string, unknown>)[key];
					if (isNonEmptyString(value)) {
						const rendered = PATH_ARG_KEYS.has(key) ? shortenPath(value) : oneLine(value);
						return `${name} ${rendered}`;
					}
				}
				const firstString = Object.values(args).find(isNonEmptyString);
				if (firstString) return `${name} ${oneLine(firstString)}`;
			}
			return `${name} ${safeJson(args ?? {})}`;
		}
	}
}

function resultPreview(result: any, isPartial = false): string {
	const text = Array.isArray(result?.content)
		? result.content.find((c: any) => c?.type === "text" && typeof c.text === "string")?.text
		: undefined;
	if (!text) return isPartial ? "running" : "";
	const lines = String(text).trim().split("\n").filter(Boolean);
	if (lines.length === 0) return isPartial ? "running" : "";
	if (lines.length === 1) return lines[0];
	return `${lines.length} lines`;
}

function resetToolRun() {
	state.toolsById = new Map();
	state.currentBurst = [];
	state.runningToolIds = new Set();
	state.currentThoughtHeading = undefined;
	state.thoughtAnchorId = undefined;
	stopBlinkTimer();
}

function captureTheme(ctx: ExtensionContext) {
	state.currentTheme = ctx.ui.theme;
}

function applyResult(info: ToolInfo, result: any, isError: boolean, isPartial: boolean) {
	const suffix = resultPreview(result, isPartial);
	if (suffix) info.result = suffix;
	if (isError) {
		info.isError = true;
		info.burstCount = 1;
		info.hidden = false;
	}
}

function ensureBlinkTimer() {
	if (state.blinkTimer || state.runningToolIds.size === 0) return;
	state.blinkTimer = setInterval(() => {
		if (state.runningToolIds.size === 0) {
			stopBlinkTimer();
			return;
		}
		state.blinkOn = !state.blinkOn;
		for (const id of state.runningToolIds) state.toolsById.get(id)?.invalidate?.();
	}, BLINK_INTERVAL_MS);
	state.blinkTimer.unref?.();
}

function stopBlinkTimer() {
	if (state.blinkTimer) clearInterval(state.blinkTimer);
	state.blinkTimer = undefined;
	state.blinkOn = true;
}

function statusMarker(theme: Theme, opts: { running?: boolean; isError?: boolean; hasResult?: boolean }): string {
	if (opts.isError) return theme.fg("error", "◆ ");
	if (opts.running) return theme.fg("dim", state.blinkOn ? "◆ " : "◇ ");
	if (opts.hasResult) return theme.fg("success", "◆ ");
	return theme.fg("dim", "◆ ");
}

// ── thought ticker (from upstream): live thinking headline under the newest
// visible tool row while thinking blocks are hidden ─────────────────────────

function thoughtTickerEnabled(): boolean {
	return state.thinkingHidden;
}

function cleanThoughtHeading(line: string): string {
	let clean = oneLine(line)
		.replace(/^#{1,6}\s+/, "")
		.replace(/^[-*]\s+/, "")
		.trim();
	clean = clean
		.replace(/^\*\*(.+)\*\*$/, "$1")
		.replace(/^__(.+)__$/, "$1")
		.replace(/^`(.+)`$/, "$1");
	return clean.trim();
}

function extractThoughtHeading(text: unknown): string {
	if (typeof text !== "string") return "";
	const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0);
	return firstLine ? cleanThoughtHeading(firstLine) : "";
}

function latestThoughtHeading(message: any): string {
	if (!Array.isArray(message?.content)) return "";
	for (let i = message.content.length - 1; i >= 0; i--) {
		const content = message.content[i];
		if (content?.type === "thinking") return extractThoughtHeading(content.thinking);
	}
	return "";
}

function invalidateToolById(id: string | undefined) {
	if (!id) return;
	state.toolsById.get(id)?.invalidate?.();
}

function latestVisibleTool(): ToolInfo | undefined {
	return Array.from(state.toolsById.values())
		.reverse()
		.find((tool) => !tool.hidden);
}

function clearCurrentThought() {
	if (!state.currentThoughtHeading && !state.thoughtAnchorId) return;
	const previousAnchorId = state.thoughtAnchorId;
	state.currentThoughtHeading = undefined;
	state.thoughtAnchorId = undefined;
	invalidateToolById(previousAnchorId);
}

function setCurrentThought(heading: string) {
	const nextHeading = oneLine(heading);
	if (!thoughtTickerEnabled() || !nextHeading) {
		clearCurrentThought();
		return;
	}
	const previousAnchorId = state.thoughtAnchorId;
	const nextAnchorId = latestVisibleTool()?.id;
	const changed = state.currentThoughtHeading !== nextHeading || previousAnchorId !== nextAnchorId;
	state.currentThoughtHeading = nextHeading;
	state.thoughtAnchorId = nextAnchorId;
	if (!changed) return;
	invalidateToolById(previousAnchorId);
	if (nextAnchorId !== previousAnchorId) invalidateToolById(nextAnchorId);
}

function updateCurrentThoughtFromMessage(message: any) {
	const heading = latestThoughtHeading(message);
	if (heading) setCurrentThought(heading);
}

function anchorCurrentThoughtTo(info: ToolInfo) {
	if (!thoughtTickerEnabled() || !state.currentThoughtHeading || state.thoughtAnchorId === info.id) return;
	const previousAnchorId = state.thoughtAnchorId;
	state.thoughtAnchorId = info.id;
	invalidateToolById(previousAnchorId);
	info.invalidate?.();
}

function currentThoughtLine(toolCallId: string, theme: Theme): string {
	if (!thoughtTickerEnabled() || state.thoughtAnchorId !== toolCallId || !state.currentThoughtHeading) return "";
	const prefix = "  ↳ ";
	const budget = previewWidth((process.stdout.columns || 100) - prefix.length);
	return theme.fg("dim", prefix) + theme.fg("thinkingText", limitPlain(state.currentThoughtHeading, budget));
}

function upsertToolInfo(id: string, name: string, args: any, invalidate?: () => void): ToolInfo {
	let info = state.toolsById.get(id);
	if (!info) {
		info = { id, name, args, preview: previewFor(name, args) };
		state.toolsById.set(id, info);
	}
	info.name = name;
	info.args = args;
	info.preview = previewFor(name, args);
	if (invalidate) info.invalidate = invalidate;
	return info;
}

function recordToolStart(name: string, args: any) {
	const base = name.split(".").pop() ?? name;
	const stats = state.turnStats;
	if (base === "read") {
		if (isNonEmptyString(args?.path)) stats.readFiles.add(args.path);
	} else if (base === "edit" || base === "write") {
		if (isNonEmptyString(args?.path)) stats.editFiles.add(args.path);
	} else if (base === "bash") {
		stats.commands++;
	} else if (base === "grep" || base === "find" || base === "ls") {
		stats.searches++;
	} else {
		const label = toolLabel(base, args);
		stats.named[label] = (stats.named[label] ?? 0) + 1;
	}
}

// Human label for non-core tools. pi-mcp-adapter registers three shapes:
// a "mcp" proxy tool (target in args.tool), direct tools named
// "<server>_<tool>", and an "mcpScript" batcher.
const MCP_SERVER_PREFIXES = new Set<string>();

function toolLabel(base: string, args: any): string {
	if (base === "mcpScript") return "ran an MCP script";
	if (base === "mcp") {
		const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
		// Only explicit identifiers name a server; free-text args (search
		// queries etc.) must not leak into the label.
		const target = [a.tool, a.describe, a.server].find(isNonEmptyString);
		if (target) {
			const server = oneLine(target).split("_")[0];
			MCP_SERVER_PREFIXES.add(server);
			return `called ${server}`;
		}
		return "called mcp";
	}
	// Direct MCP tools carry the server as their name prefix; recognize servers
	// we have seen via the proxy, plus the common "<server>_<verb>_" shape when
	// the prefix looks server-ish (contains a dash, like "my-server").
	const prefix = base.split("_")[0];
	if (MCP_SERVER_PREFIXES.has(prefix) || (base.includes("_") && prefix.includes("-"))) {
		MCP_SERVER_PREFIXES.add(prefix);
		return `called ${prefix}`;
	}
	return `used ${base}`;
}

function joinBurst(info: ToolInfo) {
	if (state.currentBurst.length && state.currentBurst[state.currentBurst.length - 1].name !== info.name) {
		state.currentBurst = [];
	}
	const previous = state.currentBurst[state.currentBurst.length - 1];
	if (!state.currentBurst.some((tool) => tool.id === info.id)) state.currentBurst.push(info);
	for (const tool of state.currentBurst.slice(0, -1)) tool.hidden = true;
	info.burstCount = state.currentBurst.length;
	previous?.invalidate?.();
}

function beginTool(id: string, name: string, args: any) {
	const info = upsertToolInfo(id, name, args);
	info.hidden = false;
	info.burstCount = 1;
	info.running = true;
	info.isError = false;
	info.startedAt = Date.now();
	state.runningToolIds.add(id);
	ensureBlinkTimer();
	recordToolStart(name, args);
	// Full-render tools stand alone; they never join or continue a burst.
	if (FULL_RENDER_TOOLS.has(name.split(".").pop() ?? name)) {
		state.currentBurst = [];
	} else {
		joinBurst(info);
	}
	anchorCurrentThoughtTo(info);
	info.invalidate?.();
}

function hydrateTool(id: string, name: string, args: any, isError: boolean): ToolInfo {
	const info = upsertToolInfo(id, name, args);
	info.hidden = false;
	info.burstCount = 1;
	if (isError) {
		info.isError = true;
		state.currentBurst = [];
		return info;
	}
	if (FULL_RENDER_TOOLS.has(name.split(".").pop() ?? name)) {
		state.currentBurst = [];
	} else {
		joinBurst(info);
	}
	return info;
}

function updateToolResult(toolCallId: string, result: any, isError = false, isPartial = false) {
	if (!isPartial) {
		state.runningToolIds.delete(toolCallId);
		if (state.runningToolIds.size === 0) stopBlinkTimer();
	}
	const info = state.toolsById.get(toolCallId);
	if (!info) return;
	if (!isPartial) {
		info.running = false;
		if (info.startedAt) info.durationMs = Date.now() - info.startedAt;
		if (state.currentBurst.includes(info) && state.currentBurst.length > 1) {
			info.burstDurationMs = state.currentBurst.reduce((total, tool) => total + (tool.durationMs ?? 0), 0);
		}
		if (isError) state.turnStats.failed++;
	}
	applyResult(info, result, isError, isPartial);
	if (isError) state.currentBurst = [];
	info.invalidate?.();
}

function compactToolLine(
	toolCallId: string,
	name: string,
	args: any,
	theme: Theme,
	invalidate?: () => void,
	result?: any,
	isError = false,
	isPartial = false,
): string {
	if (!state.toolsById.has(toolCallId)) hydrateTool(toolCallId, name, args, isError);
	const info = upsertToolInfo(toolCallId, name, args, invalidate);
	applyResult(info, result, isError, isPartial);
	if (info.hidden) return "";

	const isBurst = (info.burstCount ?? 1) > 1;
	const durationText = formatDuration((isBurst ? (info.burstDurationMs ?? info.durationMs) : info.durationMs) ?? 0);
	const inner = [info.result ? oneLine(info.result) : "", durationText].filter(Boolean).join(" · ");
	const status = inner ? ` {${inner}}` : info.running ? " {running}" : "";
	const details = `${info.preview}${status}`;
	const marker = statusMarker(theme, {
		running: info.running,
		isError: info.isError,
		hasResult: result != null || !!info.result,
	});
	if (!isBurst) {
		return marker + theme.fg("muted", limitPlain(details));
	}

	const prefix = `${info.burstCount}× `;
	const budget = previewWidth((process.stdout.columns || 100) - prefix.length - MARKER_WIDTH);
	return marker + theme.fg("muted", prefix + limitPlain(details, budget));
}

function patchToolExecutionComponent() {
	if (!ToolExecutionComponent || !Text) return;
	const proto = ToolExecutionComponent.prototype as any;
	if (typeof proto.updateDisplay !== "function" || typeof proto.render !== "function") return;
	const existing = proto[TOOL_PATCH_KEY] as
		| { originalUpdateDisplay: (...args: any[]) => any; originalRender: (...args: any[]) => any }
		| undefined;
	const originalUpdateDisplay = existing?.originalUpdateDisplay ?? proto.updateDisplay;
	const originalRender = existing?.originalRender ?? proto.render;

	proto.updateDisplay = function patchedUpdateDisplay() {
		if (!this.toolCallId || !this.toolName || !this.selfRenderContainer || typeof this.selfRenderContainer.clear !== "function") {
			this.__claudeTranscriptForceSelf = false;
			this.__claudeTranscriptHidden = false;
			return originalUpdateDisplay.call(this);
		}

		state.toolComponents.add(this);
		const invalidate = () => {
			this.invalidate();
			this.ui?.requestRender?.();
		};
		if (!state.toolsById.has(this.toolCallId)) {
			hydrateTool(this.toolCallId, this.toolName, this.args, this.result?.isError ?? false);
		}
		const info = upsertToolInfo(this.toolCallId, this.toolName, this.args, invalidate);
		applyResult(info, this.result, this.result?.isError ?? false, this.isPartial);

		// Diffs stay: edit/write (and anything expanded via ctrl+o) render with
		// pi's own component. Same for any result carrying an image — the compact
		// path would destroy the image components.
		const baseName = (this.toolName.split(".").pop() ?? this.toolName) as string;
		const hasImage =
			Array.isArray(this.result?.content) && this.result.content.some((c: any) => c?.type === "image");
		if (this.expanded || FULL_RENDER_TOOLS.has(baseName) || hasImage) {
			info.hidden = false;
			this.__claudeTranscriptForceSelf = false;
			this.__claudeTranscriptHidden = false;
			return originalUpdateDisplay.call(this);
		}

		this.__claudeTranscriptForceSelf = true;
		this.__claudeTranscriptHidden = false;
		this.selfRenderContainer.clear();
		for (const image of this.imageComponents ?? []) this.removeChild?.(image);
		for (const spacer of this.imageSpacers ?? []) this.removeChild?.(spacer);
		this.imageComponents = [];
		this.imageSpacers = [];

		const theme = state.currentTheme;
		if (!theme) {
			this.__claudeTranscriptForceSelf = false;
			this.__claudeTranscriptHidden = false;
			return originalUpdateDisplay.call(this);
		}

		const line = compactToolLine(
			this.toolCallId,
			this.toolName,
			this.args,
			theme,
			invalidate,
			this.result,
			this.result?.isError ?? false,
			this.isPartial,
		);

		// Row policy: visible while running or failed; once finished, the turn
		// summary replaces it (alt+t brings hidden rows back).
		const rowInfo = state.toolsById.get(this.toolCallId);
		const showRow = state.rowsVisible || rowInfo?.running || rowInfo?.isError;
		if (!line || !showRow) {
			this.__claudeTranscriptHidden = true;
			return;
		}

		this.selfRenderContainer.addChild(new Text!(line, 0, 0));
		const thoughtLine = currentThoughtLine(this.toolCallId, theme);
		if (thoughtLine) this.selfRenderContainer.addChild(new Text!(thoughtLine, 0, 0));
	};

	proto.render = function patchedRender(width: number) {
		if (this.hideComponent || this.__claudeTranscriptHidden) return [];
		if (this.__claudeTranscriptForceSelf) return this.selfRenderContainer.render(width);
		return originalRender.call(this, width);
	};

	proto[TOOL_PATCH_KEY] = { originalUpdateDisplay, originalRender };
}

function patchAssistantMessageComponent() {
	if (!AssistantMessageComponent || !Markdown || !Spacer) return;
	const proto = AssistantMessageComponent.prototype as any;
	if (typeof proto.updateContent !== "function") return;
	const existing = proto[ASSISTANT_PATCH_KEY] as { originalUpdateContent: (...args: any[]) => any } | undefined;
	const originalUpdateContent = existing?.originalUpdateContent ?? proto.updateContent;

	proto.updateContent = function patchedUpdateContent(message: any) {
		state.thinkingHidden = !!this.hideThinkingBlock;
		if (!state.thinkingHidden) clearCurrentThought();
		if (!this.hideThinkingBlock || !Array.isArray(message?.content)) {
			return originalUpdateContent.call(this, message);
		}
		if (!this.contentContainer || typeof this.contentContainer.clear !== "function") {
			return originalUpdateContent.call(this, message);
		}

		this.lastMessage = message;
		this.contentContainer.clear();
		this.hasToolCalls = message.content.some((c: any) => c.type === "toolCall");

		const texts = message.content.filter((c: any) => c.type === "text" && c.text?.trim());
		if (texts.length === 0) return;

		clearCurrentThought();
		state.currentBurst = [];

		this.contentContainer.addChild(new Spacer!(1));
		for (const content of texts) {
			this.contentContainer.addChild(new Markdown!(content.text.trim(), this.outputPad, 0, this.markdownTheme));
		}
	};

	proto[ASSISTANT_PATCH_KEY] = { originalUpdateContent };
}

// ── per-turn summary ────────────────────────────────────────────────────────

function summaryLine(data: SummaryData): string {
	const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
	const parts: string[] = [];
	const thought = formatDuration(data.thinkingMs);
	if (thought) parts.push(`Thought for ${thought}`);
	if (data.searches) parts.push(`searched ${plural(data.searches, "pattern")}`);
	if (data.reads) parts.push(`read ${plural(data.reads, "file")}`);
	if (data.edits) parts.push(`updated ${plural(data.edits, "file")}`);
	if (data.commands) parts.push(`ran ${plural(data.commands, "shell command")}`);
	for (const [label, count] of Object.entries(data.named)) {
		parts.push(count > 1 ? `${label} ×${count}` : label);
	}
	if (data.failed) parts.push(`${data.failed} failed`);
	if (parts.length === 0) return "";
	const text = parts.join(" · ");
	return text[0].toUpperCase() + text.slice(1);
}

function normalizeSummary(input: unknown): SummaryData {
	const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
	const named: Record<string, number> = {};
	if (source.named && typeof source.named === "object") {
		for (const [k, v] of Object.entries(source.named as Record<string, unknown>)) {
			if (num(v)) named[k] = num(v);
		}
	}
	return {
		thinkingMs: num(source.thinkingMs),
		searches: num(source.searches),
		commands: num(source.commands),
		reads: num(source.reads),
		edits: num(source.edits),
		named,
		failed: num(source.failed),
	};
}

function appendTurnSummary(pi: ExtensionAPI) {
	const stats = state.turnStats;
	const data: SummaryData = {
		thinkingMs: stats.thinkingMs,
		searches: stats.searches,
		commands: stats.commands,
		reads: stats.readFiles.size,
		edits: stats.editFiles.size,
		named: stats.named,
		failed: stats.failed,
	};
	const hasAnything =
		data.thinkingMs >= 1000 ||
		data.searches ||
		data.commands ||
		data.reads ||
		data.edits ||
		data.failed ||
		Object.keys(data.named).length > 0;
	if (!hasAnything) return;
	pi.appendEntry(SUMMARY_ENTRY_TYPE, data);
}

function trackThinking(eventType: string | undefined) {
	const stats = state.turnStats;
	if (eventType === "thinking_start") {
		stats.thinkingStartedAt ??= Date.now();
	} else if (eventType === "thinking_end" || eventType === "text_start" || eventType === "toolcall_start") {
		if (stats.thinkingStartedAt) {
			stats.thinkingMs += Date.now() - stats.thinkingStartedAt;
			stats.thinkingStartedAt = undefined;
		}
	}
}

function refreshToolRows() {
	let ui: any;
	for (const component of state.toolComponents) {
		try {
			component.invalidate?.();
			ui ??= component.ui;
		} catch {
			state.toolComponents.delete(component);
		}
	}
	ui?.requestRender?.();
}

export default function claudeTranscript(pi: ExtensionAPI) {
	// Host classes load asynchronously; patch as soon as they are here. A tool
	// row cannot render before the first model round trip, so this always wins
	// the race — and session_start awaits it anyway.
	const ready = resolveEngine().then(() => {
		patchToolExecutionComponent();
		patchAssistantMessageComponent();
	});

	pi.registerShortcut("alt+t", {
		description: "claude-transcript: toggle hidden tool rows",
		handler: async (ctx) => {
			state.rowsVisible = !state.rowsVisible;
			refreshToolRows();
			ctx.ui.notify(`tool rows: ${state.rowsVisible ? "shown" : "hidden"}`, "info");
		},
	});

	// pi renders appended entries through registerEntryRenderer; omp exposes the
	// same seam as registerMessageRenderer. Register whichever exists.
	const host = pi as unknown as {
		registerEntryRenderer?: (type: string, renderer: (entry: any, options: any, theme: Theme) => any) => void;
		registerMessageRenderer?: (type: string, renderer: (entry: any, options: any, theme: Theme) => any) => void;
	};
	// pi puts the payload on `data`; omp's custom-message shape uses `details`.
	const renderSummary = (entry: { data?: unknown; details?: unknown }, _options: unknown, theme: Theme) => {
		if (!Text) return undefined;
		const line = summaryLine(normalizeSummary(entry.data ?? entry.details));
		if (!line) return undefined;
		return new Text(theme.fg("dim", `✻ ${line}`), 0, 0);
	};
	const registerRenderer = host.registerEntryRenderer ?? host.registerMessageRenderer;
	registerRenderer?.call(pi, SUMMARY_ENTRY_TYPE, renderSummary);

	pi.on("session_start", async (_event, ctx) => {
		await ready;
		captureTheme(ctx);
		resetToolRun();
		state.turnStats = newTurnStats();
		state.toolComponents = new Set();
	});

	pi.on("session_shutdown", async () => {
		stopBlinkTimer();
	});

	pi.on("agent_start", (_event, ctx) => {
		captureTheme(ctx);
		resetToolRun();
		state.turnStats = newTurnStats();
	});

	pi.on("agent_end", () => {
		appendTurnSummary(pi);
		state.turnStats = newTurnStats();
		clearCurrentThought();
		state.currentBurst = [];
		state.runningToolIds.clear();
		stopBlinkTimer();
	});

	pi.on("turn_start", (_event, ctx) => {
		captureTheme(ctx);
		state.turnHadText = false;
	});

	pi.on("turn_end", () => {
		trackThinking("thinking_end"); // close any open thinking span
		// Silent turns (tools only, no prose) accumulate; the summary flushes on
		// the next turn that actually says something — or at agent_end.
		if (state.turnHadText) {
			appendTurnSummary(pi);
			state.turnStats = newTurnStats();
		}
		clearCurrentThought();
		state.currentBurst = [];
	});

	pi.on("message_update", (event, ctx) => {
		captureTheme(ctx);
		trackThinking(event.assistantMessageEvent?.type);
		const type = event.assistantMessageEvent?.type;
		if (typeof type === "string" && type.startsWith("thinking_")) {
			updateCurrentThoughtFromMessage(event.message);
		}
		if (
			(type === "text_delta" && isNonEmptyString(event.assistantMessageEvent?.delta)) ||
			(type === "text_end" && isNonEmptyString(event.assistantMessageEvent?.content))
		) {
			state.turnHadText = true;
			clearCurrentThought();
			state.currentBurst = [];
		}
	});

	pi.on("tool_execution_start", (event, ctx) => {
		captureTheme(ctx);
		beginTool(event.toolCallId, event.toolName, event.args);
	});

	pi.on("tool_execution_update", (event, ctx) => {
		captureTheme(ctx);
		updateToolResult(event.toolCallId, event.partialResult, false, true);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		captureTheme(ctx);
		updateToolResult(event.toolCallId, event.result, event.isError, false);
	});
}
