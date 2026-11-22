"""Install curated third-party skills into <home>/skills/core (listed to the model in every prompt) and
<home>/skills/library (not listed; found on demand with the `learn` tool of the pi-learning extension).
<home> is the folder above this script. Missing repos are fetched into <home>/sources at the pinned commits below
(shallow, treated as data). Re-runnable: wipes and rebuilds core/ and library/.

Run:  python -I tools/install_skills.py            (fetches missing sources, then installs)
Edits are applied to the copies only (sources stay pristine); every edit is listed in skills/SOURCES.md."""
import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "sources"
DST = ROOT / "skills"

REPOS = {
    "obra__superpowers": ("obra/superpowers", "MIT"),
    "getsentry__skills": ("getsentry/skills", "Apache-2.0"),
    "anthropics__skills": ("anthropics/skills", "Apache-2.0 (per-skill LICENSE.txt)"),
    "vercel-labs__agent-skills": ("vercel-labs/agent-skills", "MIT (declared in frontmatter; repo has no LICENSE file)"),
    "wshobson__agents": ("wshobson/agents", "MIT"),
    "supabase__agent-skills": ("supabase/agent-skills", "MIT"),
    "trailofbits__skills": ("trailofbits/skills", "CC-BY-SA-4.0 (attribution + share-alike)"),
    "addyosmani__agent-skills": ("addyosmani/agent-skills", "MIT"),
    "mattpocock__skills": ("mattpocock/skills", "MIT"),
}

# exact commits the curated set was vetted at (update deliberately, after re-reading the changed skills)
PINS = {
    "addyosmani__agent-skills": "8c99fa36d90068c82d547f7c12a9d67a3e95f4ee",
    "anthropics__skills": "e4bb5d960d87126ff3b3a8af1a104b7db67560ba",
    "getsentry__skills": "a582c51ee29d0f35e6ac321340796f77d43da733",
    "mattpocock__skills": "abeeaf95660ba9e8b7c753eb38f441ca707a8823",
    "obra__superpowers": "22f0b463e7a5e579904dd6211a520321035526f7",
    "supabase__agent-skills": "c9be0e931b7930f7d02126d04774d904c381e7d7",
    "trailofbits__skills": "149d7b21f4067765b82e67029730b42d228ef4b4",
    "vercel-labs__agent-skills": "5a37a6329fbad3666c3207392a6a7c0110e92efb",
    "wshobson__agents": "12bcec79ec7f24868bc75fe8cd21428ebf5e96d0",
}

PI_NOTE = ("> **Pi note:** written for another agent. Where it says AskUserQuestion, ask the user in chat; where it "
           "dispatches subagents or other agents, do that step yourself, one at a time.\n\n")

