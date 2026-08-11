# pi-handoff

OMP-style session handoff for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

One `/handoff` command reads the current session, writes a structured handoff document (Goal / Progress / Key Decisions / Critical Context / Next Steps), and starts a brand-new session that continues the work with only that document as context. The old session is linked as the parent, so the session tree keeps the history.

## Install

```bash
pi install git:github.com/kartikkabadi/pi-handoff@v0.1.0
```

Then restart pi or run `/reload`. To try it without installing: `pi -e git:github.com/kartikkabadi/pi-handoff`.

## Usage

| Command | Action |
| --- | --- |
| `/handoff` | General handoff |
| `/handoff focus on the billing API` | Handoff with extra focus instructions appended to the prompt |

`Esc` during generation cancels. The loader is TUI-only; in non-interactive modes generation runs headless with the same semantics.

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
