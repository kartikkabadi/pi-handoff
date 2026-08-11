/**
 * /handoff, OMP-style session handoff for pi
 *
 * Port of Oh My Pi's (can1357/oh-my-pi) /handoff command to a vanilla pi
 * extension:
 *
 *   1. A oneshot LLM call reads the current session's message history and
 *      writes a structured handoff document (Goal / Progress / Key Decisions /
 *      Critical Context / Next Steps).
 *   2. A brand-new session starts immediately. The old transcript is NOT
 *      carried over. The only context in the new session is the handoff
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
 * memory only. If pi exits before the first reply, the new session is lost.
 * OMP forces ensureOnDisk() here; pi's public SessionManager exposes no
 * flush, so this is inherited from pi's newSession contract.
 *
 * Usage:
 *   /handoff                          (bare: general handoff)
 *   /handoff focus on the billing API (optional focus instructions)
 *   /handoff settings                 (slider: threshold % + trigger mode)
 *   /handoff settings 85              (set the percent directly)
 *   /handoff settings mode early      (set the trigger mode)
 *
 * Auto-run: when the context crosses the threshold, the extension generates
 * the handoff document in the background and saves it in the OS temp dir.
 * The next /handoff switches instantly using that document. Pi's extension
 * API gives event hooks no session-switch ability, so the switch itself
 * stays a command.
 *
 * Esc during generation cancels. The loader is TUI-only; in non-interactive
 * modes generation runs headless with the same semantics.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Config: a single threshold, stored next to pi's own settings.
// ---------------------------------------------------------------------------

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR
	? process.env.PI_CODING_AGENT_DIR.replace(/^~(?=\/|$)/, homedir())
	: join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "pi-handoff.json");
// Used only when the current model reports no context window.
const DEFAULT_WINDOW = 200000;
// Models with this or more context default to a 100k token handoff.
const BIG_WINDOW_MIN = 100000;
// Smaller models default to half their window.
const SMALL_WINDOW_PERCENT = 50;

export interface HandoffConfig {
	/** null = smart default (100k for windows >= 100k, else 50% of the window). */
	thresholdPercent: number | null;
	/** "turn" = check after a full turn (default). "early" = check at the first safe moment mid-turn. */
	mode: "turn" | "early";
}

export function readConfig(): HandoffConfig {
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		const pct = Number(raw.thresholdPercent);
		const thresholdPercent = Number.isFinite(pct) && pct > 0 && pct <= 100 ? Math.round(pct) : null;
		return { thresholdPercent, mode: raw.mode === "early" ? "early" : "turn" };
	} catch {
		return { thresholdPercent: null, mode: "turn" };
	}
}

export function ensureConfig(): HandoffConfig {
	const config = readConfig();
	if (!existsSync(CONFIG_PATH)) {
		writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
	}
	return config;
}