# name: (tier, path in sources, short description or None to keep, edits[(regex, replacement)], add PI_NOTE)
SKILLS = {
    # ---- core: general coding discipline
    "systematic-debugging": ("core", "obra__superpowers/skills/systematic-debugging", None,
                             [(r"`superpowers:", "`")], False),
    "test-driven-development": ("core", "obra__superpowers/skills/test-driven-development", None, [], False),
    "verification-before-completion": ("core", "obra__superpowers/skills/verification-before-completion",
        "Use before claiming work is done, fixed or passing: run the checks and show their output first.", [], False),
    "writing-plans": ("core", "obra__superpowers/skills/writing-plans", None, [
        (r"\*\*Context:\*\* If working in an isolated worktree[^\n]*\n\n", ""),
        (r"docs/superpowers/plans/", "docs/plans/"),
        (r"> \*\*For agentic workers:\*\*[^\n]*", "> Implement this plan task by task, ticking the `- [ ]` boxes as you go."),
        (r"## Execution Handoff.*\Z", "## Execution Handoff\n\nAfter saving and self-reviewing the plan, give the user its path "
         "and ask them to confirm it before implementing. Then implement the tasks one at a time yourself, running each "
         "task's tests before starting the next (see the test-driven-development and verification-before-completion skills).\n"),
    ], False),
    # ---- core: review + security
    "code-review": ("core", "getsentry__skills/skills/code-review",
        "Review code changes or a PR for correctness, security, performance, tests and design.", [], False),
    "find-bugs": ("core", "getsentry__skills/skills/find-bugs",
        "Find bugs and security issues in the current branch's changes (git diff).", [], False),
    "security-review": ("core", "getsentry__skills/skills/security-review",
        "Security review of code: injection, XSS, authn/authz, crypto, secrets, OWASP Top 10.", [], False),
    # ---- core: frontend
    "frontend-design": ("core", "anthropics__skills/skills/frontend-design",
        "Visual design direction for new or reworked UI: typography, color, layout; avoid templated looks.", [], False),
    "webapp-testing": ("core", "anthropics__skills/skills/webapp-testing",
        "Test or debug a local web app with Playwright (Python): drive pages, screenshots, console logs.", [], False),
    "react-best-practices": ("core", "vercel-labs__agent-skills/skills/react-best-practices",
        "React/Next.js performance rules: rendering, data fetching, bundle size. Use when writing or reviewing React.",
        [(r"For the complete guide with all rules expanded: `AGENTS.md`",
          "Read only the rule files that match the code at hand; do not load them all.")], False),
    "web-design-guidelines": ("core", "vercel-labs__agent-skills/skills/web-design-guidelines",
        "Audit UI code against web interface guidelines: accessibility, UX, forms, focus, motion.", [], False),
    # ---- core: backend
    "api-design-principles": ("core", "wshobson__agents/plugins/backend-development/skills/api-design-principles",
        "Design or review REST/GraphQL APIs: resources, errors, pagination, versioning, auth.", [], False),
    "error-handling-patterns": ("core", "wshobson__agents/plugins/developer-essentials/skills/error-handling-patterns",
        "Error handling design: exceptions vs results, propagation, retries, graceful degradation.", [], False),
    "supabase-postgres-best-practices": ("core", "supabase__agent-skills/skills/supabase-postgres-best-practices",
        "Postgres rules for schemas, indexes, queries, RLS and connections. Load before writing SQL or migrations.", [], False),
    # ---- library (not advertised; `skills search` finds them)
    "receiving-code-review": ("library", "obra__superpowers/skills/receiving-code-review", None, [], False),
    "supply-chain-risk-auditor": ("library", "trailofbits__skills/plugins/supply-chain-risk-auditor/skills/supply-chain-risk-auditor", None, [], True),
    "postgresql-table-design": ("library", "wshobson__agents/plugins/database-design/skills/postgresql-table-design", None, [], False),
    "architecture-patterns": ("library", "wshobson__agents/plugins/backend-development/skills/architecture-patterns", None, [], False),
    "accessibility-engineering": ("library", "addyosmani__agent-skills/skills/accessibility-engineering", None, [], False),
    "security-and-hardening": ("library", "addyosmani__agent-skills/skills/security-and-hardening", None, [], False),
    "semgrep": ("library", "trailofbits__skills/plugins/static-analysis/skills/semgrep", None, [], True),
    "sharp-edges": ("library", "trailofbits__skills/plugins/sharp-edges/skills/sharp-edges", None, [], True),
    "differential-review": ("library", "trailofbits__skills/plugins/differential-review/skills/differential-review", None, [], True),
    "diagnosing-bugs": ("library", "mattpocock__skills/skills/engineering/diagnosing-bugs", None, [], False),
    "writing-for-agents": ("library", "mattpocock__skills/skills/productivity/writing-for-agents", None, [], False),
    "planning-and-task-breakdown": ("library", "addyosmani__agent-skills/skills/planning-and-task-breakdown", None, [], False),
    "api-and-interface-design": ("library", "addyosmani__agent-skills/skills/api-and-interface-design", None, [], False),
    "frontend-ui-engineering": ("library", "addyosmani__agent-skills/skills/frontend-ui-engineering", None, [], False),
    "wcag-audit-patterns": ("library", "wshobson__agents/plugins/accessibility-compliance/skills/wcag-audit-patterns", None, [], False),
}

SKIP_DIRS = {"agents", "assets", "tests", "test", "__pycache__", ".git"}
SKIP_FILES = {"AGENTS.md", "CLAUDE.md", "metadata.json"}


