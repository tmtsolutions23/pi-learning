# inkling-memory (Pi extension)

Working memory that survives Pi's context compaction, plus a leaner prompt, for the local **Inkling 2 Mini** model
(`inkling/inkling-2-mini`, 64K context). Active only when that provider is selected; other models are unaffected.
Set `PI_MEMORY_ALL=1` to use the memory with every model.

## What it does

**1. Memory across compactions.** When Pi compacts, instead of re-summarizing the previous summary (details fade each time),
the compaction summary becomes a two-part working memory:

- *Model-written, merged:* Goal · Constraints & Preferences · Key Decisions · Progress · Pitfalls & Fixed Errors ·
  Next Steps · Critical Context. Inkling updates the previous memory with what happened since (keeps still-relevant items,
  adds new ones, max ~700 words, low reasoning effort).
- *Verbatim, added by code (the model cannot distort it):* your first request (the brief, up to 2,500 chars) plus your 5
  most recent requests · pinned notes · real errors from the compacted span · all files read / modified so far.

A copy of each memory is written to `~/.pi/agent/inkling-memory/<session-id>.md`.

**2. Notes.**
- The model has a `remember` tool (`kind`: decision / fact / pitfall / todo / preference). Notes are copied verbatim into
  every later memory and are treated as authoritative.
- `/remember <text>` pins a note yourself. `/memory` shows the current memory and notes.

**3. Leaner prompt for Inkling** (first request 21,676 → 8,821 tokens, first-session wait ~2 min → ~48 s; since the
pi-learning and its 14 core skills were added it is 10,819 tokens / ~60 s):
- hides sub-agent tools (`SubagentWorkflow`, `Agent`, `subagent`, …). Besides ~10K tokens, each sub-agent is a separate
  conversation that evicts the main session from the single-slot llama-server prompt cache. Restored when you switch models.
  Keep some anyway: `PI_INKLING_KEEP_TOOLS=Agent,subagent`.
- hides 4 package skills that need those tools or only display package info (`pi-subagents`, `council-mode`,
  `ponytail-gain`, `ponytail-help`; ~550 tokens). Keep one: add its name to `PI_INKLING_KEEP_TOOLS`.
- drops billion-context's injected context tools (`compress`, `decompress`, `search_context`, `acp_*`) from Inkling
  requests only (billion-context keeps working for other models). Keep them: `PI_INKLING_KEEP_BILI=1`.

## Related settings (`~/.pi/agent/settings.json`)

```json
"defaultProvider": "inkling", "defaultModel": "inkling-2-mini",
"compaction": { "modelOverrides": { "inkling/inkling-2-mini": { "reserveTokens": 12288, "keepRecentTokens": 12000 } } }
```

Compaction triggers at ~53K tokens and keeps the last 12K verbatim; after a compaction the context is ~25K
(10.8K prompt + ~2.5K memory + 12K recent), leaving ~28K tokens of work before the next one.

## Tested (2026-11-22)

8–10-turn coding sessions (build a CLI with tests, a deliberate error and its fix), forced compactions via Pi RPC mode,
then questions answered "from memory only". After compaction #1 and #2 the model listed all 4 hard requirements, the
codename, all 6 commands with their exact JSON output and the errors + fixes; it recognized an already-built feature instead
of duplicating it, and called `remember` on its own. Example memory: [examples/example-working-memory.md](../../examples/example-working-memory.md).

Known limitation: "Progress / In progress" describes the state at the end of the *summarized* span; the kept recent messages
can be newer (the header tells the model that newer messages win).

Not tested: `/remember` and `/memory` in the interactive UI, automatic threshold compaction (compactions were triggered
manually through RPC), switching models mid-session (tool restore).

## Undo

Delete this folder (`~/.pi/agent/extensions/inkling-memory`) and remove the `compaction.modelOverrides` entry. Settings
backups: `~/.pi/agent/settings.json.bak-*`.