export function writeConfig(config: HandoffConfig): void {
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// The effective threshold in tokens for the current model's window.
export function thresholdTokens(config: HandoffConfig, window: number): number {
	if (config.thresholdPercent !== null) return Math.round((config.thresholdPercent / 100) * window);
	return window >= BIG_WINDOW_MIN ? BIG_WINDOW_MIN : Math.round((SMALL_WINDOW_PERCENT / 100) * window);
}

// The slider start percent that matches the smart default for this window.
export function defaultPercent(window: number): number {
	if (!window || window <= 0) return 50;
	return Math.round((thresholdTokens({ thresholdPercent: null, mode: "turn" }, window) / window) * 100);
}

// Fixed locale so numbers always group the standard way: 1,000,000, not 10,00,000.
export function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

// Handoff documents live in the OS temp dir; the OS cleans them up.
const TMP_DIR = join(tmpdir(), "pi-handoff");

// Path of the auto-prepared handoff document for a session.
function readyDocPath(sessionId: string): string {
	return join(TMP_DIR, `handoff-ready-${sessionId}.md`);
}

// Delete handoff files from other sessions; keep only the current session's.
export function pruneOtherSessions(sessionId: string): void {
	try {
		for (const file of readdirSync(TMP_DIR)) {
			if (!file.startsWith("handoff-") || file.includes(sessionId)) continue;
			rmSync(join(TMP_DIR, file), { force: true });
		}
	} catch {
		// no temp dir yet: nothing to prune
	}
}

// Path of the final handoff document, kept after every switch for review.
function finalDocPath(sessionId: string): string {
	return join(TMP_DIR, `handoff-${sessionId}.md`);
}

// Auto-run state: one handoff per crossing; reset when usage drops below the threshold.
let triggeredOverThreshold = false;
let handoffRunning = false;

// Two-row settings component. Row 0: threshold percent slider (left/right 1%).
// Row 1: trigger mode toggle ("turn" / "early"). Up/down move between rows.
// Enter saves, Esc cancels.
class SettingsSlider {
	private row = 0;
	private percent: number;
	private mode: "turn" | "early";

	constructor(
		private window: number,
		private modelName: string,
		initial: HandoffConfig,
	) {
		this.percent = initial.thresholdPercent ?? defaultPercent(window);
		this.mode = initial.mode;
	}

	public onSave?: (config: HandoffConfig) => void;
	public onCancel?: () => void;

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.row = 0;
		} else if (matchesKey(data, Key.down)) {
			this.row = 1;
		} else if (matchesKey(data, Key.left)) {
			if (this.row === 0) this.changePercent(-1);
			else this.mode = this.mode === "early" ? "turn" : "early";
		} else if (matchesKey(data, Key.right)) {
			if (this.row === 0) this.changePercent(1);
			else this.mode = this.mode === "early" ? "turn" : "early";
		} else if (matchesKey(data, Key.enter)) {
			this.onSave?.({ thresholdPercent: this.percent, mode: this.mode });
		} else if (matchesKey(data, Key.escape)) {
			this.onCancel?.();
		}
	}

	private changePercent(delta: number): void {
		this.percent = Math.min(100, Math.max(1, this.percent + delta));
	}

	render(width: number): string[] {
		const tokens = Math.round((this.percent / 100) * this.window);
		const barWidth = Math.min(30, Math.max(8, width - 24));
		const filled = Math.round((this.percent / 100) * barWidth);
		const bar = "█".repeat(filled) + "░".repeat(Math.max(0, barWidth - filled));
		const windowLabel = this.window ? fmt(this.window) : "?";
		const tokenLabel = this.window ? `${fmt(tokens)} tokens` : "window unknown";
		const pctRow = `${this.row === 0 ? "> " : "  "}Threshold [${bar}] ${this.percent}% = ${tokenLabel}`;
		const modeRow = `${this.row === 1 ? "> " : "  "}Trigger   ${this.mode === "turn" ? "[turn] " : " turn  "}/${this.mode === "early" ? "[early]" : " early"}`;
		return [
			truncateToWidth(`Model: ${this.modelName} (${windowLabel} token window)`, width),
			truncateToWidth(pctRow, width),
			truncateToWidth(modeRow, width),
			"↑/↓ move · ←/→ adjust · Enter save · Esc cancel",
		];
	}

	invalidate(): void {
		// render is cheap; nothing to cache
	}
}

// Minimal framing prompt; the document template below carries the behavior.
const SYSTEM_PROMPT = `You are an AI coding assistant. Given a conversation history, write a handoff document for another instance of yourself so it can continue the work without access to this conversation. Redact API keys, passwords, tokens, and credentials; reference them by name only.`;

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

// One-shot LLM call that turns the session messages into a handoff document.
async function generateHandoffText(
	ctx: ExtensionContext,
	messages: AgentMessage[],
	focus: string | undefined,
	signal?: AbortSignal,
): Promise<HandoffGeneration> {
	const llmMessages = convertToLlm(messages);
	// The handoff instruction is a trailing user message, mirroring OMP,
	// which appends it to a snapshot of the live messages.
	const requestMessages: Message[] = [
		...llmMessages,
		{
			role: "user",
			content: [{ type: "text", text: renderHandoffPrompt(focus) }],
			timestamp: Date.now(),
		},
	];
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
}

