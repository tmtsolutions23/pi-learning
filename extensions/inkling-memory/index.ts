/**
 * inkling-memory: working memory that survives Pi's context compaction, for the small-context local Inkling model.
 *
 * Active only while the model provider is "inkling" (set PI_MEMORY_ALL=1 to use it with every model).
 *
 * What it does
 * - Replaces Pi's compaction summary with a structured "working memory" that is MERGED across compactions instead of
 *   re-summarized from a summary each time:
 *     * model-written sections (goal, decisions, progress, pitfalls, next steps), updated from the previous memory
 *     * verbatim sections that the model cannot distort: the user's requests, pinned notes, recent errors, file lists
 * - `remember` tool: the model saves a short note that is copied verbatim into every future memory.
 * - `/remember <text>` pins a note yourself; `/memory` shows the current memory.
 * - Each memory snapshot is also written to ~/.pi/agent/inkling-memory/<session-id>.md for inspection.
 *
 * Why the compaction summary (not the system prompt): the llama-server prompt cache keeps Pi's ~20K-token prefix;
 * changing the system prompt every turn would throw that away. The summary only changes when a compaction happens.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const NOTE_TYPE = "inkling-memory-note";
const MEMORY_DIR = join(homedir(), ".pi", "agent", "inkling-memory");
const MAX_NOTES = 40;
const MAX_REQUESTS = 6; // first request + the last (MAX_REQUESTS - 1)
const MAX_FILES = 30;
const MAX_CONVO_CHARS = 90_000; // ~25K tokens of transcript per memory update

type Note = { kind: string; note: string; ts: number; source: "model" | "user" };
type MemoryDetails = { inklingMemory: 1; requests: string[]; read: string[]; modified: string[]; notes: number };

function isActive(ctx: { model?: { provider?: string } }): boolean {
  return process.env.PI_MEMORY_ALL === "1" || ctx.model?.provider === "inkling";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}

function clip(s: string, n: number): string {
  s = s.replace(/\s+\n/g, "\n").trim();
  return s.length <= n ? s : s.slice(0, n) + ` [...${s.length - n} more chars]`;
}

function lastMemoryDetails(entries: any[]): MemoryDetails | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "compaction" && e.details?.inklingMemory === 1) return e.details as MemoryDetails;
  }
  return undefined;
}

function collectNotes(entries: any[]): Note[] {
  const seen = new Set<string>();
  const notes: Note[] = [];
  for (const e of entries) {
    if (e?.type !== "custom" || e.customType !== NOTE_TYPE || !e.data?.note) continue;
    const key = String(e.data.note).trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push(e.data as Note);
  }
  return notes.slice(-MAX_NOTES);
}

function mergeRecent(prev: string[], next: string[], cap: number): string[] {
  const out = [...prev];
  for (const x of next) {
    const i = out.indexOf(x);
    if (i >= 0) out.splice(i, 1);
    out.push(x);
  }
  return out.slice(-cap);
}

// The model-written "## ..." sections only: drops any header text before the first "## " and anything from the first
// top-level "# " heading after it (e.g. a "# Verbatim record" the model copied), so the record is never duplicated.
function modelPart(text: string | undefined): string {
  if (!text) return "";
  const start = text.indexOf("## ");
  if (start < 0) return "";
  const body = text.slice(start);
  const m = body.match(/\n# /);
  return (m && m.index !== undefined ? body.slice(0, m.index) : body).trim();
}

function renderNotes(notes: Note[]): string {
  if (!notes.length) return "- (none)";
  return notes.map((n) => `- [${n.kind}${n.source === "user" ? ", from user" : ""}] ${n.note}`).join("\n");
}

const MEMORY_INSTRUCTIONS = `You maintain the WORKING MEMORY of a coding agent whose context window is small. Older conversation is being
deleted; only what you write here survives. Update the previous memory with the new conversation below.

Rules:
- Output ONLY these markdown sections, in this order, with these exact headings:
  ## Goal
  ## Constraints & Preferences
  ## Key Decisions
  ## Progress
  ## Pitfalls & Fixed Errors
  ## Next Steps
  ## Critical Context
- MERGE: keep every still-relevant item from the previous memory, add new ones, update changed ones, drop only items that
  are clearly obsolete. Never drop user constraints or decisions unless the user reversed them.
- Be concrete: exact file paths, function names, commands that worked, error messages and their fixes, values, URLs.
- Pitfalls & Fixed Errors: every mistake made so far and how it was fixed, so it is not repeated.
- Progress: "Done:" and "In progress:" bullets. Next Steps: numbered, most important first.
- Use short bullets. Stay under 700 words in total. No preamble, no closing remarks.
- Output ONLY the seven sections above. Do NOT write a "Verbatim record", user-request list, notes list, error list or file
  lists: those are added automatically after your text.
- The conversation excerpt is NOT the latest state: newer messages follow it that you cannot see. The saved notes may be
  newer than the excerpt and are authoritative. Never call a saved note stale, aspirational or unverified; if it adds
  something the excerpt does not show (e.g. a new command), include it in Progress as done.`;

export default function (pi: ExtensionAPI) {
  // ---- tool: remember --------------------------------------------------------------------------------------
  pi.registerTool({
    name: "remember",
    label: "Remember",
    description:
      "Save a short note to long-term working memory so it survives context compaction. Use for user preferences, decisions, " +
      "facts you discovered (paths, commands, APIs), errors you fixed, and open todos.",
    promptSnippet: "Save a note that must survive context compaction",
    promptGuidelines: [
      "Use remember right after you make a decision, learn a fact about the project, or fix an error; keep each note to one sentence.",
    ],
    parameters: Type.Object({
      note: Type.String({ description: "One self-contained sentence." }),
      kind: StringEnum(["decision", "fact", "pitfall", "todo", "preference"] as const, {
        description: "What kind of note this is.",
      }),
    }),
    async execute(_id, params) {
      pi.appendEntry<Note>(NOTE_TYPE, { kind: params.kind, note: params.note.trim(), ts: Date.now(), source: "model" });
      return { content: [{ type: "text", text: "Saved to working memory." }], details: {} };
    },
  });

  // Tool set per model. For Inkling: add `remember`, and hide sub-agent tools. Their definitions cost ~10K tokens of the
  // small window, and every sub-agent is a separate conversation that evicts the main session's prompt cache on the
  // single-slot local server (~2 min re-read per switch). PI_INKLING_KEEP_TOOLS="a,b" keeps named tools anyway.
  // Hidden tools are restored when you switch to another model.
  const HIDE_FOR_INKLING = ["SubagentWorkflow", "Agent", "get_subagent_result", "steer_subagent", "subagent", "bg_wait",
    "contact_supervisor", "subagent_supervisor"];
  let hiddenByUs: string[] = [];
  const syncTool = (ctx: { model?: { provider?: string } }) => {
    const keep = new Set((process.env.PI_INKLING_KEEP_TOOLS || "").split(",").map((s) => s.trim()).filter(Boolean));
    let active = pi.getActiveTools();
    if (isActive(ctx)) {
      const hide = HIDE_FOR_INKLING.filter((t) => active.includes(t) && !keep.has(t));
      hiddenByUs = [...new Set([...hiddenByUs, ...hide])];
      active = active.filter((t) => !hide.includes(t));
      if (!active.includes("remember")) active = [...active, "remember"];
    } else {
      active = [...new Set([...active.filter((t) => t !== "remember"), ...hiddenByUs])];
      hiddenByUs = [];
    }
    pi.setActiveTools(active);
  };
  pi.on("session_start", async (_e, ctx) => syncTool(ctx));
  pi.on("model_select", async (_e, ctx) => syncTool(ctx));
  // some packages register their tools after session_start; re-apply before each run (no-op when nothing changed)
  // Skills that need the hidden sub-agent tools, or only display package info, are dropped from Inkling's skill list
  // (~550 tokens). Other models still see them. PI_INKLING_KEEP_TOOLS also accepts these skill names.
  const HIDE_SKILLS_FOR_INKLING = ["pi-subagents", "council-mode", "ponytail-gain", "ponytail-help"];
  pi.on("before_agent_start", async (e: any, ctx) => {
    syncTool(ctx);
    const skills = e.systemPromptOptions?.skills;
    if (isActive(ctx) && Array.isArray(skills)) {
      const keep = new Set((process.env.PI_INKLING_KEEP_TOOLS || "").split(",").map((s) => s.trim()));
      for (let i = skills.length - 1; i >= 0; i--)
        if (HIDE_SKILLS_FOR_INKLING.includes(skills[i]?.name) && !keep.has(skills[i].name)) skills.splice(i, 1);
    }
  });

  // billion-context injects its own context tools (compress, decompress, search_context, acp_*) into every request.
  // For Inkling they cost ~2K tokens of the window and compete with this extension's compaction, so drop them from
  // Inkling requests only. PI_INKLING_KEEP_BILI=1 keeps them.
  const BILI_TOOL = /^(acp_[a-z_]+|compress|decompress|search_context)$/;
  pi.on("before_provider_request", (event: any, ctx) => {
    if (!isActive(ctx) || process.env.PI_INKLING_KEEP_BILI === "1") return;
    const p = event.payload;
    if (!p || !Array.isArray(p.tools)) return;
    const tools = p.tools.filter((t: any) => !BILI_TOOL.test(String((t.function ?? t).name ?? "")));
    if (tools.length === p.tools.length) return;
    return { ...p, tools };
  });

  // ---- commands --------------------------------------------------------------------------------------------
  pi.registerCommand("remember", {
    description: "Pin a note into the working memory (survives compaction)",
    handler: async (args, ctx) => {
      const note = (args || "").trim();
      if (!note) return ctx.ui.notify("Usage: /remember <note>", "warning");
      pi.appendEntry<Note>(NOTE_TYPE, { kind: "preference", note, ts: Date.now(), source: "user" });
      ctx.ui.notify("Pinned to working memory.", "info");
    },
  });

  pi.registerCommand("memory", {
    description: "Show the current working memory",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getBranch() as any[];
      let summary = "";
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.type === "compaction") {
          summary = entries[i].summary;
          break;
        }
      }
      const notes = collectNotes(entries);
      const text = (summary || "(no compaction yet)") + "\n\n## Notes saved so far\n" + renderNotes(notes);
      ctx.ui.notify(text, "info");
    },
  });

  // ---- compaction --------------------------------------------------------------------------------------------
  pi.on("session_before_compact", async (event, ctx) => {
    if (!isActive(ctx) || !ctx.model) return; // default compaction for other models

    const { preparation, branchEntries, customInstructions, signal } = event;
    const messages = convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]);
    const prevDetails = lastMemoryDetails(branchEntries as any[]);

    // verbatim: user requests (first one ever + most recent), errors, files, notes
    const userTexts = messages.filter((m: any) => m.role === "user").map((m: any) => textOf(m.content)).filter((t: string) => t.trim());
    const newRequests = userTexts.map((t: string) => clip(t, 700));
    const prevReq = prevDetails?.requests ?? [];
    // the first request is usually the project brief: keep it much longer than the others
    const first = prevReq[0] ?? (userTexts[0] ? clip(userTexts[0], 2500) : undefined);
    const tail = mergeRecent(prevReq.slice(1), newRequests.filter((r) => r !== first), MAX_REQUESTS - 1);
    const requests = first ? [first, ...tail] : tail;

    const errors = messages
      .filter((m: any) => m.role === "toolResult")
      // real failures only: flagged tool errors, non-zero exit codes, Python tracebacks (not code that merely says "error")
      .filter((m: any) => m.isError || /exited with code [1-9]|^Traceback \(most recent call last\)/im.test(textOf(m.content)))
      .slice(-4)
      .map((m: any) => `- ${m.toolName}: ${clip(textOf(m.content), 300)}`);

    const ops = preparation.fileOps;
    const read = mergeRecent(prevDetails?.read ?? [], [...(ops?.read ?? [])], MAX_FILES);
    const modified = mergeRecent(prevDetails?.modified ?? [], [...(ops?.written ?? []), ...(ops?.edited ?? [])], MAX_FILES);
    const notes = collectNotes(branchEntries as any[]);

    // model-written part
    let convo = serializeConversation(messages);
    if (convo.length > MAX_CONVO_CHARS) {
      convo = convo.slice(0, 8_000) + "\n[... middle of the conversation omitted ...]\n" + convo.slice(-(MAX_CONVO_CHARS - 8_000));
    }
    const prompt =
      MEMORY_INSTRUCTIONS +
      (customInstructions ? `\n\nExtra focus requested by the user: ${customInstructions}` : "") +
      `\n\n<previous-memory>\n${modelPart(preparation.previousSummary) || "(none yet)"}\n</previous-memory>` +
      `\n\n<notes-saved-by-the-agent>\n${renderNotes(notes)}\n</notes-saved-by-the-agent>` +
      `\n\n<new-conversation>\n${convo}\n</new-conversation>\n\nWrite the updated working memory now.`;

    let written = "";
    let usage: any;
    try {
      ctx.ui.notify(`inkling-memory: updating working memory (${preparation.tokensBefore.toLocaleString()} tokens)...`, "info");
      const stream = ctx.modelRegistry.streamSimple(
        ctx.model,
        { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
        { maxTokens: 4096, reasoning: "low", signal },
      );
      const result: any = await stream.result();
      if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage || result.stopReason);
      usage = result.usage;
      written = modelPart(textOf(result.content));
    } catch (err) {
      if (signal?.aborted) return { cancel: true };
      ctx.ui.notify(`inkling-memory: model update failed (${err instanceof Error ? err.message : err}); keeping previous memory`, "warning");
    }
    if (!written) {
      // keep the previous model-written sections rather than losing them
      written = modelPart(preparation.previousSummary) || "## Goal\n- (memory update failed; see verbatim record)";
    }

    const summary = [
      "# Working memory (carried across context compactions)",
      "This covers the conversation BEFORE the messages that follow it. Trust it over your own assumptions, but where the",
      "newer messages below show later progress (e.g. a step now done), the newer messages win.",
      written,
      "",
      "# Verbatim record (copied exactly, not summarized)",
      "## User requests (first, then most recent)",
      requests.length ? requests.map((r, i) => `${i === 0 ? "FIRST" : `#${i}`}: ${r}`).join("\n\n") : "- (none)",
      "## Pinned notes",
      renderNotes(notes),
      "## Recent errors (from the compacted span)",
      errors.length ? errors.join("\n") : "- (none)",
      "",
      `<read-files>\n${read.join("\n")}\n</read-files>`,
      `<modified-files>\n${modified.join("\n")}\n</modified-files>`,
    ].join("\n");

    try {
      mkdirSync(MEMORY_DIR, { recursive: true });
      writeFileSync(join(MEMORY_DIR, `${ctx.sessionManager.getSessionId()}.md`), summary, "utf8");
    } catch {
      /* the file is only a convenience copy */
    }

    const details: MemoryDetails = { inklingMemory: 1, requests, read, modified, notes: notes.length };
    return {
      compaction: {
        summary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        usage,
        details,
      },
    };
  });

  pi.on("session_compact", async (event, ctx) => {
    if (event.fromExtension && isActive(ctx)) ctx.ui.notify("inkling-memory: working memory saved.", "info");
  });
}
