import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "pi-handoff-config-test-"));
const agentDir = join(base, "missing", "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
const { ensureConfig, writeConfig, readConfig } = await import("./config.ts");
try {
    // A configured agent directory may not exist on first use.
    assert.deepEqual(ensureConfig(), { thresholdPercent: null, mode: "turn" });
    assert.ok(existsSync(join(agentDir, "pi-handoff.json")));
    rmSync(agentDir, { recursive: true });
    writeConfig({ thresholdPercent: 85, mode: "early" });
    assert.deepEqual(readConfig(), { thresholdPercent: 85, mode: "early" });

    // Corrupt saved values must never become a zero-token threshold.
    for (const thresholdPercent of [0.1, true, "85", 101, -1]) {
        writeFileSync(join(agentDir, "pi-handoff.json"), JSON.stringify({ thresholdPercent }));
        assert.equal(readConfig().thresholdPercent, null);
    }
    for (const thresholdPercent of [1, 50.5, 100]) {
        writeFileSync(join(agentDir, "pi-handoff.json"), JSON.stringify({ thresholdPercent }));
        assert.equal(readConfig().thresholdPercent, Math.round(thresholdPercent));
    }
    console.log("PASS fresh directory, persistence, and invalid threshold checks");
} finally {
    rmSync(base, { recursive: true, force: true });
}
