/**
 * /handoff — OMP-style session handoff for pi
 *
 * Port of Oh My Pi's (can1357/oh-my-pi) /handoff command to a vanilla pi
 * extension:
 *
 *   1. A oneshot LLM call reads the current session's message history and
 *      writes a structured handoff document (Goal / Progress / Key Decisions /
 *      Critical Context / Next Steps).
 *   2. A brand-new session starts immediately. The old transcript is NOT
 *      carried over — the only context in the new session is the handoff
 *      document, injected as a custom in-context message:
 *
 *        <handoff-context>
 *        ...document...
 *        </handoff-context>
 *
 *        The above is a handoff document from a previous session. Use this
 *        context to continue the work seamlessly.
 *
 *   3. The new session is linked to the old one via parentSession, so the
 *      session tree keeps the history.
 *
 * Persistence note: like any brand-new pi session, the new session file is
 * written only after the first assistant message arrives in it (pi's
 * SessionManager no-assistant guard). Until then the handoff doc lives in
 * memory only — if pi exits before the first reply, the new session is lost.
 * OMP forces ensureOnDisk() here; pi's public SessionManager exposes no
 * flush, so this is inherited from pi's newSession contract.
 *
 * Usage:
 *   /handoff                          (bare — general handoff)
 *   /handoff focus on the billing API (optional focus instructions)
 *   /handoff settings                 (view or set the threshold in the TUI)
 *
 * Esc during generation cancels. The loader is TUI-only; in non-interactive
 * modes generation runs headless with the same semantics.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config — a single threshold, stored next to pi's own settings.
// ---------------------------------------------------------------------------

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR
	? process.env.PI_CODING_AGENT_DIR.replace(/^~(?=\/|$)/, homedir())
	: join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "pi-handoff.json");
const DEFAULT_THRESHOLD = 100000;

export function readConfig(): { threshold: number } {
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		return { threshold: Number(raw.threshold) || DEFAULT_THRESHOLD };
	} catch {
		return { threshold: DEFAULT_THRESHOLD };
	}
}

export function ensureConfig(): { threshold: number } {
	const config = readConfig();
	if (!existsSync(CONFIG_PATH)) {
		writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
	}
	return config;
}

export function writeConfig(threshold: number): void {
	writeFileSync(CONFIG_PATH, JSON.stringify({ threshold }, null, 2) + "\n", "utf8");
}

// Warn once per crossing of the threshold; reset when usage drops (compaction).
let warnedOverThreshold = false;

// Minimal framing prompt; the document template below carries the behavior.
const SYSTEM_PROMPT = `You are an AI coding assistant. Given a conversation history, write a handoff document for another instance of yourself so it can continue the work without access to this conversation.`;

// OMP's handoff-document template (packages/agent/src/compaction/prompts/handoff-document.md), verbatim.
const HANDOFF_DOCUMENT_PROMPT = `<critical>
Write a handoff document for another instance of yourself.
The handoff MUST be sufficient for seamless continuation without access to this conversation.
Output ONLY the handoff document. No preamble, no commentary, no wrapper text.
</critical>

<instruction>
Capture exact technical state, not abstractions.
- File paths, symbol names, commands run
- Test results, observed failures
- Decisions made
- Partial work affecting the next step
</instruction>

<output>
Use exactly this structure:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]

## Progress
### Done
- [x] [Completed tasks with specifics]

### In Progress
- [ ] [Current work if any]

### Pending
- [ ] [Tasks mentioned but not started]

## Key Decisions
- **[Decision]**: [Rationale]

## Critical Context
- Code snippets, file paths, function/type names, error messages, data essential to continue
- Repository state if relevant

## Next Steps
1. [What should happen next]
</output>`;

// A failed/cancelled/ok generation. OMP treats empty or errored manual
// handoffs as failures, not cancellations (#7904/#7993); we mirror that.
type HandoffGeneration =
	| { status: "cancelled" }
	| { status: "failed"; reason: string }
	| { status: "ok"; text: string };

function renderHandoffPrompt(customInstructions?: string): string {
	if (!customInstructions) return HANDOFF_DOCUMENT_PROMPT;
	return `${HANDOFF_DOCUMENT_PROMPT}

<instruction>
Additional focus: ${customInstructions}
</instruction>`;
}

// Same wrapping OMP injects into the new session.
function createHandoffContext(document: string): string {
	return `<handoff-context>\n${document}\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.`;
}

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

// Active branch as messages. If the branch was compacted, include the
// compaction summary plus entries from firstKeptEntryId onward.
function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) {
		return branch.map(entryToMessage).filter((m): m is AgentMessage => m !== undefined);
	}

	const compaction = branch[compactionIndex];
	const firstKeptIndex =
		compaction.type === "compaction"
			? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
			: -1;
	const compactedBranch = [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return compactedBranch.map(entryToMessage).filter((m): m is AgentMessage => m !== undefined);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Hand off session context to a new session. /handoff settings opens the config",
		handler: async (args, ctx) => {
			if (args.trim().toLowerCase().startsWith("settings")) {
				const config = ensureConfig();
				const rest = args.trim().slice("settings".length).trim();
				if (rest !== "") {
					const value = Number(rest);
					if (!Number.isFinite(value) || value <= 0) {
						ctx.ui.notify(`Invalid threshold: ${rest}`, "error");
						return;
					}
					writeConfig(value);
					ctx.ui.notify(`Threshold set to ${value.toLocaleString()} tokens`, "info");
					return;
				}
				if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
					ctx.ui.notify(`Config: ${CONFIG_PATH} (threshold ${config.threshold})`, "info");
					return;
				}
				const answer = await ctx.ui.input("Handoff threshold (context tokens)", String(config.threshold));
				if (answer === undefined) return;
				const value = Number(answer.trim());
				if (!Number.isFinite(value) || value <= 0) {
					ctx.ui.notify(`Invalid threshold: ${answer}`, "error");
					return;
				}
				writeConfig(value);
				ctx.ui.notify(`Threshold set to ${value.toLocaleString()} tokens`, "info");
				return;
			}
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
				ctx.ui.notify("/handoff requires interactive mode", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// Let any in-flight turn settle before we read/mutate session state.
			if (!ctx.isIdle()) {
				await ctx.waitForIdle();
			}

			const messages = getHandoffMessages(ctx.sessionManager.getBranch());
			if (messages.length < 2) {
				ctx.ui.notify("Nothing to hand off (no messages yet)", "error");
				return;
			}

			const focus = args.trim() || undefined;
			const llmMessages = convertToLlm(messages);
			const currentSessionFile = ctx.sessionManager.getSessionFile();

			// The handoff instruction is a trailing user message — mirrors OMP,
			// which appends it to a snapshot of the live messages.
			const requestMessages: Message[] = [
				...llmMessages,
				{
					role: "user",
					content: [{ type: "text", text: renderHandoffPrompt(focus) }],
					timestamp: Date.now(),
				},
			];

			const generate = async (signal?: AbortSignal): Promise<HandoffGeneration> => {
				try {
					const response = await ctx.modelRegistry.complete(
						ctx.model!,
						{ systemPrompt: SYSTEM_PROMPT, messages: requestMessages },
						{
							signal,
							cacheRetention: "none",
							sessionId: uuidv7(),
						},
					);
					if (response.stopReason === "aborted") return { status: "cancelled" };
					if (response.stopReason === "error") {
						console.error("Handoff generation failed:", response.errorMessage ?? response.stopReason);
						return {
							status: "failed",
							reason: response.errorMessage?.slice(0, 160) ?? "provider error",
						};
					}
					const text = response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n")
						.trim();
					if (text.length === 0) return { status: "failed", reason: "empty document" };
					return { status: "ok", text };
				} catch (error) {
					console.error("Handoff generation failed:", error);
					return {
						status: "failed",
						reason: error instanceof Error ? error.message.slice(0, 160) : String(error),
					};
				}
			};

			let handoff: HandoffGeneration;
			if (ctx.mode === "tui") {
				handoff = await ctx.ui.custom<HandoffGeneration>((tui, theme, _kb, done) => {
					const loader = new BorderedLoader(tui, theme, "Generating handoff… (esc to cancel)");
					loader.onAbort = () => done({ status: "cancelled" });
					generate(loader.signal)
						.then(done)
						.catch((error) => {
							console.error("Handoff generation failed:", error);
							done({
								status: "failed",
								reason: error instanceof Error ? error.message.slice(0, 160) : String(error),
							});
						});
					return loader;
				});
			} else {
				handoff = await generate();
			}

			if (handoff.status !== "ok") {
				ctx.ui.notify(
					handoff.status === "cancelled" ? "Handoff cancelled" : `Handoff failed: ${handoff.reason}`,
					handoff.status === "cancelled" ? "info" : "error",
				);
				return;
			}
			const handoffText = handoff.text;

			// Start a brand-new session; the ONLY carried context is the handoff
			// document, injected as a custom in-context message.
			const result = await ctx.newSession({
				parentSession: currentSessionFile,
				setup: async (sm) => {
					sm.appendCustomMessageEntry("handoff", createHandoffContext(handoffText), true);
				},
				withSession: async (replacementCtx) => {
					replacementCtx.ui.notify("New session started with handoff context", "info");
				},
			});

			if (result.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
			}
		},
	});

	// Auto-watch: after each turn, warn once when context crosses the
	// configured threshold. Detection only; the actual handoff stays manual.
	pi.on("turn_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		const usage = message.usage;
		const tokens = (usage?.input ?? 0) + (usage?.cacheRead ?? 0);
		if (!tokens) return;
		const { threshold } = readConfig();
		if (tokens > threshold && !warnedOverThreshold) {
			warnedOverThreshold = true;
			ctx.ui.notify(
				`Context at ${tokens.toLocaleString()} tokens, over threshold ${threshold.toLocaleString()}. Run /handoff to hand off.`,
				"warning",
			);
		} else if (tokens <= threshold) {
			warnedOverThreshold = false;
		}
	});
}
