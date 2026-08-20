/**
 * pi-telegram-thinking — live thinking on Telegram that cleans up after itself.
 *
 * pi-telegram can show provider thinking (`assistant.activity: "thinking"`), but
 * that message is persistent by design: it stays in the chat under the answer,
 * forever. On a phone, thinking is useful exactly while you are waiting and
 * clutter the moment the answer lands.
 *
 * So this owns the thinking message instead: send on the first reasoning delta,
 * edit as it grows, delete when the run settles. Nothing is forked or patched —
 * the Activity API is pi-telegram's documented companion surface, and the handler
 * context hands over target-bound send/edit/delete.
 *
 * `agent-settled` is the delete trigger rather than `agent-end`: it is the only
 * boundary that is after automatic retries, compaction and queued continuations,
 * so a retried turn does not lose its thinking mid-flight.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Types only: these are erased, so they cost nothing at runtime and cannot fail
// to resolve on a host that does not have pi-telegram at all.
import type {
  TelegramActivityContext,
  TelegramActivityEvent,
  TelegramActivityHandlerRegistration,
} from "@llblab/pi-telegram/activity";
import type { TelegramDeliveryHandle } from "@llblab/pi-telegram/delivery";
import { homedir } from "node:os";
import path from "node:path";

/** Telegram rejects an edit whose text is unchanged, and rate-limits chatter. */
const EDIT_INTERVAL_MS = Math.max(500, Number(process.env.PI_TELEGRAM_THINKING_INTERVAL_MS ?? 2000));
/** Telegram's own message ceiling is 4096; leave room for the header. */
const MAX_CHARS = Math.min(3500, Math.max(200, Number(process.env.PI_TELEGRAM_THINKING_MAX_CHARS ?? 900)));
const HEADER = process.env.PI_TELEGRAM_THINKING_HEADER ?? "🧠 thinking";

interface Live {
  handle?: TelegramDeliveryHandle;
  text: string;
  lastRender: string;
  lastEditAt: number;
  /** One flush at a time: edits must not overtake each other on the wire. */
  flushing: boolean;
  /** A send/edit that failed once (blocked bot, deleted chat) stops the rest. */
  broken: boolean;
}

const runs = new Map<string, Live>();

function get(activityId: string): Live {
  let live = runs.get(activityId);
  if (!live) {
    live = { text: "", lastRender: "", lastEditAt: 0, flushing: false, broken: false };
    runs.set(activityId, live);
  }
  return live;
}

/** Tail rather than head: the interesting part of a long reasoning stream is
 *  where it currently is, not where it started. */
function render(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const body = trimmed.length > MAX_CHARS ? `…${trimmed.slice(-MAX_CHARS)}` : trimmed;
  return body ? `${HEADER}\n\n${body}` : HEADER;
}

async function flush(live: Live, ctx: TelegramActivityContext, force: boolean): Promise<void> {
  if (live.broken || live.flushing) return;
  const now = Date.now();
  if (!force && now - live.lastEditAt < EDIT_INTERVAL_MS) return;

  const view = { text: render(live.text) };
  if (view.text === live.lastRender) return;

  live.flushing = true;
  try {
    // Plain text on purpose: a reasoning stream is arbitrary prose and half of a
    // Markdown construct is a delivery error, not a rendering quirk.
    const result = live.handle ? await ctx.edit(live.handle, view) : await ctx.send(view);
    if (!result.ok) {
      // A failed send can still have materialized a message; keeping that handle
      // is what lets the cleanup delete it instead of orphaning it in the chat.
      if (result.partial) live.handle = result.partial;
      live.broken = true;
      return;
    }
    live.handle = result.value;
    live.lastRender = view.text;
    live.lastEditAt = Date.now();
  } catch {
    // Never let a chat problem interfere with the run that is producing the text.
    live.broken = true;
  } finally {
    live.flushing = false;
  }
}

async function clear(activityId: string, ctx: TelegramActivityContext): Promise<void> {
  const live = runs.get(activityId);
  runs.delete(activityId);
  if (!live?.handle) return;
  try {
    await ctx.delete(live.handle);
  } catch {
    // A message we cannot delete is a message the user can delete. Leaving it is
    // strictly better than throwing inside the bridge's dispatch.
  }
}

/**
 * Resolve pi-telegram at runtime instead of importing it statically.
 *
 * How this extension is installed decides whether a bare specifier works. As an
 * npm package it sits next to pi-telegram under the agent's node_modules and
 * resolves normally; installed as a git checkout (`pi install
 * git:github.com/...`) it lives in its own directory with no node_modules beside
 * it, and the same import is MODULE_NOT_FOUND — which pi reports as a failed
 * extension, taking the whole session down with it.
 *
 * So: try the bare specifier, then the agent directory's own package root, and
 * give up quietly. An absent pi-telegram is a perfectly ordinary state (any
 * instance that does not hold the bridge), and it must never cost a boot.
 */
async function loadActivityApi(): Promise<
  { registerTelegramActivityHandler: (r: TelegramActivityHandlerRegistration) => () => void } | undefined
> {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
  const candidates = [
    "@llblab/pi-telegram/activity",
    path.join(agentDir, "npm/node_modules/@llblab/pi-telegram/api/activity.ts"),
  ];
  for (const specifier of candidates) {
    try {
      return await import(specifier);
    } catch {
      // next candidate
    }
  }
  return undefined;
}

export default function telegramThinking(_pi: ExtensionAPI) {
  // Floating on purpose (extension setup is synchronous), so it must swallow
  // everything: an unhandled rejection here is an uncaughtException, and pi exits.
  void install().catch(() => {});
}

async function install(): Promise<void> {
  const api = await loadActivityApi();
  if (!api) return;
  // Throws if the id is taken — a double load is not worth a dead session.
  api.registerTelegramActivityHandler({
    id: "abarisain-telegram-thinking",
    handle: async (event: TelegramActivityEvent, ctx: TelegramActivityContext) => {
      switch (event.type) {
        case "agent-start": {
          runs.delete(event.activityId);
          return;
        }
        case "reasoning-delta": {
          const live = get(event.activityId);
          live.text += event.delta;
          await flush(live, ctx, false);
          return;
        }
        case "reasoning-end": {
          const live = get(event.activityId);
          if (event.text) live.text = event.text;
          await flush(live, ctx, true);
          return;
        }
        // The answer is on its way: the thinking has served its purpose, and
        // removing it here means it disappears as the reply appears rather than
        // one settle-tick later.
        case "assistant-segment": {
          if (event.placement === "final") await clear(event.activityId, ctx);
          return;
        }
        case "agent-settled": {
          await clear(event.activityId, ctx);
          return;
        }
        default:
          return;
      }
    },
  });
}
