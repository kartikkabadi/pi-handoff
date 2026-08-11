import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";

// Redirect the agent dir and the temp dir before importing the extension,
// so the tests never touch the real config or handoff files.
const base = mkdtempSync(join(osTmpdir(), "pi-handoff-test-"));
const agentDir = join(base, "agent");
const tmpDir = join(base, "tmp");
mkdirSync(agentDir, { recursive: true });
mkdirSync(tmpDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.TMPDIR = tmpDir;

const { readConfig, ensureConfig, writeConfig, thresholdTokens, defaultPercent, fmt, pruneOtherSessions } = await import("./handoff.ts");

let failed = 0;
function assert(name: string, cond: boolean) {
	console.log((cond ? "PASS" : "FAIL") + " " + name);
	if (!cond) failed = 1;
}

const cfg = ensureConfig();
assert("ensureConfig creates file with defaults", cfg.thresholdPercent === null && cfg.mode === "turn" && existsSync(join(agentDir, "pi-handoff.json")));
assert("readConfig reads defaults back", readConfig().thresholdPercent === null && readConfig().mode === "turn");

const smart = { thresholdPercent: null, mode: "turn" } as const;
assert("smart default: 128k window -> 100k tokens", thresholdTokens(smart, 128000) === 100000);
assert("smart default: 1m window -> 100k tokens", thresholdTokens(smart, 1000000) === 100000);
assert("smart default: 64k window -> 32k tokens (50%)", thresholdTokens(smart, 64000) === 32000);
assert("explicit percent wins over smart default", thresholdTokens({ ...smart, thresholdPercent: 50 }, 200000) === 100000);
assert("defaultPercent(128k) -> 78", defaultPercent(128000) === 78);
assert("defaultPercent(0) does not produce NaN", Number.isFinite(defaultPercent(0)));

writeConfig({ thresholdPercent: 85, mode: "early" });
assert("writeConfig persists percent + mode", readConfig().thresholdPercent === 85 && readConfig().mode === "early");

writeFileSync(join(agentDir, "pi-handoff.json"), '{"thresholdPercent": 150, "mode": "early"}');
assert("out-of-range percent falls back to null", readConfig().thresholdPercent === null);
assert("mode survives invalid percent", readConfig().mode === "early");

writeFileSync(join(agentDir, "pi-handoff.json"), "not json");
assert("corrupt config falls back to defaults", readConfig().thresholdPercent === null && readConfig().mode === "turn");

assert("fmt groups the standard way", fmt(1000000) === "1,000,000" && fmt(10000) === "10,000");

// Prune: only the current session's handoff files survive; non-handoff files are untouched.
const moduleTmp = join(tmpDir, "pi-handoff");
mkdirSync(moduleTmp, { recursive: true });
const sessionId = "sess-123";
writeFileSync(join(moduleTmp, "handoff-old.md"), "x");
writeFileSync(join(moduleTmp, "handoff-ready-old.md"), "x");
writeFileSync(join(moduleTmp, `handoff-ready-${sessionId}.md`), "x");
writeFileSync(join(moduleTmp, `handoff-${sessionId}.md`), "x");
writeFileSync(join(moduleTmp, "other.txt"), "x");
pruneOtherSessions(sessionId);
assert("prune keeps the current session's files", existsSync(join(moduleTmp, `handoff-ready-${sessionId}.md`)) && existsSync(join(moduleTmp, `handoff-${sessionId}.md`)));
assert("prune keeps non-handoff files", existsSync(join(moduleTmp, "other.txt")));
assert("prune deletes other sessions' files", !existsSync(join(moduleTmp, "handoff-old.md")) && !existsSync(join(moduleTmp, "handoff-ready-old.md")));

rmSync(base, { recursive: true, force: true });
process.exit(failed);
