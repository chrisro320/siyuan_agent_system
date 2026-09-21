import type { AgentMessage, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Project root detection
// ---------------------------------------------------------------------------

function findProjectRoot(startDir: string): string | null {
   let current = startDir;
   while (true) {
      if (existsSync(join(current, ".trellis"))) return current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
   }
   return null;
}

// ---------------------------------------------------------------------------
// Session identity helpers (mirrors Python _sanitize_key / _hash_value / _context_key)
// ---------------------------------------------------------------------------

function sanitizeKey(raw: string): string {
   const safe = raw.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "");
   return safe ? safe.slice(0, 160) : "";
}

function hashValue(raw: string): string {
   return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function buildContextKey(platformName: string, kind: string, value: string): string {
   if (kind === "transcript") {
      return `${platformName}_transcript_${hashValue(value)}`;
   }
   const safeValue = sanitizeKey(value);
   return safeValue ? `${platformName}_${safeValue}` : `${platformName}_${hashValue(value)}`;
}

function deriveContextKey(ctx?: { sessionManager?: { getSessionId?: () => string | undefined; getSessionFile?: () => string | undefined } }): string | null {
   const sessionId = ctx?.sessionManager?.getSessionId?.();
   if (sessionId) {
      return buildContextKey("omp", "session", sessionId);
   }
   const sessionFile = ctx?.sessionManager?.getSessionFile?.();
   if (sessionFile) {
      return buildContextKey("omp", "transcript", sessionFile);
   }
   const override = process.env.TRELLIS_CONTEXT_ID?.trim();
   return override ? sanitizeKey(override) || hashValue(override) : null;
}

function isInsideRoot(root: string, candidate: string): boolean {
   const rel = relative(root, candidate);
   return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Trusted context roots (mirrors packages/cli/src/commands/channel/context-trust.ts;
// standalone copy since templates don't import from the CLI package).
// ---------------------------------------------------------------------------

const AUTO_TRUST_ENTRIES = ["tasks", "workspace"];

function stripTrustValue(s: string): string {
   return s.trim().replace(/\s*#.*$/, "").trim().replace(/^['"]|['"]$/g, "");
}

function parseChannelTrustSection(content: string): { trustedDirs: string[]; autoTrustSymlinks?: boolean } {
   const lines = content.split("\n");
   const trustedDirs: string[] = [];
   let autoTrustSymlinks: boolean | undefined;
   let inChannel = false;
   let inList = false;

   for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      const trimmed = line.trimEnd();
      if (trimmed.trim().startsWith("#")) continue;

      if (/^channel:\s*$/.test(trimmed)) {
         inChannel = true;
         inList = false;
         continue;
      }
      if (!inChannel) continue;

      if (trimmed.trim() !== "" && /^\S/.test(line)) {
         inChannel = false;
         inList = false;
         continue;
      }
      if (trimmed.trim() === "") continue;

      if (inList) {
         const item = trimmed.match(/^ {4}-\s*(.+)$/);
         if (item) {
            const val = stripTrustValue(item[1]!);
            if (val) trustedDirs.push(val);
            continue;
         }
         inList = false;
      }

      if (/^ {2}trusted_context_dirs:\s*$/.test(trimmed)) {
         inList = true;
         continue;
      }

      const boolMatch = trimmed.match(/^ {2}auto_trust_trellis_symlinks:\s*(.+)$/);
      if (boolMatch) {
         const val = stripTrustValue(boolMatch[1]!).toLowerCase();
         if (val === "false") autoTrustSymlinks = false;
         else if (val === "true") autoTrustSymlinks = true;
         else process.stderr.write(`[channel] channel.auto_trust_trellis_symlinks: invalid value '${val}', ignoring\n`);
         continue;
      }
   }

   return { trustedDirs, autoTrustSymlinks };
}

function resolveTrustedRoots(projectRoot: string): string[] {
   const configPath = join(projectRoot, ".trellis", "config.yaml");
   let config: { trustedDirs: string[]; autoTrustSymlinks?: boolean } = { trustedDirs: [] };
   if (existsSync(configPath)) {
      try {
         config = parseChannelTrustSection(readFileSync(configPath, "utf-8"));
      } catch {
         // ignore
      }
   }

   const roots: string[] = [];
   for (const entry of config.trustedDirs) {
      try {
         roots.push(realpathSync(resolve(projectRoot, entry)));
      } catch {
         // entry not found or invalid — skip
      }
   }

   if (config.autoTrustSymlinks !== false) {
      for (const entryName of AUTO_TRUST_ENTRIES) {
         const entryPath = join(projectRoot, ".trellis", entryName);
         try {
            if (lstatSync(entryPath).isSymbolicLink()) {
               roots.push(realpathSync(entryPath));
            }
         } catch {
            // missing / broken symlink — nothing to trust
         }
      }
   }

   return [...new Set(roots)];
}

function resolveProjectFile(
   projectRoot: string,
   file: string,
   trustedRoots: string[],
): string | null {
   try {
      const rootReal = realpathSync(projectRoot);
      const targetReal = realpathSync(resolve(projectRoot, file));
      if (isInsideRoot(rootReal, targetReal)) return targetReal;
      if (trustedRoots.some((root) => isInsideRoot(root, targetReal))) return targetReal;
      return null;
   } catch {
      return null;
   }
}

// ---------------------------------------------------------------------------
// Active task resolution
// ---------------------------------------------------------------------------

function resolveActiveTaskStatus(
   projectRoot: string,
   contextKey: string | null,
): { status: string; taskDir: string | null; taskTitle: string | null } {
   const sessionsDir = join(projectRoot, ".trellis", ".runtime", "sessions");
   if (!existsSync(sessionsDir)) return { status: "no_task", taskDir: null, taskTitle: null };

   // --- 通过 context key 解析 session 文件 ---
   let sessionFilePath: string | null = null;

   if (contextKey) {
      const candidate = join(sessionsDir, `${contextKey}.json`);
      if (existsSync(candidate)) {
         sessionFilePath = candidate;
      } else {
         return { status: "no_task", taskDir: null, taskTitle: null };
      }
   } else {
      // No identity: use single-session fallback only when there is exactly one session file.
      let sessionFiles: string[];
      try {
         sessionFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
      } catch {
         return { status: "no_task", taskDir: null, taskTitle: null };
      }
      if (sessionFiles.length === 1) {
         sessionFilePath = join(sessionsDir, sessionFiles[0]);
      } else {
         return { status: "no_task", taskDir: null, taskTitle: null };
      }
   }

   // --- 读取 session 数据 ---
   let sessionData: Record<string, unknown>;
   try {
      sessionData = JSON.parse(readFileSync(sessionFilePath, "utf-8"));
   } catch {
      return { status: "no_task", taskDir: null, taskTitle: null };
   }

   const currentTask = sessionData.current_task;
   if (typeof currentTask !== "string" || !currentTask)
      return { status: "no_task", taskDir: null, taskTitle: null };

   // Same jail the jsonl-referenced files already go through below. `task.py`
   // now refuses to store a ref that leaves the project, but a session file
   // written before that fix can still hold one, and `trellis update` does not
   // rewrite session files — so a poisoned pointer outlives the upgrade that
   // closed the writer.
   const taskDir = resolveProjectFile(projectRoot, currentTask, resolveTrustedRoots(projectRoot));
   if (!taskDir) return { status: "no_task", taskDir: null, taskTitle: null };
   const taskJsonPath = join(taskDir, "task.json");
   if (!existsSync(taskJsonPath)) return { status: "no_task", taskDir: null, taskTitle: null };

   let taskData: Record<string, unknown>;
   try {
      taskData = JSON.parse(readFileSync(taskJsonPath, "utf-8"));
   } catch {
      return { status: "no_task", taskDir: null, taskTitle: null };
   }

   return {
      status: typeof taskData.status === "string" ? taskData.status : "planning",
      taskDir,
      taskTitle: typeof taskData.title === "string" ? taskData.title : null,
   };
}

// ---------------------------------------------------------------------------
// Session context — spawns get_context.py default mode (same as Claude hook)
// ---------------------------------------------------------------------------

const SESSION_CONTEXT_TIMEOUT_MS = 5000;

function buildSessionContext(projectRoot: string, contextKey: string | null): string {
   const script = join(projectRoot, ".trellis", "scripts", "get_context.py");
   if (!existsSync(script)) return "";

   try {
      const result = spawnSync("python3", [script], {
         cwd: projectRoot,
         encoding: "utf-8",
         env: contextKey
            ? { ...process.env, TRELLIS_CONTEXT_ID: contextKey }
            : process.env,
         timeout: SESSION_CONTEXT_TIMEOUT_MS,
         windowsHide: true,
      });
      if (result.status !== 0 || !result.stdout?.trim()) {
         return "";
      }
      return `<session-context>\n${result.stdout.trim()}\n</session-context>`;
   } catch {
      return "";
   }
}

// ---------------------------------------------------------------------------
// Task context — prd.md, info.md, and jsonl-referenced spec/research files
// ---------------------------------------------------------------------------

type AgentType = "trellis-implement" | "trellis-check" | "trellis-research" | null;

function buildTaskContext(projectRoot: string, taskDir: string, agentType?: AgentType): string {
   const parts: string[] = [];
   // Resolved once per call (not per referenced file) — avoids re-parsing
   // config.yaml for every jsonl row.
   const trustedRoots = resolveTrustedRoots(projectRoot);

   // prd.md and info.md — always included
   let prd = "";
   try { prd = readFileSync(join(taskDir, "prd.md"), "utf-8"); } catch { }
   if (prd.trim()) parts.push(`## PRD\n\n${prd.trim()}`);

   let info = "";
   try { info = readFileSync(join(taskDir, "info.md"), "utf-8"); } catch { }
   if (info.trim()) parts.push(`## Info\n\n${info.trim()}`);

   // Determine which jsonl files to read based on agent type
   let jsonlNames: string[];
   if (agentType === "trellis-implement") {
      jsonlNames = ["implement.jsonl"];
   } else if (agentType === "trellis-check") {
      jsonlNames = ["check.jsonl"];
   } else if (agentType === "trellis-research") {
      jsonlNames = []; // research agent gets only prd + info
   } else {
      jsonlNames = ["implement.jsonl", "check.jsonl"]; // main session: all
   }

   for (const jsonlName of jsonlNames) {
      const jsonlPath = join(taskDir, jsonlName);
      if (!existsSync(jsonlPath)) continue;

      let lines: string[];
      try {
         lines = readFileSync(jsonlPath, "utf-8").split(/\r?\n/);
      } catch {
         continue;
      }

      const fileChunks: string[] = [];
      for (const line of lines) {
         const trimmed = line.trim();
         if (!trimmed) continue;
         try {
            const row = JSON.parse(trimmed) as Record<string, unknown>;
            const file = typeof row.file === "string" ? row.file.trim() : "";
            if (!file) continue;
            const targetPath = resolveProjectFile(projectRoot, file, trustedRoots);
            if (!targetPath) continue;
            let content = "";
            try { content = readFileSync(targetPath, "utf-8"); } catch { }
            if (content.trim()) {
               fileChunks.push(`### ${file}\n\n${content.trim()}`);
            }
         } catch {
            // seed rows and malformed lines are non-fatal
         }
      }

      if (fileChunks.length > 0) {
         parts.push(`## ${jsonlName}\n\n${fileChunks.join("\n\n---\n\n")}`);
      }
   }

   return parts.length > 0
      ? `<task-context>\n${parts.join("\n\n")}\n</task-context>`
      : "";
}

// ---------------------------------------------------------------------------
// Per-turn cache — prevents redundant workflow-state resolution within a
// single event cascade (input, before_agent_start, and context fire closely)
// ---------------------------------------------------------------------------

const SESSION_OVERVIEW_TEXT =
   "Trellis workflow system active. Use skills and agents as directed by the workflow state.";

class TurnContextCache {
   private key: string | null = null;
   private timestamp = 0;
   private workflowMsg = "";
   private static readonly TTL_MS = 1500;

   get(projectRoot: string, contextKey: string | null): { workflowMsg: string } {
      const now = Date.now();
      const cacheKey = `${projectRoot}:${contextKey ?? ""}`;
      if (
         this.key === cacheKey &&
         now - this.timestamp < TurnContextCache.TTL_MS
      ) {
         return { workflowMsg: this.workflowMsg };
      }

      const { status } = resolveActiveTaskStatus(projectRoot, contextKey);

      const workflowPath = join(projectRoot, ".trellis", "workflow.md");
      let workflowMd = "";
      try { workflowMd = readFileSync(workflowPath, "utf-8"); } catch { }

      let workflowBody = "";
      if (workflowMd) {
         const blocks = parseWorkflowStateBlocks(workflowMd);
         const activeBlock = blocks.find((b) => b.status === status);
         if (activeBlock) {
            workflowBody = `[workflow-state:${activeBlock.status}]\n${activeBlock.content}\n[/workflow-state:${activeBlock.status}]`;
         }
      }
      if (!workflowBody) {
         workflowBody = "Refer to workflow.md for current step.";
      }

      this.workflowMsg = `<workflow-state>\n${workflowBody}\n</workflow-state>\n\n<session-overview>\n${SESSION_OVERVIEW_TEXT}\n</session-overview>`;

      this.key = cacheKey;
      this.timestamp = now;
      return { workflowMsg: this.workflowMsg };
   }
}

// ---------------------------------------------------------------------------
// Workflow-state tag parsing
// ---------------------------------------------------------------------------

const WORKFLOW_STATE_RE =
   /\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n([\s\S]*?)\n\s*\[\/workflow-state:\1\]/g;

interface WorkflowStateBlock {
   status: string;
   content: string;
}

function parseWorkflowStateBlocks(markdown: string): WorkflowStateBlock[] {
   const blocks: WorkflowStateBlock[] = [];
   for (const match of markdown.matchAll(WORKFLOW_STATE_RE)) {
      blocks.push({
         status: match[1],
         content: match[2].trim(),
      });
   }
   return blocks;
}

// ---------------------------------------------------------------------------
// Sub-agent detection
// ---------------------------------------------------------------------------

const TRELLIS_AGENTS = new Set(["trellis-implement", "trellis-check", "trellis-research"]);

function detectAgentType(): AgentType {
   const blocked = process.env.PI_BLOCKED_AGENT;
   if (blocked && TRELLIS_AGENTS.has(blocked)) {
      return blocked as AgentType;
   }
   return null;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function(pi: ExtensionAPI): void {
   let projectRoot: string | null = null;
   const turnCache = new TurnContextCache();
   const agentType = detectAgentType();
   const isSubAgent = agentType !== null;

   // A freshly constructed extension has not injected this process yet. If a
   // compaction event arrives first, the next context call must replay the full
   // state even when a prior process left a persisted snapshot.
   let compactionSinceLastInjection = false;

   const rememberContextKey = (ctx?: { sessionManager?: { getSessionId?: () => string | undefined; getSessionFile?: () => string | undefined } }): string | null => {
      const key = deriveContextKey(ctx);
      if (!key) return null;
      return key;
   };

   pi.on("session_start", async (_event, ctx) => {
      projectRoot = findProjectRoot(ctx.cwd);
      rememberContextKey(ctx);
      if (!projectRoot) return;
      if (!isSubAgent) {
         ctx.ui.notify("Trellis workflow system available", "info");
      }
   });

   pi.on("session_before_compact", async () => {
      compactionSinceLastInjection = true;
   });

   pi.on("before_agent_start", async (_event, ctx) => {
      if (!projectRoot) {
         projectRoot = findProjectRoot(ctx.cwd);
      }
   });

   // `context` fires before EVERY provider call, including each tool-continuation
   // inside one agent turn.
   //
   // The previous implementation appended a transient `custom` message to the
   // tail. That message is never written to the session JSONL, so the NEXT call
   // rebuilt history from disk without it and the assistant's reply landed on
   // the very index the transient message had occupied. Verified on live
   // Antigravity payloads: `contents[603]` was `role: "user"`
   // (`<session-context>`) in one request and `role: "model"` in the next — a
   // mid-history role flip, which voids the implicit cache from that index on.
   // Every tool call therefore re-billed the whole prefix.
   //
   // Fix: never change the message COUNT. The text is merged into an existing
   // user message (the anchor), and every anchor we have ever injected into is
   // remembered and re-injected identically on later calls. Within a process the
   // history bytes are then stable, so each request is a pure tail append.
   //
   // The anchor map is persisted next to the workflow runtime (NOT into the
   // session JSONL), so a resumed process replays byte-identical injections and
   // the first request after resume is a pure tail append too. Keeping it out of
   // the JSONL preserves what 0012 wanted — no transcript pollution — while
   // still surviving a restart.
   const injectedByAnchor = new Map<string, string>();
   let anchorsLoadedFor: string | null = null;

   // `timestamp` alone is not unique: two sessions can mint a message in the
   // same millisecond, and reusing another session's text there would inject
   // the wrong bytes. Hash the ORIGINAL (pre-injection) content into the key —
   // that content is what a resumed process rebuilds from the JSONL, so the key
   // is both collision-resistant and stable across restarts.
   const messageContent = (message: AgentMessage): unknown =>
      "content" in message ? message.content : undefined;

   const messageTimestamp = (message: AgentMessage): number | undefined =>
      "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : undefined;

   const anchorKey = (message: AgentMessage): string => {
      const content = messageContent(message);
      const signature = createHash("sha256")
         .update(typeof content === "string" ? content : JSON.stringify(content ?? null))
         .digest("hex")
         .slice(0, 16);
      return `${message.role}:${messageTimestamp(message) ?? "?"}:${signature}`;
   };

   const anchorFile = (contextKey: string): string | null =>
      projectRoot ? join(projectRoot, ".trellis", ".runtime", "omp-anchors", `${contextKey}.json`) : null;

   const loadAnchors = (contextKey: string): void => {
      if (anchorsLoadedFor === contextKey) return;
      // Entries belong to exactly one session. On a switch, drop the previous
      // session's map instead of letting its keys leak into this one.
      injectedByAnchor.clear();
      anchorsLoadedFor = contextKey;
      const file = anchorFile(contextKey);
      if (!file || !existsSync(file)) return;
      try {
         const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
         for (const [key, value] of Object.entries(raw)) {
            if (typeof value === "string") injectedByAnchor.set(key, value);
         }
      } catch {
         // A corrupt store only costs one re-anchor; never block the turn.
      }
   };

   const saveAnchors = (contextKey: string): void => {
      const file = anchorFile(contextKey);
      if (!file) return;
      try {
         mkdirSync(dirname(file), { recursive: true });
         writeFileSync(file, JSON.stringify(Object.fromEntries(injectedByAnchor)), { mode: 0o600 });
      } catch {
         // Losing one write costs one re-anchor on the next resume.
      }
   };

   // Dedup state: the exact bytes of the last FULL injection, persisted per
   // session. While the rebuilt snapshot matches it, new user messages ride a
   // short stub instead of re-paying the whole prefix at full input price —
   // the per-turn 8.5K spike was the same snapshot re-shipping at the tail,
   // which prefix caching can never cover. Anchors already in `injectedByAnchor`
   // replay byte-identically either way, so history stays cache-stable.
   let lastFullContent: string | null | undefined;
   let lastFullLoadedFor: string | null = null;

   const stateFile = (contextKey: string): string | null => {
      const f = anchorFile(contextKey);
      return f ? `${f.slice(0, -5)}.state.json` : null;
   };

   const loadLastFull = (contextKey: string): void => {
      if (lastFullLoadedFor === contextKey) return;
      lastFullLoadedFor = contextKey;
      const file = stateFile(contextKey);
      lastFullContent = null;
      if (!file || !existsSync(file)) return;
      try {
         const raw = JSON.parse(readFileSync(file, "utf8")) as { content?: unknown };
         if (typeof raw.content === "string") lastFullContent = raw.content;
      } catch {
         // A corrupt state file only costs one full re-injection.
      }
   };

   const saveLastFull = (contextKey: string, content: string): void => {
      lastFullContent = content;
      lastFullLoadedFor = contextKey;
      const file = stateFile(contextKey);
      if (!file) return;
      try {
         mkdirSync(dirname(file), { recursive: true });
         writeFileSync(file, JSON.stringify({ content }), { mode: 0o600 });
      } catch {
         // Losing the write costs one full re-injection next turn; never block.
      }
   };

   const withInjectedText = (message: AgentMessage, text: string): AgentMessage => {
      const content = messageContent(message);
      if (typeof content === "string") {
         return { ...message, content: `${content}\n\n${text}` } as AgentMessage;
      }
      if (Array.isArray(content)) {
         return { ...message, content: [...content, { type: "text" as const, text }] } as AgentMessage;
      }
      return message;
   };

   pi.on("context", async (event, ctx) => {
      if (!projectRoot) return;
      const contextKey = rememberContextKey(ctx);
      // Replay anchors recorded by earlier processes before deciding anything,
      // so a resumed turn re-injects the exact same bytes it did before exit.
      if (contextKey) loadAnchors(contextKey);

      const cached = turnCache.get(projectRoot, contextKey);
      let turnContent = cached.workflowMsg;
      let activeTaskTitle: string | null = null;
      let activeTaskStatus: string | null = null;
      if (isSubAgent) {
         const { taskDir, taskTitle, status } = resolveActiveTaskStatus(projectRoot, contextKey);
         activeTaskTitle = taskTitle;
         activeTaskStatus = status;
         if (taskDir) {
            const taskContext = buildTaskContext(projectRoot, taskDir, agentType);
            if (taskContext) {
               turnContent = `${taskContext}\n\n${turnContent}`;
            }
         }
      } else {
         const sessionContext = buildSessionContext(projectRoot, contextKey);
         const { taskDir, taskTitle, status } = resolveActiveTaskStatus(projectRoot, contextKey);
         activeTaskTitle = taskTitle;
         activeTaskStatus = status;
         const taskContext = taskDir ? buildTaskContext(projectRoot, taskDir) : null;
         const prefix = [sessionContext, taskContext].filter(Boolean).join("\n\n");
         if (prefix) {
            turnContent = `${prefix}\n\n${turnContent}`;
         }
      }

      const messages = event.messages;
      if (!Array.isArray(messages) || messages.length === 0) return;

      // Anchor on the newest user message. Tool continuations within the same
      // agent turn append assistant/toolResult entries after it, so the anchor —
      // and therefore every byte before the appended tail — stays put.
      let anchor = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
         if (messages[i]?.role === "user") {
            anchor = i;
            break;
         }
      }
      if (anchor < 0) return;

      if (turnContent) {
         const key = anchorKey(messages[anchor]);
         // First sight of this anchor fixes its text; later calls in the same
         // turn — and every later process — reuse it verbatim rather than
         // recomputing a drifting snapshot.
         if (!injectedByAnchor.has(key)) {
            let text = turnContent;
            if (contextKey) {
               loadLastFull(contextKey);
               // After a compaction the previous full anchor may have been
               // summarized away — the model can no longer see the snapshot
               // the stub points at, so the next injection must be full again.
               const compacted = compactionSinceLastInjection;
               const isFirstOrCompacted = !lastFullContent || compacted;
               const snapshotPath = join(projectRoot, ".trellis", ".runtime", "omp-anchors", `${contextKey}.snapshot.md`);

               if (lastFullContent === turnContent && !compacted) {
                  // Unchanged since the last full snapshot: ride a stub.
                  const hash = createHash("sha256").update(turnContent).digest("hex").slice(0, 16);
                  text = `<trellis-state>\nWorkflow state unchanged since the last full snapshot (${hash}); it still applies. Full snapshot: ${snapshotPath}. Read that file if you need the exact contents.\n</trellis-state>`;
               } else {
                  let snapshotWritten = false;
                  try {
                     const dir = join(projectRoot, ".trellis", ".runtime", "omp-anchors");
                     mkdirSync(dir, { recursive: true });
                     writeFileSync(snapshotPath, turnContent, { mode: 0o600 });
                     snapshotWritten = true;
                  } catch {
                     // A lost snapshot falls back to full injection so the model isn't blinded.
                  }

                  if (snapshotWritten) {
                     saveLastFull(contextKey, turnContent);
                     compactionSinceLastInjection = false;

                     if (!isFirstOrCompacted) {
                        // Delta Stub (Option A): state updated, snapshot refreshed on disk.
                        // Never re-ship the 12-15KB full PRD text at full input price.
                        const hash = createHash("sha256").update(turnContent).digest("hex").slice(0, 16);
                        const taskLine = activeTaskTitle ? `- Active Task: ${activeTaskTitle} (${activeTaskStatus ?? "active"})\n` : "";
                        text = `<trellis-state>\nWorkflow state updated (${hash}). Full snapshot refreshed at: ${snapshotPath}.\n${taskLine}Read that file if full PRD/spec details needed.\n</trellis-state>`;
                     }
                  }
               }
            }
            injectedByAnchor.set(key, text);
            if (contextKey) saveAnchors(contextKey);
         }
      }
      if (injectedByAnchor.size === 0) return;

      let changed = false;
      const out = messages.map(message => {
         if (message.role !== "user") return message;
         const text = injectedByAnchor.get(anchorKey(message));
         if (!text) return message;
         changed = true;
         return withInjectedText(message, text);
      });
      if (!changed) return;
      return { messages: out };
   });

   // OMP passes Bash event.input through to the tool execution parameters, so
   // inject the session key through the shell-agnostic env field. An explicit
   // per-call value wins over the derived key.
   pi.on("tool_call", (event, ctx) => {
      if (event.toolName !== "bash") return;
      const contextKey = rememberContextKey(ctx);
      if (!contextKey) return;
      const input = event.input as { env?: Record<string, string> };
      input.env = {
         TRELLIS_CONTEXT_ID: contextKey,
         ...input.env,
      };
   });

   pi.on("input", async (_event, ctx) => {
      if (!projectRoot) {
         projectRoot = findProjectRoot(ctx.cwd);
      }
      // Resolve projectRoot on first input if session_start missed it
      if (!projectRoot) return;
      const contextKey = rememberContextKey(ctx);
      // Pre-warm the cache so before_agent_start and context can use it
      turnCache.get(projectRoot, contextKey);
   });
}
