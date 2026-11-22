# pi-learning

**A self-learning loop and Obsidian knowledge vault for the [Pi coding agent](https://pi.dev), built to work well on a
small local model.**

Pi forgets everything between sessions. With pi-learning installed it keeps:

- **Your preferences.** Correct it once ("every Python script must use argparse") and new sessions follow it.
- **Procedures it worked out.** "How to scaffold and test a package on this machine" becomes a skill it loads next time.
- **A browsable vault.** Notes per project, per session and per topic, plus a mind map, all in Obsidian.

The design follows the learning loop of [Hermes Agent](https://github.com/NousResearch/hermes-agent): frozen
per-session memory, agent-managed skills, a background review and a curator. It is re-engineered for one constraint
that Hermes doesn't have: **a local llama.cpp server with a single request slot.** See [how it works](docs/how-it-works.md).

> Built and tested on Windows with Pi 1.5.1 and **Inkling 2 Mini** (a 64K-context MoE model running at about 20 tok/s on
> an 8 GB RTX 5060 Ti). The code is provider-agnostic. The cache-sharing review needs an OpenAI-compatible endpoint;
> with other providers the tools and memory still work and the review is skipped.

## What you get

| Piece | What it does |
|---|---|
| `memory` tool | Durable facts (`MEMORY.md`, ≤3,000 chars) and your profile and preferences (`USER.md`, ≤1,500). Both are loaded into the system prompt **once per session**, so the prompt cache stays valid. Writes that look like secrets or instruction overrides are refused. |
| `learn` tool | Search, list or view any skill, including a **library of skills that are not listed in the prompt** (they cost no tokens until needed). Pi can create, append, patch or archive **its own** skills; downloaded skills are read-only. |
| `vault` tool | Search, read and write notes in the Obsidian vault: past sessions, projects, knowledge. |
| Background review | When Pi is idle (every 6 turns, right after you correct it, or after an error got fixed) it asks the model what a future session needs and files the answer: memory entries, skill lessons, a session summary. **Typing cancels it.** |
| Journal | `Sessions/<date> <title>.md` for each session, linked from `Projects/<project>/<project>.md`. Also `Learning Log.md`, `Home.md`, `Skills Index.md` and an Obsidian **`Mindmap.canvas`**, all regenerated automatically. |
| Commands | `/learn [what]`, `/reflect`, `/curate`, `/vault` |
| Curated skills | `tools/install_skills.py` fetches 29 skills at pinned, reviewed commits from obra/superpowers, getsentry, anthropics, vercel-labs, wshobson, supabase, trailofbits, addyosmani and mattpocock. 14 are listed to the model; 15 sit in the searchable library. Provenance: [docs/SKILL-SOURCES.md](docs/SKILL-SOURCES.md). |
| `inkling-memory` (optional) | For small context windows: replaces Pi's compaction summary with a merged working memory plus a verbatim record. Also slims the prompt (hides sub-agent tools on a single-slot server). See [its README](extensions/inkling-memory/README.md). |

## Results (real runs, logged; scenarios in [tests/](tests/))

- **The correction carries over.** Session A: the user corrects Pi's Python style, and Pi saves it with `memory`
  unprompted. Session B, a new process: Pi writes `c2f.py` with argparse, type hints and a main guard without being
  told. Asked about semgrep, it finds the unlisted library skill through `learn search`.
- **A learned skill is reused.** After `/learn`, Pi wrote [a skill](examples/learned-skill/python-src-layout-package/SKILL.md)
  that includes a real pitfall it had hit (backslash venv paths fail in Git Bash). A fresh session given a similar task
  loaded that skill by itself and got it right on the first try.
- **The review is cheap.** It reuses the server's cached prefix: 11,649 tokens cached and 433 new, taking **7–9 s
  instead of 89–107 s**. The user's next turn stays cached (98 new tokens).
- **Typing cancels a review.** The cancelled review re-runs after the next turn and still captures the correction.
- **Compaction memory (inkling-memory).** After two forced compactions, the model still listed every requirement,
  command and error of an 8-turn project.

## Install (Windows; Pi already installed and run once)

```powershell
git clone https://github.com/tmtsolutions23/pi-learning "C:\Pi Agent"
cd "C:\Pi Agent"
.\setup.ps1          # creates vault\ from vault-template\, fetches the skills, registers everything in ~/.pi/agent/settings.json
pi                   # then: /vault
```

Open the `vault` folder in [Obsidian](https://obsidian.md) and start at **Home**, or open **Mindmap.canvas**.
On macOS and Linux, do what `setup.ps1` does by hand:
1. Copy `vault-template` to `vault`.
2. Run `python3 tools/install_skills.py`.
3. Add the entries from [examples/settings.snippet.json](examples/settings.snippet.json) to `~/.pi/agent/settings.json`.

**Settings** (environment variables):

| Variable | Default | Effect |
|---|---|---|
| `PI_AGENT_HOME` | the repo folder | Where the vault and skills live |
| `PI_LEARN_EVERY` | 6 | User turns between reviews |
| `PI_LEARN_REFLECT` | on | `0` disables the background review |
| `PI_LEARN_DEBUG` | off | `1` dumps the last review request and reply to `vault/.pi-learning-review.json` |

## Layout

```
extensions/pi-learning/    the loop (one TypeScript file, no dependencies beyond Pi)
extensions/inkling-memory/ optional compaction memory for small-context models
tools/install_skills.py    fetch + install curated skills at pinned commits
tools/pi_rpc_session.py    drive a Pi session over RPC from a JSON script (end-to-end tests)
tools/pi_rpc_compact.py    force a compaction over RPC (print mode cannot run /compact)
vault-template/            starting vault (copied to vault/, which is git-ignored)
examples/                  a skill Pi learned; a working memory after two compactions
tests/                     end-to-end scenarios
```

## Known limits

- Not yet exercised:
  - the hook that copies the compaction memory into the session note;
  - `/curate` end to end;
  - the secret filter on real attempts;
  - the "memory full" path.
- The review asks the model for JSON. Small models occasionally return none; the review then logs it and waits a full
  interval before trying again.
- The cache-sharing trick captures the exact request body by wrapping `fetch`. Extensions that bypass `fetch` would need
  the fallback path (`before_provider_request`), which may not match the server's cache.

## Credits and licenses

- The learning-loop design is adapted from **Hermes Agent** (Nous Research), including its memory/skill split, its
  "do not capture" rules and the curator.
- Skills belong to their authors and are fetched from their repos under their own licenses. They are not
  redistributed here. Trail of Bits skills are CC-BY-SA-4.0.
- Built with an AI coding agent (Claude Code), directed, reviewed and tested end to end by the author.
- Code in this repository: [MIT](LICENSE).
