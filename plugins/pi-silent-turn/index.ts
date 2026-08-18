/**
 * pi-silent-turn — let an agent end a background turn without answering.
 *
 * Bridges, schedulers and peer extensions can start a turn nobody asked for: a
 * relayed status report, a cron tick, a message from another session. With
 * proactive push enabled, whatever the agent says at the end of such a turn is
 * delivered to the user — so the only way to stay quiet is to produce no final
 * text at all, which a model cannot reliably do by "saying nothing".
 *
 * `end_turn_silently` gives it a real exit: the turn is aborted from inside the
 * tool, so the run ends with no completed assistant block for a bridge to
 * project. The agent gets a curation gate — read the report, check whether it is
 * a duplicate, then drop it — while genuinely useful results still go out as an
 * ordinary reply.
 *
 * Investigate first if you need to: tool calls are not delivered to anyone, so
 * the agent can read, search and compare before deciding. Only completed TEXT
 * blocks get projected, so the rule is simply not to write prose before calling
 * this.
 *
 * IT REFUSES ON USER-FACING TURNS. A turn that began with an input event (typed
 * in the terminal, or delivered by a bridge as a user message) is a question
 * someone is waiting on, and silence there is a bug, not curation. Background
 * turns arrive as custom messages instead and fire no input event, which is what
 * this distinguishes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

export default function silentTurn(pi: ExtensionAPI) {
	// An input event precedes the agent run it starts, so this is true for the
	// whole of a user-facing turn and false for one a message triggered.
	let userFacingTurn = false;
	let lastSilentReason: string | undefined;

	pi.on("input", async () => {
		userFacingTurn = true;
	});

	pi.on("agent_end", async () => {
		userFacingTurn = false;
	});

	pi.registerTool({
		name: "end_turn_silently",
		label: "End turn silently",
		description:
			"End THIS turn without replying, for background work the user does not need to hear about: a relayed report that duplicates something they already know, a scheduled check with nothing to say, a peer message needing no action. Investigate first if you need to — reading files, searching memory and other tool calls are never delivered — but do not write any prose before calling this, since completed text can already be on its way. It refuses on turns the user started; answer those normally.",
		parameters: Type.Object({
			reason: Type.String({
				description: "Why this turn is not worth surfacing. Recorded locally, never sent to the user.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (userFacingTurn) {
				return {
					content: [
						{
							type: "text",
							text: "Refused: this turn came from the user, so it needs an answer. end_turn_silently is only for turns started by a message, a schedule or another session.",
						},
					],
					details: {},
					isError: true,
				};
			}

			lastSilentReason = params.reason.trim() || "(no reason given)";
			(ctx.ui as { setStatus?: (key: string, text: string | undefined) => void }).setStatus?.(
				"silent-turn",
				undefined,
			);
			// The abort is the point: it ends the run before a final assistant block
			// exists, which is what stops a bridge from projecting anything. Returning
			// a "done" result would not — the model would still get another turn to
			// speak.
			ctx.abort();
			return {
				content: [{ type: "text", text: `Turn ended silently: ${lastSilentReason}` }],
				details: {},
			};
		},
	});

	pi.registerCommand("silent-turn-last", {
		description: "Show why the last turn was ended silently",
		handler: async (_args, commandCtx) => {
			commandCtx.ui.notify(
				lastSilentReason ? `Last silent turn: ${lastSilentReason}` : "No turn has been ended silently yet.",
				"info",
			);
		},
	});
}