def set_description(text: str, desc: str) -> str:
    m = re.match(r"---\r?\n(.*?)\r?\n---", text, re.S)
    fm = m.group(1)
    lines, out, skipping = fm.split("\n"), [], False
    for ln in lines:
        if re.match(r"description:", ln):
            out.append("description: " + json.dumps(desc))
            skipping = True
            continue
        if skipping and (ln.startswith((" ", "\t")) or ln.strip() == ""):
            continue
        skipping = False
        out.append(ln)
    return "---\n" + "\n".join(out) + "\n---" + text[m.end():]


def fetch_sources():
    """Shallow-fetch every repo at its pinned commit (skips repos already present)."""
    SRC.mkdir(parents=True, exist_ok=True)
    for repo_dir, (repo, _lic) in REPOS.items():
        d = SRC / repo_dir
        if (d / ".git").exists():
            continue
        print(f"fetching {repo} @ {PINS[repo_dir][:12]}")
        d.mkdir(parents=True, exist_ok=True)
        for args in (["init", "-q"], ["remote", "add", "origin", f"https://github.com/{repo}.git"],
                     ["fetch", "-q", "--depth", "1", "origin", PINS[repo_dir]], ["checkout", "-q", "FETCH_HEAD"]):
            subprocess.run(["git", "-C", str(d), *args], check=True)


def main():
    fetch_sources()
    for tier in ("core", "library"):
        shutil.rmtree(DST / tier, ignore_errors=True)
        (DST / tier).mkdir(parents=True)
    rows = []
    for name, (tier, rel, desc, edits, note) in SKILLS.items():
        src = SRC / rel
        repo_dir = rel.split("/")[0]
        repo, lic = REPOS[repo_dir]
        sha = subprocess.run(["git", "-C", str(SRC / repo_dir), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        dst = DST / tier / name
        shutil.copytree(src, dst, ignore=lambda d, names: [n for n in names if n in SKIP_DIRS or n in SKIP_FILES])
        # keep the repo license next to skills that have none of their own
        if not any(p.name.upper().startswith("LICENSE") for p in dst.iterdir()):
            for cand in ("LICENSE", "LICENSE.md", "LICENSE.txt"):
                if (SRC / repo_dir / cand).exists():
                    shutil.copy(SRC / repo_dir / cand, dst / "LICENSE")
                    break
        sk = dst / "SKILL.md"
        text = sk.read_text(encoding="utf-8").replace("\r\n", "\n")
        changes = []
        if desc:
            text = set_description(text, desc)
            changes.append("description shortened")
        for pat, rep in edits:
            new, n = re.subn(pat, lambda _m, r=rep: r, text, flags=re.S)
            if n == 0:
                raise SystemExit(f"{name}: edit pattern not found: {pat[:60]}")
            text = new
            changes.append(f"edit x{n}: {pat[:40]!r}")
        if note:
            m = re.match(r"---\n.*?\n---\n", text, re.S)
            text = text[:m.end()] + "\n" + PI_NOTE + text[m.end():].lstrip("\n")
            changes.append("Pi compatibility note added")
        sk.write_text(text, encoding="utf-8")
        size = sum(p.stat().st_size for p in dst.rglob("*") if p.is_file())
        rows.append((tier, name, repo, rel.split("/", 1)[1], sha[:12], lic, size, "; ".join(changes) or "verbatim"))
    md = ["# Skill sources", "",
          "Installed by `tools/install_skills.py` from shallow clones in `sources/` (pinned commits below).",
          "`core/` skills are advertised to the model every session; `library/` skills are found with the `skills` tool.",
          "Trail of Bits skills are CC-BY-SA-4.0: keep attribution and the license if you redistribute changes.", "",
          "| Tier | Skill | Repo | Path | Commit | License | Bytes | Local changes |", "|---|---|---|---|---|---|---|---|"]
    md += [f"| {t} | {n} | {r} | `{p}` | {s} | {l} | {b:,} | {c} |" for t, n, r, p, s, l, b, c in rows]
    (DST / "SOURCES.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    for r in rows:
        print(f"{r[0]:8} {r[1]:34} {r[6]:>8,}  {r[7]}")


if __name__ == "__main__":
    main()
