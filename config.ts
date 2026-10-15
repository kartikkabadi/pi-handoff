import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR
	? process.env.PI_CODING_AGENT_DIR.replace(/^~(?=\/|$)/, homedir())
	: join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "pi-handoff.json");
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
		const pct = raw.thresholdPercent;
		const thresholdPercent =
			typeof pct === "number" && Number.isFinite(pct) && pct >= 1 && pct <= 100 ? Math.round(pct) : null;
		return { thresholdPercent, mode: raw.mode === "early" ? "early" : "turn" };
	} catch {
		return { thresholdPercent: null, mode: "turn" };
	}
}

export function ensureConfig(): HandoffConfig {
	const config = readConfig();
	if (!existsSync(CONFIG_PATH)) {
		writeConfig(config);
	}
	return config;
}

export function writeConfig(config: HandoffConfig): void {
	mkdirSync(AGENT_DIR, { recursive: true });
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


