/**
 * pi-learning: a Hermes-style self-learning loop for Pi, backed by an Obsidian vault (<agent home>/vault).
 *
 *  - memory tool   durable facts (Memory/MEMORY.md) and the user's profile/preferences (Memory/USER.md). Both are loaded
 *                  into the system prompt ONCE per session (frozen snapshot, so the llama-server prompt cache stays valid).
 *  - learn tool    procedures and pitfalls as skills the agent owns (vault/Skills/<name>/SKILL.md; Pi loads them next
 *                  session), plus search/view over every skill, including the unadvertised library (skills/library).
 *  - vault tool    search/read/write notes (Knowledge/, Projects/, Sessions/) — the long-term wiki.
 *  - reflection    after every few turns (or right after the user corrects Pi / an error was fixed), when Pi is idle, a
 *                  background review asks the model what a future session should know and files it (memory, skills,
 *                  session summary). It reuses the conversation's exact request prefix, so the single-slot server only
 *                  processes the short review prompt, and it is aborted the moment the user types.
 *  - journal       Sessions/<date> <title>.md per session, Projects/<project>/<project>.md, Learning Log.md, Home.md,
 *                  Skills Index.md and Mindmap.canvas (Obsidian canvas) are maintained automatically.
 *  - commands      /learn [what], /reflect, /curate, /vault
 *
 * Downloaded skills (skills/core, skills/library) are read-only to the agent; it may only write its own (vault/Skills).
 * Env: PI_AGENT_HOME (default: the folder two levels above this file, i.e. <home>/extensions/pi-learning -> <home>), PI_LEARN_EVERY (turns between reflections, default 6), PI_LEARN_REFLECT=0
 * disables background reflection.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// <home>/extensions/pi-learning/index.ts -> <home>
const HERE = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
const AGENT_HOME = process.env.PI_AGENT_HOME || resolve(HERE, "..", "..");
const VAULT = join(AGENT_HOME, "vault");
const CORE = join(AGENT_HOME, "skills", "core");
const LIBRARY = join(AGENT_HOME, "skills", "library");
const LEARNED = join(VAULT, "Skills");
const SKILL_ARCHIVE = join(VAULT, "Archive", "skills");
const MEM = { memory: join(VAULT, "Memory", "MEMORY.md"), user: join(VAULT, "Memory", "USER.md") } as const;
const MEM_LIMIT = { memory: 3000, user: 1500 } as const;
const REFLECT_EVERY = Math.max(2, Number(process.env.PI_LEARN_EVERY || 6));
const REFLECT_ON = process.env.PI_LEARN_REFLECT !== "0";
const BILI_TOOL = /^(acp_[a-z_]+|compress|decompress|search_context)$/; // same filter as inkling-memory

type Target = "memory" | "user";
type SkillInfo = { name: string; description: string; tier: "learned" | "core" | "library"; dir: string };

// ---------------------------------------------------------------- small helpers
const today = () => new Date().toISOString().slice(0, 10);
const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
};
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n) + "…");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const write = (p: string, s: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s, "utf8");
};
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n")
      : "";
const slug = (s: string) =>
  oneLine(s).replace(/[\\/:*?"<>|#^\[\]]/g, "").split(" ").slice(0, 8).join(" ").slice(0, 60).trim() || "session";

// Refuse content that would poison future sessions: prompt-injection phrasing, credentials, invisible characters.
const THREAT = [
  /(ignore|disregard|forget)\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|rules)/i,
  /<\/?(system|assistant)>/i,
  /\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|xox[bap]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(api[_-]?key|password|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_\-\/+=]{12,}/i,
  /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/,
];
function threat(s: string): string | undefined {
  for (const re of THREAT) if (re.test(s)) return "content looks like a secret or an instruction override; not saved";
  return undefined;
}

function inside(base: string, p: string): boolean {
  const r = relative(resolve(base), resolve(p));
  return !!r && !r.startsWith("..") && !isAbsolute(r);
}

function vaultPath(p: string): string {
  let rel = String(p || "").replace(/^[\\/]+/, "").replace(/\//g, sep);
  if (rel.toLowerCase().startsWith("vault" + sep)) rel = rel.slice(6);
  if (!/\.(md|canvas)$/i.test(rel)) rel += ".md";
  const full = resolve(VAULT, rel);
  if (!inside(VAULT, full)) throw new Error(`path must stay inside the vault: ${p}`);
  return full;
}

function walk(dir: string, match: (f: string) => boolean, out: string[] = [], depth = 0): string[] {
  if (!existsSync(dir) || depth > 6) return out;
  for (const n of readdirSync(dir)) {
    if (n.startsWith(".")) continue;
    const f = join(dir, n);
    let st;
    try {
      st = statSync(f);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(f, match, out, depth + 1);
    else if (match(f)) out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------- memory files
function memEntries(t: Target): string[] {
  return read(MEM[t]).split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
}
function memWrite(t: Target, entries: string[]) {
  const cur = read(MEM[t]);
  const i = cur.split("\n").findIndex((l) => l.startsWith("- "));
  const head = i < 0 ? cur.trimEnd() + "\n\n" : cur.split("\n").slice(0, i).join("\n");
  write(MEM[t], head.replace(/\n*$/, "\n\n") + entries.map((e) => `- ${e}`).join("\n") + "\n");
}
const memSize = (entries: string[]) => entries.reduce((n, e) => n + e.length + 3, 0);

function memoryOp(action: string, target: Target, text?: string, old?: string): { ok: boolean; msg: string } {
  const entries = memEntries(target);
  const name = target === "user" ? "USER.md" : "MEMORY.md";
  const t = oneLine(text || "");
  const find = (q: string) => entries.map((e, i) => [e, i] as const).filter(([e]) => e.toLowerCase().includes(oneLine(q).toLowerCase()));
  if (action === "add" || action === "replace") {
    if (!t) return { ok: false, msg: "text is required" };
    const bad = threat(t);
    if (bad) return { ok: false, msg: bad };
  }
  if (action === "add") {
    if (entries.some((e) => e.toLowerCase() === t.toLowerCase() || e.toLowerCase().includes(t.toLowerCase())))
      return { ok: true, msg: `${name}: already known, nothing added` };
    if (memSize(entries) + t.length + 3 > MEM_LIMIT[target])
      return { ok: false, msg: `${name} is full (${memSize(entries)}/${MEM_LIMIT[target]} chars). Merge or remove entries with action replace/remove first.` };
    entries.push(t);
  } else if (action === "replace" || action === "remove") {
    if (!old) return { ok: false, msg: "old_text (a unique part of the entry) is required" };
    const hits = find(old);
    if (hits.length !== 1) return { ok: false, msg: `old_text matched ${hits.length} entries; make it unique` };
    if (action === "remove") entries.splice(hits[0][1], 1);
    else entries[hits[0][1]] = t;
    if (memSize(entries) > MEM_LIMIT[target]) return { ok: false, msg: `${name} would exceed ${MEM_LIMIT[target]} chars` };
  } else return { ok: false, msg: `unknown action ${action}` };
  memWrite(target, entries);
  return { ok: true, msg: `${name} updated (${memSize(entries)}/${MEM_LIMIT[target]} chars). Loaded into every new session.` };
}

// ---------------------------------------------------------------- skills
function frontmatter(md: string): Record<string, string> {
  const m = md.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  let key = "";
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      out[key] = kv[2].replace(/^[>|]-?\s*$/, "").replace(/^"(.*)"$/, "$1");
    } else if (key && /^\s+/.test(line)) out[key] = (out[key] + " " + line.trim()).trim();
  }
  return out;
}

function allSkills(): SkillInfo[] {
  const list: SkillInfo[] = [];
  for (const [tier, root] of [["learned", LEARNED], ["core", CORE], ["library", LIBRARY]] as const) {
    for (const f of walk(root, (p) => basename(p) === "SKILL.md")) {
      const fm = frontmatter(read(f));
      list.push({ name: fm.name || basename(dirname(f)), description: fm.description || "", tier, dir: dirname(f) });
    }
  }
  return list;
}

function score(text: string, terms: string[]): number {
  const t = text.toLowerCase();
  return terms.reduce((s, w) => s + (t.includes(w) ? 1 + Math.min(3, t.split(w).length - 2) * 0.2 : 0), 0);
}
const termsOf = (q: string) => [...new Set(q.toLowerCase().split(/[^a-z0-9+#.]+/).filter((w) => w.length > 1))];

function learnedSkillFile(name: string): string {
  return join(LEARNED, name, "SKILL.md");
}

function createSkill(name: string, description: string, body: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error("name must be lowercase-kebab-case, <= 64 chars");
  const desc = oneLine(description);
  if (!desc || desc.length > 160) throw new Error("description is required (what it does + when to use it), <= 160 chars");
  const clash = allSkills().find((s) => s.name === name);
  if (clash) throw new Error(`a ${clash.tier} skill named ${name} already exists; use action append/patch (learned) or pick another name`);
  const bad = threat(desc + "\n" + body);
  if (bad) throw new Error(bad);
  const title = name.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  let text = body.trim();
  if (!/^#\s/m.test(text)) text = `# ${title}\n\n${text}`;
  write(learnedSkillFile(name), `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\nmetadata:\n  source: pi-learning\n  created: ${today()}\n  updated: ${today()}\n---\n\n${text}\n`);
  return learnedSkillFile(name);
}

function touchUpdated(md: string): string {
  return md.replace(/(\n  updated: )\d{4}-\d{2}-\d{2}/, `$1${today()}`);
}

function appendToSkill(name: string, section: string, content: string): string {
  const f = learnedSkillFile(name);
  if (!existsSync(f)) throw new Error(`no learned skill named ${name}`);
  const bad = threat(content);
  if (bad) throw new Error(bad);
  let md = read(f).replace(/\r\n/g, "\n");
  const lines = oneLine(content) === content.trim() ? `- ${content.trim().replace(/^- /, "")}` : content.trim();
  if (md.toLowerCase().includes(oneLine(content).toLowerCase().slice(0, 80))) return "already recorded";
  const head = `## ${section || "Pitfalls"}`;
  const i = md.indexOf("\n" + head + "\n");
  if (i < 0) md = md.trimEnd() + `\n\n${head}\n${lines}\n`;
  else {
    const start = i + head.length + 2;
    const next = md.indexOf("\n## ", start);
    const end = next < 0 ? md.length : next;
    md = md.slice(0, end).trimEnd() + "\n" + lines + "\n" + md.slice(end);
  }
  write(f, touchUpdated(md));
  return "appended";
}

// ---------------------------------------------------------------- vault notes, journal, mindmap
function projectOf(cwd: string): string {
  let d = resolve(cwd);
  const stop = [resolve(homedir()), resolve(AGENT_HOME)].map((s) => s.toLowerCase());
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, ".git"))) return basename(d);
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  const c = resolve(cwd);
  if (stop.includes(c.toLowerCase()) || dirname(c) === c || c.toLowerCase().startsWith(resolve(AGENT_HOME).toLowerCase())) return "General";
  return basename(c);
}

function projectNote(project: string): string {
  const f = join(VAULT, "Projects", project, `${project}.md`);
  if (!existsSync(f))
    write(f, `---\ntags: [project]\nstatus: active\n---\n# ${project}\n\n## Summary\n(Pi fills this in as it learns about the project.)\n\n## Sessions\n`);
  return f;
}

function appendUnder(file: string, heading: string, line: string) {
  let md = read(file).replace(/\r\n/g, "\n");
  if (md.includes(line)) return;
  const h = `## ${heading}`;
  const i = md.indexOf("\n" + h + "\n");
  if (i < 0) md = md.trimEnd() + `\n\n${h}\n${line}\n`;
  else {
    const start = i + h.length + 2;
    const next = md.indexOf("\n## ", start);
    const end = next < 0 ? md.length : next;
    md = md.slice(0, end).trimEnd() + "\n" + line + "\n" + md.slice(end);
  }
  write(file, md);
}

function replaceSection(file: string, heading: string, body: string) {
  let md = read(file).replace(/\r\n/g, "\n");
  const h = `## ${heading}`;
  const i = md.indexOf("\n" + h + "\n");
  if (i < 0) md = md.trimEnd() + `\n\n${h}\n${body.trim()}\n`;
  else {
    const start = i + h.length + 2;
    const next = md.indexOf("\n## ", start);
    md = md.slice(0, start) + body.trim() + "\n" + (next < 0 ? "" : md.slice(next));
  }
  write(file, md);
}

function logLearning(line: string) {
  const f = join(VAULT, "Learning Log.md");
  if (!existsSync(f)) write(f, "---\ntags: [moc]\n---\n# Learning Log\nEverything Pi saved to memory or skills, newest last.\n\n");
  appendFileSync(f, `- ${stamp()} ${line}\n`, "utf8");
}

const noteName = (f: string) => basename(f).replace(/\.md$/, "");

function rebuildIndexes() {
  // Skills Index.md
  const skills = allSkills();
  const row = (s: SkillInfo) => `| ${s.name} | ${s.description.replace(/\|/g, "/")} |`;
  const learned = skills.filter((s) => s.tier === "learned");
  write(join(VAULT, "Skills Index.md"), [
    "---", "tags: [moc]", "---", "# Skills Index", "Generated by pi-learning. Pi-owned skills live in `Skills/`; downloaded ones in `" + join(AGENT_HOME, "skills") + "` (read-only, sources in `skills/SOURCES.md`).", "",
    `## Learned by Pi (${learned.length})`,
    ...(learned.length ? learned.map((s) => `- [[Skills/${basename(s.dir)}/SKILL|${s.name}]] — ${s.description}`) : ["- (none yet)"]),
    "", `## Core — listed to the model every session (${skills.filter((s) => s.tier === "core").length})`, "| Skill | Use when |", "|---|---|",
    ...skills.filter((s) => s.tier === "core").map(row),
    "", `## Library — found with \`learn\` search (${skills.filter((s) => s.tier === "library").length})`, "| Skill | Use when |", "|---|---|",
    ...skills.filter((s) => s.tier === "library").map(row), "",
  ].join("\n"));

  // Home.md
  const projects = existsSync(join(VAULT, "Projects")) ? readdirSync(join(VAULT, "Projects")).filter((p) => existsSync(join(VAULT, "Projects", p, `${p}.md`))) : [];
  const sessions = walk(join(VAULT, "Sessions"), (f) => f.endsWith(".md")).sort().reverse();
  const knowledge = walk(join(VAULT, "Knowledge"), (f) => f.endsWith(".md") && noteName(f) !== "Knowledge");
  write(join(VAULT, "Home.md"), [
    "---", "tags: [moc]", "---", "# Pi Home", "The map of everything Pi knows. Open **Mindmap.canvas** for the visual map, or the graph view.", "",
    "## Memory", "- [[MEMORY]] — environment facts", "- [[USER]] — your profile and preferences", "",
    "## Projects", ...(projects.length ? projects.map((p) => `- [[${p}]]`) : ["- (none yet)"]), "",
    "## Knowledge", "- [[Knowledge]] (index)", ...knowledge.slice(0, 30).map((f) => `- [[${noteName(f)}]]`), "",
    "## Skills", `- [[Skills Index]] — ${learned.length} learned, ${skills.length - learned.length} installed`, "- [[Learning Log]] — what Pi learned, when", "- [[Lessons]] — inbox of lessons waiting for a home", "",
    "## Recent sessions", ...(sessions.length ? sessions.slice(0, 12).map((f) => `- [[${noteName(f)}]]`) : ["- (none yet)"]), "",
  ].join("\n"));

  // Mindmap.canvas (JSON Canvas 1.0)
  const nodes: any[] = [];
  const edges: any[] = [];
  let id = 0;
  const nid = () => `n${++id}`;
  const file = (f: string, x: number, y: number, w = 260, h = 70, color?: string) => {
    const n: any = { id: nid(), type: "file", file: relative(VAULT, f).split(sep).join("/"), x, y, width: w, height: h };
    if (color) n.color = color;
    nodes.push(n);
    return n.id;
  };
  const text = (t: string, x: number, y: number, w = 260, h = 70, color?: string) => {
    const n: any = { id: nid(), type: "text", text: t, x, y, width: w, height: h };
    if (color) n.color = color;
    nodes.push(n);
    return n.id;
  };
  const link = (a: string, b: string) => edges.push({ id: `e${edges.length + 1}`, fromNode: a, toNode: b });
  const home = file(join(VAULT, "Home.md"), -150, -40, 300, 80, "6");
  const hubs: [string, number, number, string][] = [["Memory", -700, -420, "1"], ["Projects", 450, -420, "2"], ["Skills", 450, 380, "5"], ["Knowledge", -700, 380, "4"]];
  for (const [name, x, y, color] of hubs) {
    const hub = text(`## ${name}`, x, y, 220, 60, color);
    link(home, hub);
    let kids: string[] = [];
    if (name === "Memory") kids = [MEM.memory, MEM.user, join(VAULT, "Learning Log.md")].filter(existsSync);
    if (name === "Knowledge") kids = [join(VAULT, "Knowledge", "Knowledge.md"), ...knowledge.slice(0, 10)].filter(existsSync);
    if (name === "Skills") kids = [join(VAULT, "Skills Index.md"), ...learned.slice(0, 10).map((s) => join(s.dir, "SKILL.md"))].filter(existsSync);
    if (name === "Projects") {
      projects.slice(0, 8).forEach((p, i) => {
        const pn = file(join(VAULT, "Projects", p, `${p}.md`), x + 280, y - 160 + i * 190, 260, 70, color);
        link(hub, pn);
        const ps = sessions.filter((f) => read(f).includes(`project: "${p}"`)).slice(0, 3);
        ps.forEach((s, j) => link(pn, file(s, x + 580, y - 160 + i * 190 + j * 60, 300, 50)));
      });
      continue;
    }
    kids.forEach((k, i) => link(hub, file(k, x + (x < 0 ? -320 : 280), y - 120 + i * 85, 280, 70)));
  }
  write(join(VAULT, "Mindmap.canvas"), JSON.stringify({ nodes, edges }, null, 1));
}

function vaultSearch(query: string, limit = 8): string {
  const terms = termsOf(query);
  if (!terms.length) return "empty query";
  const files = walk(VAULT, (f) => /\.md$/i.test(f) && !f.includes(`${sep}Archive${sep}skills${sep}`));
  const hits = files
    .map((f) => {
      const body = read(f);
      const s = score(noteName(f), terms) * 3 + score(body, terms);
      const line = body.split("\n").find((l) => terms.some((w) => l.toLowerCase().includes(w)) && l.trim() && !l.startsWith("---")) || "";
      return { f, s, line };
    })
    .filter((h) => h.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit);
  if (!hits.length) return `No vault notes match "${query}".`;
  return hits.map((h) => `${relative(VAULT, h.f).split(sep).join("/")}: ${clip(oneLine(h.line), 160)}`).join("\n");
}

// ---------------------------------------------------------------- prompt text
const REVIEW_PROMPT = (learned: string) => `[Automatic learning review. This is NOT a message from the user and the user will not see your reply.
Do not call any tool. Reply with ONE JSON object and nothing else.]

Look back over this conversation and extract only what a FUTURE session (which will not see this conversation) needs.
Most turns produce nothing: empty arrays are a good answer.

{"memory": [{"target": "user" | "memory", "text": "one self-contained sentence"}],
 "skills": [{"name": "class-level-kebab-name", "description": "<= 120 chars: what it does + when to use it", "lesson": "an imperative rule plus why, or a short numbered procedure"}],
 "summary": "2-3 sentences: what this session is working on and where it stands"}

What goes where (one fact in ONE place):
- memory target "user": who the user is, their preferences, and every correction of your style, format or workflow ("no", "don't", "I prefer", "stop"). A correction is the most important thing to capture.
- memory target "memory": durable facts about the environment: paths, commands that work, tool quirks, project conventions.
- skills: a reusable procedure or pitfall for a CLASS of task (e.g. "python-cli-testing", never "fix-bug-in-foo"). To add to one of your existing learned skills reuse its exact name. Existing learned skills: ${learned || "(none)"}.
Never save: secrets or keys, one-off task details, errors that were fixed by simply retrying, missing-tool or install errors, claims that a tool "does not work", anything not verified in the conversation, or facts already shown in the MEMORY/USER sections of your instructions.`;

const LEARN_PROMPT = (what: string) => `Turn ${what ? `this into a reusable skill: ${what}` : "what we just did into a reusable skill"}.
Use the learn tool: first action "search" to check whether one of your learned skills already covers this class of task (if so, use action "append" or "patch" on it); otherwise action "create".
Write it for a future session that has never seen this conversation:
- name: class-level, lowercase-kebab (e.g. "nextjs-api-routes", not "fix-login-bug"). description: <= 120 chars, says what it does AND when to use it.
- body sections: "# Title" + 2 lines on what it covers, "## When to use", "## Procedure" (numbered, exact commands), "## Pitfalls" (rule + why), "## Verification" (one check that proves it worked).
- concrete commands and paths that actually worked here; no secrets, no narration of this session.`;

const CURATE_PROMPT = `Curate your long-term knowledge. Work through these steps with the memory, learn and vault tools and keep the user's own notes intact:
1. Read Memory/MEMORY.md and Memory/USER.md (vault read). Merge duplicates, remove stale or one-off entries, keep each under its limit (memory replace/remove).
2. learn action "list": for your learned skills that overlap, merge the smaller into the broader one (learn view, then append/patch), then archive the absorbed one (learn action "archive"). Never touch core or library skills.
3. vault read Inbox/Lessons.md: file each lesson into a learned skill or delete it from the inbox (vault write).
4. Report what you changed in 5 bullets or fewer.`;

// ---------------------------------------------------------------- extension
export default function (pi: ExtensionAPI) {
  let frozen = ""; // system-prompt section, fixed for the whole session
  let project = "General";
  let sessionNote = "";
  let firstPrompt = "";
  let userTurns = 0;
  let turnsSinceReflect = 0;
  let toolCalls = 0;
  let errorsSinceReflect = 0;
  let corrected = false;
  let lastAssistant = "";
  let lastPayload: any;
  let reflecting: AbortController | undefined;

  const abortReflection = () => {
    reflecting?.abort();
    reflecting = undefined;
  };

  function buildSection(cwd: string): string {
    project = projectOf(cwd);
    const mem = memEntries("memory");
    const usr = memEntries("user");
    const warn = (t: Target, e: string[]) =>
      memSize(e) > MEM_LIMIT[t] * 0.85 ? ` (nearly full: ${memSize(e)}/${MEM_LIMIT[t]}; merge entries with memory replace/remove)` : "";
    const pnote = join(VAULT, "Projects", project, `${project}.md`);
    const psum = existsSync(pnote) ? (read(pnote).match(/## Summary\n([\s\S]*?)(\n## |$)/)?.[1] || "").trim() : "";
    return [
      `You learn across sessions. Long-term knowledge lives in an Obsidian vault at ${VAULT}:`,
      "- memory tool: save a durable fact (target memory) or the user's preference/correction (target user) the moment you learn it.",
      "- learn tool: before unfamiliar work, search the skill library (more skills than the list above); after solving a reusable problem, save the procedure or pitfall as a skill.",
      "- vault tool: search past sessions, project notes and knowledge when the user refers to earlier work; write Knowledge/ notes for things worth keeping.",
      `Current project: ${project} (vault note Projects/${project}/${project}.md)${psum && !psum.startsWith("(Pi fills") ? `: ${clip(oneLine(psum), 400)}` : ""}`,
      "",
      `## MEMORY (environment facts)${warn("memory", mem)}`,
      ...(mem.length ? mem.map((e) => `- ${e}`) : ["- (empty)"]),
      "",
      `## USER (profile and preferences)${warn("user", usr)}`,
      ...(usr.length ? usr.map((e) => `- ${e}`) : ["- (empty)"]),
    ].join("\n");
  }

  // A resumed session keeps writing to the note it already has (matched by Pi session id in the frontmatter).
  function findSessionNote(sid: string): string {
    if (!sid) return "";
    for (const f of walk(join(VAULT, "Sessions"), (p) => p.endsWith(".md")))
      if (read(f).slice(0, 600).includes(`pi_session: "${sid}"`)) return f;
    return "";
  }

  function ensureSessionNote(ctx: any) {
    if (sessionNote) return;
    const title = slug(firstPrompt.split("\n")[0] || "session");
    sessionNote = join(VAULT, "Sessions", `${stamp()} ${title}.md`);
    let sid = "";
    try {
      sid = ctx.sessionManager.getSessionId();
    } catch {
      /* optional */
    }
    write(sessionNote, [
      "---", "tags: [session]", `project: "${project}"`, `date: ${today()}`, `model: "${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "?"}"`,
      `cwd: "${String(ctx.cwd).replace(/\\/g, "/")}"`, `pi_session: "${sid}"`, "---", `# ${title}`, `Project: [[${project}]]`, "",
      "## Request", "> " + clip(firstPrompt.trim(), 800).replace(/\n/g, "\n> "), "", "## Summary", "(updated automatically)", "", "## Lessons", "",
    ].join("\n"));
    appendUnder(projectNote(project), "Sessions", `- [[${noteName(sessionNote)}]]`);
    rebuildIndexes();
  }

  // apply the JSON a reflection returned
  function applyReview(r: any, ctx: any): string[] {
    const done: string[] = [];
    for (const m of (Array.isArray(r?.memory) ? r.memory : []).slice(0, 3)) {
      const t: Target = m?.target === "user" ? "user" : "memory";
      if (!m?.text) continue;
      const res = memoryOp("add", t, String(m.text));
      if (res.ok && !res.msg.includes("already")) {
        done.push(`${t === "user" ? "USER" : "MEMORY"}: ${oneLine(m.text)}`);
        logLearning(`[[${t === "user" ? "USER" : "MEMORY"}]] ${oneLine(m.text)}`);
      } else if (!res.ok && res.msg.includes("full")) {
        appendFileSync(join(VAULT, "Inbox", "Lessons.md"), `- (${t} memory full) ${oneLine(m.text)}\n`, "utf8");
      }
    }
    const skills = allSkills();
    for (const s of (Array.isArray(r?.skills) ? r.skills : []).slice(0, 2)) {
      const name = String(s?.name || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
      const lesson = String(s?.lesson || "").trim();
      if (!name || !lesson || threat(lesson)) continue;
      const existing = skills.find((x) => x.name === name);
      try {
        if (existing?.tier === "learned") {
          if (appendToSkill(name, "Pitfalls", lesson) === "appended") {
            done.push(`skill ${name}: +lesson`);
            logLearning(`[[Skills/${name}/SKILL|${name}]] +lesson: ${clip(oneLine(lesson), 140)}`);
          }
        } else if (existing) {
          appendFileSync(join(VAULT, "Inbox", "Lessons.md"), `- ${today()} (for ${existing.tier} skill ${name}) ${oneLine(lesson)}\n`, "utf8");
          done.push(`lesson for ${name} -> Inbox`);
        } else {
          createSkill(name, String(s?.description || lesson).slice(0, 160), `## Pitfalls\n- ${lesson.replace(/\n+/g, "\n  ")}`);
          done.push(`new skill ${name}`);
          logLearning(`new skill [[Skills/${name}/SKILL|${name}]]: ${clip(oneLine(String(s?.description || "")), 140)}`);
        }
      } catch {
        /* invalid name or clash: skip */
      }
    }
    if (typeof r?.summary === "string" && r.summary.trim()) {
      ensureSessionNote(ctx);
      replaceSection(sessionNote, "Summary", r.summary.trim());
    }
    if (done.length && sessionNote) for (const d of done) appendUnder(sessionNote, "Lessons", `- ${d}`);
    if (done.length) rebuildIndexes();
    return done;
  }

  // after a failed review wait a full interval instead of retrying after every turn
  function backoff() {
    turnsSinceReflect = 0;
    errorsSinceReflect = 0;
    corrected = false;
  }

  // Background review that reuses the exact prefix of the last request (llama-server keeps it cached).
  async function reflect(ctx: any, manual = false): Promise<string> {
    const model = ctx.model;
    const wire = (globalThis as any).__piLearningLastWire;
    const base = wire && Array.isArray(wire.messages) ? wire : lastPayload;
    if (!base || !Array.isArray(base.messages)) return "nothing to review yet";
    if (model?.api !== "openai-completions" || !model?.baseUrl) return `reflection needs an OpenAI-compatible model (have ${model?.api})`;
    abortReflection();
    const ac = new AbortController();
    reflecting = ac;
    const timer = setTimeout(() => ac.abort(), 240_000);
    const learned = allSkills().filter((s) => s.tier === "learned").map((s) => s.name).join(", ");
    const payload: any = {
      ...base,
      stream: true,
      max_tokens: 1500,
      messages: [
        ...base.messages,
        ...(lastAssistant ? [{ role: "assistant", content: lastAssistant }] : []),
        { role: "user", content: REVIEW_PROMPT(learned) },
      ],
    };
    delete payload.max_completion_tokens;
    try {
      const key = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
      // Send the captured body unchanged, beneath any fetch wrappers that rewrite messages (they would change the prefix).
      const base0 = model.baseUrl.replace(/\/+$/, "");
      const wireUrl = String((globalThis as any).__piLearningLastWireUrl || "");
      const sameServer = wire && wireUrl.startsWith(base0); // never send this provider's key to another model's URL
      const rawFetch = (sameServer && (globalThis as any).__piLearningOrigFetch) || fetch;
      const url = sameServer ? wireUrl : base0 + "/chat/completions";
      const res = await rawFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pi-learning": "1", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      let out = "";
      let buf = "";
      let timings: any;
      let rawTail: string[] = [];
      const t0 = Date.now();
      const dec = new TextDecoder();
      for await (const chunk of res.body as any) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) rawTail = [...rawTail.slice(-2), line.slice(0, 600)];
          if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
          try {
            const j = JSON.parse(line.slice(5));
            out += j.choices?.[0]?.delta?.content ?? "";
            if (j.timings) timings = j.timings;
          } catch {
            /* keep-alive or partial */
          }
        }
      }
      // llama-server timings: cache_n = prompt tokens reused from the cache, prompt_n = tokens processed anew
      const debug = `${stamp()} reflect src=${wire ? "wire" : "hook"} ${Math.round((Date.now() - t0) / 1000)}s cache_n=${timings?.cache_n ?? "?"} prompt_n=${timings?.prompt_n ?? "?"} predicted_n=${timings?.predicted_n ?? "?"}`;
      if (process.env.PI_LEARN_DEBUG === "1") {
        write(join(VAULT, ".pi-learning-review.json"), JSON.stringify({ wireUrl: (globalThis as any).__piLearningLastWireUrl, modelBaseUrl: model.baseUrl, payload, out, rawTail }, null, 1));
      }
      const a = out.indexOf("{");
      const b = out.lastIndexOf("}");
      let parsed: any;
      try {
        parsed = a >= 0 && b > a ? JSON.parse(out.slice(a, b + 1)) : undefined;
      } catch {
        parsed = undefined;
      }
      if (!parsed) {
        appendFileSync(join(VAULT, ".pi-learning.log"), `${debug} no-json: ${clip(oneLine(out), 300)}\n`, "utf8");
        backoff();
        return "review returned no usable JSON";
      }
      const done = applyReview(parsed, ctx);
      appendFileSync(join(VAULT, ".pi-learning.log"), `${debug} -> ${done.join("; ") || "nothing"}\n`, "utf8");
      turnsSinceReflect = 0;
      errorsSinceReflect = 0;
      corrected = false;
      const msg = done.length ? `learned: ${done.join("; ")}` : "nothing new to learn";
      if (done.length || manual) {
        try {
          ctx.ui.notify(`pi-learning: ${msg}`, "info");
        } catch {
          /* session gone */
        }
      }
      return msg;
    } catch (e: any) {
      const msg = ac.signal.aborted ? "review cancelled (you typed)" : `review failed: ${e?.message || e}`;
      try {
        appendFileSync(join(VAULT, ".pi-learning.log"), `${stamp()} reflect ${msg}\n`, "utf8");
      } catch {
        /* vault missing */
      }
      if (!ac.signal.aborted) backoff();
      return msg;
    } finally {
      clearTimeout(timer);
      if (reflecting === ac) reflecting = undefined;
    }
  }

  // ------------------------------------------------------------ tools
  pi.registerTool({
    name: "memory",
    label: "Memory",
    description:
      "Memory loaded into every new session. target user: preferences, corrections, profile. target memory: durable environment facts. One fact per entry.",
    promptSnippet: "Save durable facts and user preferences for future sessions",
    promptGuidelines: ["When the user corrects you or states a preference, save it with memory (target user) before continuing."],
    parameters: Type.Object({
      action: StringEnum(["add", "replace", "remove"] as const),
      target: StringEnum(["memory", "user"] as const),
      text: Type.Optional(Type.String({ description: "one sentence (add/replace)" })),
      old_text: Type.Optional(Type.String({ description: "unique part of the entry (replace/remove)" })),
    }),
    async execute(_id, p) {
      const r = memoryOp(p.action, p.target, p.text, p.old_text);
      if (r.ok && p.action !== "remove" && p.text && !r.msg.includes("already"))
        logLearning(`[[${p.target === "user" ? "USER" : "MEMORY"}]] ${oneLine(p.text)}`);
      return { content: [{ type: "text", text: r.msg }], details: {}, isError: !r.ok } as any;
    },
  });

  pi.registerTool({
    name: "learn",
    label: "Learn",
    description:
      "Skills: search/list/view any skill (incl. an unlisted library); create/append/patch/archive your own learned skills.",
    promptSnippet: "Find skills (incl. the unlisted library) or save a reusable procedure as a skill",
    promptGuidelines: ["Before a task type you have no skill listed for (e.g. a semgrep scan, an a11y audit), call learn search first."],
    parameters: Type.Object({
      action: StringEnum(["search", "list", "view", "create", "append", "patch", "archive"] as const),
      query: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      file: Type.Optional(Type.String({ description: "view: file inside the skill, e.g. references/x.md" })),
      description: Type.Optional(Type.String({ description: "create: <=120 chars, what + when" })),
      content: Type.Optional(Type.String({ description: "create: markdown body; append: text to add" })),
      section: Type.Optional(Type.String({ description: "append: heading (default Pitfalls)" })),
      old_text: Type.Optional(Type.String({ description: "patch: exact text, matched once" })),
      new_text: Type.Optional(Type.String()),
    }),
    async execute(_id, p) {
      const ok = (text: string) => ({ content: [{ type: "text", text }], details: {} }) as any;
      const fail = (text: string) => ({ content: [{ type: "text", text }], details: {}, isError: true }) as any;
      try {
        const skills = allSkills();
        if (p.action === "list") {
          return ok(["learned", "core", "library"].map((t) => `${t}: ${skills.filter((s) => s.tier === t).map((s) => s.name).join(", ") || "(none)"}`).join("\n"));
        }
        if (p.action === "search") {
          const terms = termsOf(p.query || p.name || "");
          const hits = skills
            .map((s) => ({ s, sc: score(s.name, terms) * 2 + score(s.description, terms) + score(read(join(s.dir, "SKILL.md")).slice(0, 4000), terms) * 0.3 }))
            .filter((h) => h.sc > 0.5)
            .sort((a, b) => b.sc - a.sc)
            .slice(0, 6);
          if (!hits.length) return ok(`No skill matches "${p.query}". Proceed without one; if you solve it well, save it with learn create.`);
          return ok(hits.map(({ s }) => `${s.name} [${s.tier}] — ${s.description}\n  ${join(s.dir, "SKILL.md")}`).join("\n") + "\nLoad one with learn view (name).");
        }
        const sk = skills.find((s) => s.name === p.name);
        if (p.action === "view") {
          if (!sk) return fail(`No skill named ${p.name}. Use learn search.`);
          const f = p.file ? resolve(sk.dir, p.file) : join(sk.dir, "SKILL.md");
          if (!inside(sk.dir, f) && f !== join(sk.dir, "SKILL.md")) return fail("file must be inside the skill folder");
          if (!existsSync(f)) return fail(`not found: ${f}`);
          const body = read(f);
          return ok(`${clip(body, 16000)}\n\n[skill folder: ${sk.dir} — read bundled files relative to it]`);
        }
        if (p.action === "create") {
          const f = createSkill(String(p.name || ""), String(p.description || ""), String(p.content || ""));
          logLearning(`new skill [[Skills/${p.name}/SKILL|${p.name}]]: ${oneLine(String(p.description))}`);
          rebuildIndexes();
          return ok(`Created ${f}. It is listed to the model from the next session (or after /reload).`);
        }
        if (!sk) return fail(`No skill named ${p.name}.`);
        if (sk.tier !== "learned") return fail(`${p.name} is a downloaded ${sk.tier} skill and read-only. Save the lesson in your own skill (learn create/append) instead.`);
        if (p.action === "append") {
          const r = appendToSkill(sk.name, p.section || "Pitfalls", String(p.content || ""));
          if (r === "appended") logLearning(`[[Skills/${basename(sk.dir)}/SKILL|${sk.name}]] +${p.section || "Pitfalls"}: ${clip(oneLine(String(p.content)), 140)}`);
          return ok(`${sk.name}: ${r}.`);
        }
        if (p.action === "patch") {
          const f = join(sk.dir, "SKILL.md");
          const md = read(f);
          const n = p.old_text ? md.split(p.old_text).length - 1 : 0;
          if (n !== 1) return fail(`old_text must match exactly once (matched ${n}). View the skill first.`);
          const bad = threat(String(p.new_text || ""));
          if (bad) return fail(bad);
          write(f, touchUpdated(md.replace(p.old_text!, String(p.new_text ?? ""))));
          logLearning(`[[Skills/${basename(sk.dir)}/SKILL|${sk.name}]] patched`);
          return ok(`${sk.name} patched.`);
        }
        if (p.action === "archive") {
          mkdirSync(SKILL_ARCHIVE, { recursive: true });
          renameSync(sk.dir, join(SKILL_ARCHIVE, `${basename(sk.dir)}-${today()}`));
          logLearning(`archived skill ${sk.name}`);
          rebuildIndexes();
          return ok(`${sk.name} archived to ${SKILL_ARCHIVE} (recoverable).`);
        }
        return fail(`unknown action ${p.action}`);
      } catch (e: any) {
        return fail(String(e?.message || e));
      }
    },
  });

  pi.registerTool({
    name: "vault",
    label: "Vault",
    description:
      "Knowledge vault (Obsidian): search past sessions/projects/notes, read, write or append notes (e.g. Knowledge/<Topic>.md). Link with [[Note]].",
    promptSnippet: "Search, read and write the long-term knowledge vault (past sessions, projects, knowledge notes)",
    parameters: Type.Object({
      action: StringEnum(["search", "read", "write", "append", "list"] as const),
      query: Type.Optional(Type.String()),
      path: Type.Optional(Type.String({ description: "relative to the vault, e.g. Knowledge/Postgres.md" })),
      content: Type.Optional(Type.String()),
    }),
    async execute(_id, p) {
      const ok = (text: string) => ({ content: [{ type: "text", text }], details: {} }) as any;
      const fail = (text: string) => ({ content: [{ type: "text", text }], details: {}, isError: true }) as any;
      try {
        if (p.action === "search") return ok(vaultSearch(String(p.query || "")));
        if (p.action === "list") {
          const dir = p.path ? resolve(VAULT, String(p.path)) : VAULT;
          if (dir !== VAULT && !inside(VAULT, dir)) return fail("path must stay inside the vault");
          return ok(walk(dir, (f) => /\.(md|canvas)$/i.test(f)).slice(0, 100).map((f) => relative(VAULT, f).split(sep).join("/")).join("\n") || "(empty)");
        }
        const f = vaultPath(String(p.path || ""));
        if (p.action === "read") return existsSync(f) ? ok(clip(read(f), 14000)) : fail(`no note at ${p.path}. Try vault search.`);
        const rel = relative(VAULT, f);
        if (/^(Memory|Skills)[\\/]/i.test(rel)) return fail("Memory/ and Skills/ are written with the memory and learn tools.");
        const bad = threat(String(p.content || ""));
        if (bad) return fail(bad);
        if (p.action === "write") {
          const isNew = !existsSync(f);
          write(f, String(p.content || ""));
          if (isNew && /^Knowledge[\\/]/i.test(rel) && noteName(f) !== "Knowledge") {
            appendUnder(join(VAULT, "Knowledge", "Knowledge.md"), "Notes", `- [[${noteName(f)}]]`);
            logLearning(`knowledge note [[${noteName(f)}]]`);
          }
          rebuildIndexes();
          return ok(`Saved ${rel}.`);
        }
        if (p.action === "append") {
          if (!existsSync(f)) write(f, "");
          appendFileSync(f, "\n" + String(p.content || "").trim() + "\n", "utf8");
          return ok(`Appended to ${rel}.`);
        }
        return fail(`unknown action ${p.action}`);
      } catch (e: any) {
        return fail(String(e?.message || e));
      }
    },
  });

  // ------------------------------------------------------------ lifecycle
  pi.on("session_start", async (_e, ctx) => {
    frozen = buildSection(ctx.cwd);
    sessionNote = "";
    try {
      sessionNote = findSessionNote(ctx.sessionManager.getSessionId());
    } catch {
      /* new session */
    }
    firstPrompt = "";
    userTurns = turnsSinceReflect = toolCalls = errorsSinceReflect = 0;
    corrected = false;
    lastPayload = undefined;
    (globalThis as any).__piLearningLastWire = undefined;
    try {
      rebuildIndexes();
    } catch {
      /* vault missing: tools will report it */
    }
  });

  pi.on("before_agent_start", async (event: any, ctx) => {
    abortReflection();
    if (!frozen) frozen = buildSection(ctx.cwd);
    if (event.systemPromptOptions?.sections) event.systemPromptOptions.sections["long_term_memory"] = frozen;
    if (event.messageType === "user") {
      const prompt = String(event.prompt || "");
      if (!firstPrompt) firstPrompt = prompt;
      userTurns++;
      turnsSinceReflect++;
      if (/^(no|nope|wrong|stop|don'?t|do not|never|actually|instead|i (prefer|asked|said)|that'?s not|why did you)\b/i.test(prompt.trim()))
        corrected = true;
    }
  });

  pi.on("input", async () => {
    abortReflection();
    return { action: "continue" } as any;
  });

  // Remember the exact request so a reflection can reuse its cached prefix. Other extensions may still rewrite the
  // payload after this handler runs, so the authoritative copy is the request body actually sent (fetch wrapper below);
  // the hook is only a fallback.
  pi.on("before_provider_request", (event: any, ctx) => {
    const p = event.payload;
    if (!p || !Array.isArray(p.messages) || wireSeen) return;
    let tools = p.tools;
    if (ctx.model?.provider === "inkling" && process.env.PI_INKLING_KEEP_BILI !== "1" && Array.isArray(tools))
      tools = tools.filter((t: any) => !BILI_TOOL.test(String((t.function ?? t).name ?? "")));
    lastPayload = { ...p, tools };
  });
  let wireSeen = false;
  const g: any = globalThis as any;
  if (!g.__piLearningFetch) {
    const orig = g.fetch.bind(g);
    g.__piLearningFetch = true;
    g.__piLearningOrigFetch = orig; // the fetch below any wrapper installed later (e.g. a context-compression proxy)
    g.fetch = (input: any, init?: any) => {
      try {
        const url = typeof input === "string" ? input : input?.url ?? String(input);
        const hdrs = init?.headers;
        const ours = hdrs && (typeof hdrs.get === "function" ? hdrs.get("x-pi-learning") : hdrs["x-pi-learning"]);
        if (!ours && /\/chat\/completions(\?|$)/.test(url) && typeof init?.body === "string" && init.body.includes('"tools"')) {
          const body = JSON.parse(init.body);
          // only agent turns (they carry tools); side calls such as the compaction summary do not
          if (Array.isArray(body.messages) && Array.isArray(body.tools) && body.tools.length > 0) {
            g.__piLearningLastWire = body;
            g.__piLearningLastWireUrl = url;
          }
        }
      } catch {
        /* observing only */
      }
      return orig(input, init);
    };
  }

  pi.on("agent_end", async (event: any) => {
    const msgs = Array.isArray(event.messages) ? event.messages : [];
    for (const m of msgs) {
      if (m?.role === "toolResult") {
        toolCalls++;
        if (m.isError) errorsSinceReflect++;
      }
    }
    const last = [...msgs].reverse().find((m: any) => m?.role === "assistant");
    if (last) lastAssistant = textOf(last.content);
  });

  pi.on("agent_settled", async (event: any, ctx) => {
    if (event.aborted) return;
    if (!sessionNote && firstPrompt && (userTurns >= 2 || toolCalls >= 3)) {
      try {
        ensureSessionNote(ctx);
      } catch {
        /* vault not writable */
      }
    }
    // no model call: keep the latest answer in the note so even sessions that never reflect are useful to look back at
    if (sessionNote && lastAssistant.trim()) {
      try {
        replaceSection(sessionNote, "Latest result", clip(lastAssistant.trim(), 700));
      } catch {
        /* best effort */
      }
    }
    const due = turnsSinceReflect >= REFLECT_EVERY || (corrected && turnsSinceReflect >= 1) || (errorsSinceReflect > 0 && turnsSinceReflect >= 2);
    if (REFLECT_ON && due && userTurns >= 2) void reflect(ctx);
  });

  pi.on("session_compact", async (event: any, ctx) => {
    (globalThis as any).__piLearningLastWire = undefined; // the conversation prefix changed
    lastPayload = undefined;
    const s = String(event.compactionEntry?.summary || "");
    const start = s.indexOf("## ");
    const end = s.indexOf("\n# Verbatim record");
    if (start < 0) return;
    try {
      ensureSessionNote(ctx);
      replaceSection(sessionNote, "Working memory (latest compaction)", s.slice(start, end > start ? end : undefined).replace(/^## /gm, "### "));
    } catch {
      /* best effort */
    }
  });

  pi.on("session_shutdown", async () => abortReflection());

  // ------------------------------------------------------------ commands
  pi.registerCommand("learn", {
    description: "Turn what we just did (or what you describe) into a reusable skill",
    handler: async (args) => {
      pi.sendUserMessage(LEARN_PROMPT(String(args || "").trim()));
    },
  });
  pi.registerCommand("reflect", {
    description: "Run the learning review now (saves memory/skills from this session)",
    handler: async (_args, ctx) => {
      ctx.ui.notify("pi-learning: reviewing this session...", "info");
      const r = await reflect(ctx, true);
      ctx.ui.notify(`pi-learning: ${r}`, "info");
    },
  });
  pi.registerCommand("curate", {
    description: "Consolidate memory and learned skills (merge duplicates, archive absorbed skills)",
    handler: async () => pi.sendUserMessage(CURATE_PROMPT),
  });
  pi.registerCommand("vault", {
    description: "Show vault status and rebuild Home, Skills Index and Mindmap",
    handler: async (_args, ctx) => {
      rebuildIndexes();
      const sk = allSkills();
      ctx.ui.notify(
        [`Vault: ${VAULT} (open it in Obsidian)`, `Project: ${project}${sessionNote ? `  session note: ${noteName(sessionNote)}` : ""}`,
          `MEMORY.md ${memSize(memEntries("memory"))}/${MEM_LIMIT.memory} chars, USER.md ${memSize(memEntries("user"))}/${MEM_LIMIT.user}`,
          `Skills: ${sk.filter((s) => s.tier === "learned").length} learned, ${sk.filter((s) => s.tier === "core").length} core, ${sk.filter((s) => s.tier === "library").length} library`,
          `Reflection every ${REFLECT_EVERY} turns${REFLECT_ON ? "" : " (disabled)"}; ${turnsSinceReflect} turns since the last one.`].join("\n"),
        "info",
      );
    },
  });
}