// Auto-run: when the context crosses the threshold, generate the handoff
// document in the background and save it for the next /handoff. Event hooks
// cannot start sessions (newSession is command-only in pi's extension API),
// so the switch itself stays a /handoff keystroke, but it is instant.
async function maybeAutoHandoff(ctx: ExtensionContext, tokens: number): Promise<void> {
	if (!tokens || handoffRunning) return;
	if (!ctx.model) return;
	const config = readConfig();
	const usage = ctx.getContextUsage();
	const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? DEFAULT_WINDOW;
	const threshold = thresholdTokens(config, window);
	if (tokens <= threshold) {
		triggeredOverThreshold = false;
		return;
	}
	if (triggeredOverThreshold) return;
	triggeredOverThreshold = true;
	handoffRunning = true;
	try {
		const messages = getHandoffMessages(ctx.sessionManager.getBranch());
		if (messages.length < 2) return;
		const generation = await generateHandoffText(
			ctx,
			messages,
			"auto: context crossed the configured threshold",
		);
		if (generation.status !== "ok") {
			ctx.ui.notify(
				`Auto handoff failed: ${generation.status === "cancelled" ? "cancelled" : generation.reason}`,
				"error",
			);
			triggeredOverThreshold = false; // allow a retry next check
			return;
		}
		mkdirSync(TMP_DIR, { recursive: true });
		const sessionId = ctx.sessionManager.getSessionId();
		writeFileSync(readyDocPath(sessionId), generation.text, "utf8");
		ctx.ui.notify(
			`Context crossed the threshold (${fmt(tokens)} tokens, threshold ${fmt(threshold)}). Handoff document ready: run /handoff to switch.`,
			"warning",
		);
	} catch (error) {
		console.error("Auto handoff failed:", error);
		triggeredOverThreshold = false;
	} finally {
		handoffRunning = false;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Hand off session context to a new session. /handoff settings opens the config",
		handler: async (args, ctx) => {
			if (args.trim().toLowerCase().startsWith("settings")) {
				const config = ensureConfig();
				const window = ctx.model?.contextWindow ?? DEFAULT_WINDOW;
				const rest = args.trim().slice("settings".length).trim();
				const modeMatch = rest.toLowerCase().match(/^mode(?:\s+(early|turn))?$/);
				if (modeMatch) {
					const mode = modeMatch[1]
						? modeMatch[1] === "early"
							? "early"
							: "turn"
						: config.mode === "early"
							? "turn"
							: "early";
					writeConfig({ ...config, mode });
					ctx.ui.notify(`Trigger mode set to ${mode}`, "info");
					return;
				}
				if (rest !== "") {
					const value = Number(rest);
					if (!Number.isFinite(value) || value <= 0 || value > 100) {
						ctx.ui.notify(`Invalid threshold percent: ${rest} (1-100)`, "error");
						return;
					}
					const pct = Math.round(value);
					writeConfig({ ...config, thresholdPercent: pct });
					ctx.ui.notify(
						`Threshold set to ${pct}% (${fmt(thresholdTokens({ ...config, thresholdPercent: pct }, window))} tokens)`,
						"info",
					);
					return;
				}
				if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
					ctx.ui.notify(
						`Threshold ${config.thresholdPercent === null ? "auto" : config.thresholdPercent + "%"} (${fmt(thresholdTokens(config, window))} tokens), mode ${config.mode}`,
						"info",
					);
					return;
				}
				const result = await ctx.ui.custom<HandoffConfig | null>((tui, _theme, _kb, done) => {
					const slider = new SettingsSlider(window, ctx.model?.name ?? "unknown", config);
					slider.onSave = done;
					slider.onCancel = () => done(null);
					return {
						render: (width) => slider.render(width),
						handleInput: (data) => {
							slider.handleInput(data);
							tui.requestRender();
						},
						invalidate: () => slider.invalidate(),
					};
				});
				if (result === null || result === undefined) return; // cancelled
				writeConfig(result);
				ctx.ui.notify(
					`Threshold ${result.thresholdPercent}%, mode ${result.mode} (${fmt(thresholdTokens(result, window))} tokens)`,
					"info",
				);
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
			const currentSessionFile = ctx.sessionManager.getSessionFile();
			const sessionId = ctx.sessionManager.getSessionId();
			const readyPath = readyDocPath(sessionId);

			// Use the auto-prepared document when one exists for this session.
			// It is a snapshot of the conversation at the crossing; work after the
			// crossing stays in the old session (kept as the parent).
			let handoffText: string | undefined;
			if (existsSync(readyPath)) {
				handoffText = readFileSync(readyPath, "utf8");
			}

			if (handoffText === undefined) {
				let handoff: HandoffGeneration;
				if (ctx.mode === "tui") {
					handoff = await ctx.ui.custom<HandoffGeneration>((tui, theme, _kb, done) => {
						const loader = new BorderedLoader(tui, theme, "Generating handoff… (esc to cancel)");
						loader.onAbort = () => done({ status: "cancelled" });
						generateHandoffText(ctx, messages, focus, loader.signal)
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
					handoff = await generateHandoffText(ctx, messages, focus);
				}

				if (handoff.status !== "ok") {
					ctx.ui.notify(
						handoff.status === "cancelled" ? "Handoff cancelled" : `Handoff failed: ${handoff.reason}`,
						handoff.status === "cancelled" ? "info" : "error",
					);
					return;
				}
				handoffText = handoff.text;
			}

			// Start a brand-new session; the ONLY carried context is the handoff
			// document, injected as a custom in-context message.
			const result = await ctx.newSession({
				parentSession: currentSessionFile,
				setup: async (sm) => {
					sm.appendCustomMessageEntry("handoff", createHandoffContext(handoffText!), true);
				},
				withSession: async (replacementCtx) => {
					replacementCtx.ui.notify("New session started with handoff context", "info");
					// Auto-continue: send a follow-up so the fresh session's agent
					// picks up the work from the handoff document immediately.
					// Use the replacement ctx, never the captured pi object: pi
					// invalidates the extension runtime after a session switch.
					replacementCtx
						.sendUserMessage("Continue the work from the handoff document.", {
							deliverAs: "followUp",
						})
						.catch((error) => {
							console.error("Auto-continue failed:", error);
						});
				},
			});

			if (result.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
			} else {
				// Keep a reviewable copy of every handoff in the temp dir.
				mkdirSync(TMP_DIR, { recursive: true });
				writeFileSync(finalDocPath(sessionId), handoffText!, "utf8");
				rmSync(readyPath, { force: true }); // the prepared document was consumed
			}
		},
	});

	// Prune on session start: handoff files from other sessions are deleted.
	// Only files belonging to the current session survive.
	pi.on("session_start", (_event, ctx) => {
		pruneOtherSessions(ctx.sessionManager.getSessionId());
	});

	// Auto-run. Mode "turn" (default): check after each full turn. Mode
	// "early": check at the first safe moment, right after an assistant
	// message (thinking done, next tool not yet run). One handoff per
	// crossing; never runs while a handoff is already in flight.
	pi.on("turn_end", async (event, ctx) => {
		if (readConfig().mode !== "turn") return;
		const message = event.message;
		if (message.role !== "assistant") return;
		const usage = message.usage;
		const tokens = (usage?.input ?? 0) + (usage?.cacheRead ?? 0);
		if (!tokens) return;
		await maybeAutoHandoff(ctx, tokens);
	});

	pi.on("message_end", async (event, ctx) => {
		if (readConfig().mode !== "early") return;
		const message = event.message;
		if (message.role !== "assistant") return;
		const usage = message.usage;
		const tokens = (usage?.input ?? 0) + (usage?.cacheRead ?? 0);
		if (!tokens) return;
		await maybeAutoHandoff(ctx, tokens);
	});
}
