import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pi-handoff-test-"));
process.env.PI_CODING_AGENT_DIR = dir;

const { readConfig, ensureConfig, writeConfig, fmt } = await import("./handoff.ts");

let failed = 0;
function assert(name: string, cond: boolean) {
	console.log((cond ? "PASS" : "FAIL") + " " + name);
	if (!cond) failed = 1;
}

const cfg = ensureConfig();
assert("ensureConfig creates file with default 78%", cfg.thresholdPercent === 78 && existsSync(join(dir, "pi-handoff.json")));
assert("readConfig reads default back", readConfig().thresholdPercent === 78);

writeConfig(85);
assert("writeConfig persists and reads back", readConfig().thresholdPercent === 85);

writeFileSync(join(dir, "pi-handoff.json"), '{"thresholdPercent": 150}\n');
assert("out-of-range percent falls back to default", readConfig().thresholdPercent === 78);

writeFileSync(join(dir, "pi-handoff.json"), "not json");
assert("corrupt config falls back to default", readConfig().thresholdPercent === 78);

assert("fmt groups the standard way", fmt(1000000) === "1,000,000" && fmt(10000) === "10,000");

rmSync(dir, { recursive: true, force: true });
process.exit(failed);
