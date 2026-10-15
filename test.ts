import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

const { default: registerHandoff, readConfig, ensureConfig, writeConfig, thresholdTokens, defaultPercent, fmt, pruneOtherSessions } = await import("./handoff.ts");

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

// Prune: recent parallel sessions and non-handoff files survive.
const moduleTmp = join(tmpDir, "pi-handoff");
mkdirSync(moduleTmp, { recursive: true });
const sessionId = "sess-123";
writeFileSync(join(moduleTmp, "handoff-old.md"), "x");
writeFileSync(join(moduleTmp, "handoff-ready-old.md"), "x");
writeFileSync(join(moduleTmp, `handoff-ready-${sessionId}.md`), "x");
writeFileSync(join(moduleTmp, `handoff-${sessionId}.md`), "x");
writeFileSync(join(moduleTmp, "other.txt"), "x");
const expired = join(moduleTmp, "handoff-expired.md");
writeFileSync(expired, "x");
const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
utimesSync(expired, oldTime, oldTime);
pruneOtherSessions(sessionId);
assert("prune keeps the current session's files", existsSync(join(moduleTmp, `handoff-ready-${sessionId}.md`)) && existsSync(join(moduleTmp, `handoff-${sessionId}.md`)));
assert("prune keeps non-handoff files", existsSync(join(moduleTmp, "other.txt")));
assert("prune preserves other active sessions' files", existsSync(join(moduleTmp, "handoff-old.md")) && existsSync(join(moduleTmp, "handoff-ready-old.md")));
assert("prune removes expired session files", !existsSync(expired));


let handler;
registerHandoff({ registerCommand(_name, command) { handler = command.handler; }, on() {} });
let generations = 0;
let prompt = "";
let injected = "";
const ctx = {
    mode: "rpc", model: {}, isIdle: () => true,
    ui: { notify() {} },
    sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => undefined,
        getBranch: () => [1, 2].map(i => ({
            type: "message", id: `m${i}`, timestamp: new Date(i).toISOString(),
            message: { role: "user", content: `Task ${i}`, timestamp: i },
        })),
    },
    modelRegistry: { async complete(_model, context) {
        generations++;
        prompt = context.messages.at(-1).content[0].text;
        return { stopReason: "stop", content: [{ type: "text", text: "Focused handoff" }] };
    } },
    async newSession(options) {
        await options.setup({ appendCustomMessageEntry(_type, text) { injected = text; } });
        return { cancelled: true };
    },
};
writeFileSync(join(moduleTmp, `handoff-ready-${sessionId}.md`), "Prepared handoff");
await handler("", ctx);
assert("bare handoff uses the prepared document", generations === 0 && injected.includes("Prepared handoff"));
await handler("focus on billing", ctx);
assert("focused handoff generates a new document", generations === 1 && injected.includes("Focused handoff"));
assert("focused handoff forwards the requested focus", prompt.includes("Additional focus: focus on billing"));

rmSync(base, { recursive: true, force: true });
process.exit(failed);

