import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pi-handoff-test-"));
process.env.PI_CODING_AGENT_DIR = dir;

const { readConfig, ensureConfig, writeConfig } = await import("./handoff.ts");

let failed = 0;
function assert(name: string, cond: boolean) {
	console.log((cond ? "PASS" : "FAIL") + " " + name);
	if (!cond) failed = 1;
}

const cfg = ensureConfig();
assert("ensureConfig creates file with default 100000", cfg.threshold === 100000 && existsSync(join(dir, "pi-handoff.json")));
assert("readConfig reads default back", readConfig().threshold === 100000);

writeFileSync(join(dir, "pi-handoff.json"), '{"threshold": 80000}\n');
assert("readConfig honors custom threshold", readConfig().threshold === 80000);

writeConfig(120000);
assert("writeConfig persists and reads back", readConfig().threshold === 120000);

writeFileSync(join(dir, "pi-handoff.json"), "not json");
assert("corrupt config falls back to default", readConfig().threshold === 100000);

rmSync(dir, { recursive: true, force: true });
process.exit(failed);
