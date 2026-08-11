# pi-handoff

OMP-style session handoff for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

One `/handoff` command reads the current session, writes a structured handoff document (Goal / Progress / Key Decisions / Critical Context / Next Steps), and starts a brand-new session that continues the work with only that document as context. The old session is linked as the parent, so the session tree keeps the history.

## Install

```bash
pi install git:github.com/kartikkabadi/pi-handoff
```

No `@ref` means the package tracks the latest on `main`; run `pi update --extensions` to pull updates. Add `@tag` (for example `@v0.2.0`) to pin a specific release instead.

Then restart pi or run `/reload`. To try it without installing: `pi -e git:github.com/kartikkabadi/pi-handoff`.

## Usage

| Command | Action |
| --- | --- |
| `/handoff` | General handoff |
| `/handoff focus on the billing API` | Handoff with extra focus instructions appended to the prompt |
| `/handoff settings` | Show the threshold in a TUI dialog and change it |
| `/handoff settings 120000` | Set the threshold directly |

`Esc` during generation cancels. The loader is TUI-only; in non-interactive modes generation runs headless with the same semantics.

## Settings

The threshold is a **percentage of the current model's context window**, so it means the same thing on a 128k model and a 1m model. Config file: `~/.pi/agent/pi-handoff.json`.

```json
{
  "thresholdPercent": 78
}
```

78% of a 128k window is roughly 100k tokens. The settings UI is a slider in the TUI:

| Command | Action |
| --- | --- |
| `/handoff settings` | Opens a slider: `←/→` steps 1%, `↑/↓` steps 5%, Enter saves, Esc cancels. Shows the model's window and the live token equivalent |
| `/handoff settings 85` | Sets the percent directly, no slider |

After every turn, the extension warns once when the session context crosses the threshold: "Context at X tokens, over your threshold of Y%. Run /handoff to hand off." Detection only — the handoff itself stays manual, and the check runs at turn boundaries, never mid-turn. The warning resets when context drops below the threshold (for example after compaction).

## How it works

1. A one-shot LLM call summarizes the session into the handoff-document template (Goal / Constraints / Progress / Key Decisions / Critical Context / Next Steps).
2. A brand-new session starts immediately. The old transcript is not carried over. The only context in the new session is the handoff document, injected as a custom in-context message wrapped in `<handoff-context>`.
3. The new session links to the old one via `parentSession`, so the session tree keeps the history.

If generation fails or is cancelled, nothing changes and the current session stays intact.

## Notes for developers

Runs entirely on pi's bundled modules (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`). No network, no npm runtime dependencies.

## Credits

Port of the `/handoff` command from [Oh My Pi](https://github.com/can1357/oh-my-pi) (MIT, Mario Zechner, Can Bölük). The handoff-document template is used verbatim from OMP's `packages/agent/src/compaction/prompts/handoff-document.md`.

## License

MIT
