# How it works

## Three layers, one home per fact

| Layer | Lifetime | Where | Written by |
|---|---|---|---|
| Working memory | this session (survives compaction) | the compaction summary | `inkling-memory` (optional) |
| Facts and preferences | all future sessions | `vault/Memory/MEMORY.md`, `USER.md` | `memory` tool, background review |
| Procedures ("how to do this class of task") | all future sessions | `vault/Skills/<name>/SKILL.md` | `learn` tool, `/learn`, background review |
| Notes | browsable forever | `vault/Projects`, `Sessions`, `Knowledge` | `vault` tool, journal |

Pi loads `MEMORY.md` and `USER.md` into a system-prompt section **once, at session start**. Writes take effect in the next
session. This is deliberate: a system prompt that changes mid-session invalidates the server's prompt cache, and on a
local model re-reading a 10K-token prefix costs about a minute.

## The background review on a single-slot server

Hermes runs its review as a separate background conversation. On a llama.cpp server started with `-np 1` that would be
expensive:
- The slot holds exactly one conversation's KV cache, so a different prompt evicts it.
- The user's next turn then re-processes the whole context: about 60 s for 11K tokens at ~180 tok/s.

Instead, the review is a **continuation of the conversation's own last request**:

1. A `fetch` wrapper records the exact JSON body of the last agent request (one carrying tools) sent to
   `.../chat/completions`. The `before_provider_request` hook is not enough: other extensions can still rewrite the
   payload after it. In our setup the billion-context extension stamps `<acp time=...>` markers into every message.
2. When Pi settles (idle), the review sends `that body + the final assistant message + a review question`.
   - It goes through the `fetch` that existed before any later wrappers, so the bytes the server sees match the cached
     prefix.
   - The server reuses the prefix: measured `cache_n=11,649, prompt_n=433`, 7–9 s.
3. The model answers with JSON (`memory[]`, `skills[]`, `summary`). Code applies it with guards:
   - dedupe, size limits and a secret/injection filter;
   - writes only to Pi-owned skills; lessons about downloaded skills go to `Inbox/Lessons.md`.
4. The `input` event aborts the review the moment the user types. llama.cpp drops the streaming request, so the user's
   turn goes straight to a still-valid cache (98 new tokens measured). The cancelled review re-runs at the next idle
   point.

Before the fix, every review re-processed 9–17K tokens (`cache_n=0`, 89–107 s). There were two causes: the review went
through the rewriting extension a second time, and the hook-captured payload didn't match what was actually sent.

## When the review runs

- every `PI_LEARN_EVERY` (6) user turns;
- right after a user message that starts like a correction ("no", "don't", "stop", "actually", "I prefer"...);
- two turns after a tool error, so a fixed error gets captured;
- on `/reflect`.

A failed review (no JSON, HTTP error) is logged to `vault/.pi-learning.log`, and the next attempt waits a full interval.

## What the review must not save

Borrowed from Hermes:
- secrets;
- one-off task details;
- errors that a simple retry fixed;
- missing-tool or install errors;
- claims that "tool X doesn't work" (they harden into refusals long after the problem is fixed);
- anything unverified;
- anything already in memory.

Skills are named at the **class** level (`python-src-layout-package`, never `fix-bug-in-foo`).

## Skill tiers and prompt cost

Pi lists every installed skill (name, description, path) in the system prompt, roughly 80 tokens each. On a 64K local
model that adds up, so the curated set is split:
- `skills/core` (14): listed every session.
- `skills/library` (15): not listed. The `learn` tool's search finds them.
- `vault/Skills`: Pi's own skills, listed from the next session.

Measured on Inkling 2 Mini, pi-learning adds about 2.0K tokens to the first request: core skills ~1.1K, the memory section
~0.5K and three tool schemas ~0.7K. Later sessions reuse the cached prefix.

## Mind map

On every session start, and after anything is learned, the extension regenerates:
- `Home.md`;
- `Skills Index.md`;
- `Mindmap.canvas`, a [JSON Canvas](https://jsoncanvas.org) with Home at the centre and hubs for Memory, Projects (with
  recent sessions), Skills and Knowledge.

Obsidian's graph view is colour-coded via `vault-template/.obsidian/graph.json`.
