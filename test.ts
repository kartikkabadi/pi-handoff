import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pi-handoff-test-"));
process.env.PI_CODING_AGENT_DIR = dir;

const { readConfig, ensureConfig, writeConfig, thresholdTokens, defaultPercent, fmt } = await import("./handoff.ts");

let failed = 0;
function assert(name: string, cond: boolean) {
	console.log((cond ? "PASS" : "FAIL") + " " + name);
	if (!cond) failed = 1;
}

const cfg = ensureConfig();
assert("ensureConfig creates file with defaults", cfg.thresholdPercent === null && cfg.mode === "turn" && existsSync(join(dir, "pi-handoff.json")));
assert("readConfig reads defaults back", readConfig().thresholdPercent === null && readConfig().mode === "turn");

const smart = { thresholdPercent: null, mode: "turn" } as const;
assert("smart default: 128k window -> 100k tokens", thresholdTokens(smart, 128000) === 100000);
assert("smart default: 1m window -> 100k tokens", thresholdTokens(smart, 1000000) === 100000);
assert("smart default: 64k window -> 32k tokens (50%)", thresholdTokens(smart, 64000) === 32000);
assert("explicit percent wins over smart default", thresholdTokens({ ...smart, thresholdPercent: 50 }, 200000) === 100000);
assert("defaultPercent(128k) -> 78", defaultPercent(128000) === 78);

writeConfig({ thresholdPercent: 85, mode: "early" });
assert("writeConfig persists percent + mode", readConfig().thresholdPercent === 85 && readConfig().mode === "early");

writeFileSync(join(dir, "pi-handoff.json"), '{"thresholdPercent": 150, "mode": "early"}');
assert("out-of-range percent falls back to null", readConfig().thresholdPercent === null);
assert("mode survives invalid percent", readConfig().mode === "early");

writeFileSync(join(dir, "pi-handoff.json"), "not json");
assert("corrupt config falls back to defaults", readConfig().thresholdPercent === null && readConfig().mode === "turn");

assert("fmt groups the standard way", fmt(1000000) === "1,000,000" && fmt(10000) === "10,000");

rmSync(dir, { recursive: true, force: true });
process.exit(failed);
