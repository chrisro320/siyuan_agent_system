import { z } from "zod";

export const GENERATION_MODEL = "deepseek-v4.1-flash";
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
export const PROMPT_VERSION = "extract-1";
export const text = z.string().trim().min(1).max(100_000);
export const id = z.string().min(1).max(512);
export const isoTime = z.string().datetime({ offset: true });
export const attachmentSchema = z.object({
  locator: text,
  mediaType: z.string().nullable(),
  status: z.enum(["not-analyzed", "missing"]),
});
export const messageSchema = z.object({
  sourceMessageId: id,
  parentId: id.nullable(),
  role: z.enum(["user", "assistant", "tool", "unknown"]),
  timestamp: isoTime.nullable(),
  text: z.string().max(MAX_SOURCE_BYTES),
  attachments: z.array(attachmentSchema),
  rawLocator: text,
  missing: z.array(z.string()),
  truncated: z.boolean(),
});
export const conversationSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: id,
    sourceSessionId: id,
    projectId: id,
    startedAt: isoTime.nullable(),
    sourceLocator: z.string().max(4096).nullable(),
    messages: z.array(messageSchema).min(1).max(20_000),
    warnings: z.array(z.string()),
  })
  .superRefine((conversation, context) => {
    const seen = new Set<string>();
    for (const [index, message] of conversation.messages.entries()) {
      if (seen.has(message.sourceMessageId))
        context.addIssue({
          code: "custom",
          path: ["messages", index, "sourceMessageId"],
          message: "Source message IDs must be unique.",
        });
      seen.add(message.sourceMessageId);
    }
  });
export type SourceMessage = z.infer<typeof messageSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export const importRequestSchema = z.object({
  format: z.enum(["conversation", "text", "omp"]),
  content: z.string().min(1).max(MAX_SOURCE_BYTES),
  projectId: id,
  source: id.default("manual"),
  sourceSessionId: id.optional(),
  sourceLocator: z.string().max(4096).nullable().default(null),
  acquisition: z.enum(["manual", "poll"]).optional(),
});
export type ImportRequest = z.infer<typeof importRequestSchema>;
export const uploadRequestSchema = importRequestSchema.extend({
  content: z.string().min(1).max(8_000_000),
  acquisition: z.literal("manual").default("manual"),
});
export type OmpScanItem =
  | { request: ImportRequest; issue: null }
  | { request: null; issue: { file: string; code: string; message: string } };
export const evidenceSchema = z.object({ messageId: id, quote: text.max(8000) });
export const candidateDraftSchema = z.object({
  kind: z.enum(["conclusion", "decision", "method", "project", "question", "action"]),
  title: text.max(160),
  summary: text.max(1600),
  bodyMarkdown: text.max(16_000),
  topic: text.max(80),
  limitations: z.array(text.max(2000)).max(20),
  actions: z.array(text.max(2000)).max(20),
  uncertainties: z.array(text.max(2000)).max(20),
  evidence: z.array(evidenceSchema).min(1).max(30),
});
export const extractionSchema = z.object({ candidates: z.array(candidateDraftSchema).max(30) });
export type CandidateDraft = z.infer<typeof candidateDraftSchema>;
export const claimSchema = z.object({ text: text.max(2000), sources: z.array(id).min(1).max(30) });
export const mentalContentSchema = z.object({
  goals: z.array(claimSchema).max(30),
  decisions: z.array(claimSchema).max(50),
  constraints: z.array(claimSchema).max(30),
  terminology: z.array(claimSchema).max(30),
  superseded: z.array(claimSchema).max(50),
});
export type MentalContent = z.infer<typeof mentalContentSchema>;
export const emptyMental = (): MentalContent => ({
  goals: [],
  decisions: [],
  constraints: [],
  terminology: [],
  superseded: [],
});
export const policySchema = z.object({
  instructions: text.max(4000),
  minConfidence: z.number().min(0).max(1),
  minValue: z.number().min(0).max(2),
  maxSensitivity: z.number().min(0).max(1),
  excludedSources: z.array(id).max(100),
  redactedTerms: z.array(text.max(256)).max(100),
});
export type Policy = z.infer<typeof policySchema>;
export const destinationSchema = z.object({
  projectId: id,
  notebookId: id,
  rootPath: z
    .string()
    .min(1)
    .max(500)
    .regex(/^\/(?!.*(?:\.\.|[\r\n]))/)
    .refine((value) => !value.includes("\0")),
});
export type Destination = z.infer<typeof destinationSchema>;
export const sourceRootSchema = z.object({ path: text, projectId: id, enabled: z.boolean() });
export const settingsSchema = z.object({
  revision: z.number().int().nonnegative(),
  policy: policySchema,
  destinations: z.array(destinationSchema).max(100),
  ompRoots: z.array(sourceRootSchema).max(30),
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings = (): Settings => ({
  revision: 0,
  policy: {
    instructions:
      "保留有原始依據、可重用的結論、方法與已確認專案決策。閒聊僅封存；未證實或互相衝突的資訊待審。",
    minConfidence: 0.8,
    minValue: 0.8,
    maxSensitivity: 0.15,
    excludedSources: [],
    redactedTerms: [],
  },
  destinations: [],
  ompRoots: [],
});
export const usageSchema = z.record(z.string(), z.number().finite().nonnegative());
export const generationMetaSchema = z.object({
  model: text,
  promptVersion: text,
  usage: usageSchema,
});
export type GenerationMeta = z.infer<typeof generationMetaSchema>;
export const judgmentSchema = z.object({
  model: text,
  disposition: z.enum(["retain", "archive-only", "review"]),
  confidence: z.number().min(0).max(1),
  reusableValue: z.number().min(0).max(2),
  sensitivity: z.number().min(0).max(1),
  informationStatus: z.enum(["confirmed", "uncertain", "conflicting"]),
  domain: z.enum(["engineering", "project", "general", "unknown"]),
  action: z.enum(["create", "append", "duplicate", "review"]),
  answers: z.record(z.string(), z.unknown()),
  policyRevision: z.number().int().nonnegative(),
  usage: usageSchema,
});
export type Judgment = z.infer<typeof judgmentSchema>;
export const jobStatusSchema = z.enum([
  "queued",
  "extracting",
  "judging",
  "review",
  "archive-only",
  "ready",
  "writing",
  "complete",
  "retry-wait",
  "failed",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;
export const errorInfoSchema = z.object({
  code: text,
  message: text,
  stage: text,
  retryable: z.boolean(),
});
export type ErrorInfo = z.infer<typeof errorInfoSchema>;
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public status = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}
export const importRecordSchema = z.object({
  id,
  sourceKey: id,
  revision: id,
  rawDigest: id,
  conversation: conversationSchema,
  createdAt: isoTime,
});
export type ImportRecord = z.infer<typeof importRecordSchema>;
export const jobSchema = z.object({
  id,
  importId: id,
  policyRevision: z.number().int(),
  status: jobStatusSchema,
  attempts: z.number().int(),
  nextAttemptAt: isoTime.nullable(),
  error: errorInfoSchema.nullable(),
  nextSegment: z.number().int().nonnegative().default(0),
  extractionComplete: z.boolean().default(false),
  extractionPlan: z.string().nullable().default(null),
  run: z.number().int().nonnegative().default(0),
  createdAt: isoTime,
  updatedAt: isoTime,
});
export type Job = z.infer<typeof jobSchema>;
export const candidateSchema = z.object({
  id,
  logicalId: id,
  jobId: id,
  importId: id,
  projectId: id,
  draft: candidateDraftSchema,
  generation: generationMetaSchema,
  judgment: judgmentSchema.nullable(),
  status: z.enum(["pending", "review", "archive-only", "ready", "published", "duplicate"]),
  operationId: id.nullable(),
  relatedIds: z.array(id),
  version: z.number().int(),
  createdAt: isoTime,
  updatedAt: isoTime,
});
export type Candidate = z.infer<typeof candidateSchema>;
export const mentalCardSchema = z.object({
  id,
  projectId: id,
  revision: z.number().int(),
  baseRevision: z.number().int(),
  content: mentalContentSchema,
  author: z.enum(["model", "human"]),
  status: z.enum(["active", "proposal"]),
  candidateId: id.nullable(),
  generation: generationMetaSchema.nullable(),
  createdAt: isoTime,
});
export type MentalCard = z.infer<typeof mentalCardSchema>;
export const relatedNoteSchema = z.object({
  id,
  title: text,
  content: z.string(),
  projectId: id,
  owned: z.boolean(),
});
export type RelatedNote = z.infer<typeof relatedNoteSchema>;
export const operationSchema = z.object({
  id,
  candidateId: id,
  projectId: id,
  contentKey: id,
  kind: z.enum(["create", "append"]),
  notebookId: id,
  path: text,
  rootPath: text,
  topic: text,
  documentId: id,
  blockId: id,
  markdown: text,
  expectedAttributes: z.record(z.string(), z.string()),
  status: z.enum(["planned", "sent", "uncertain", "verified", "conflict", "undoing", "undone"]),
  receipt: z
    .object({ markdown: z.string(), contentHash: id, attributes: z.record(z.string(), z.string()) })
    .nullable(),
  error: z.string().nullable(),
  createdAt: isoTime,
  updatedAt: isoTime,
});
export type Operation = z.infer<typeof operationSchema>;
export const auditSchema = z.object({
  id,
  action: text,
  targetId: id,
  detail: z.string(),
  createdAt: isoTime,
});
export type Audit = z.infer<typeof auditSchema>;
export const sourceHealthSchema = z.object({
  path: text,
  checkedAt: isoTime,
  imported: z.number().int(),
  error: z.string().nullable(),
});
export type SourceHealth = z.infer<typeof sourceHealthSchema>;
export const overviewSchema = z.object({
  providers: z.object({
    ollamaConfigured: z.boolean(),
    jevConfigured: z.boolean(),
    siyuanConfigured: z.boolean(),
    generationModel: text,
    siyuanPublicUrl: z.string().default(""),
  }),
  settings: settingsSchema,
  allowedOmpRoots: z.array(z.string()),
  jobs: z.array(jobSchema),
  candidates: z.array(candidateSchema),
  operations: z.array(operationSchema),
  mentalCards: z.array(mentalCardSchema),
  audit: z.array(auditSchema),
  sources: z.array(sourceHealthSchema),
});
export type Overview = z.infer<typeof overviewSchema>;
export const candidateDetailSchema = z.object({
  candidate: candidateSchema,
  source: importRecordSchema,
  operations: z.array(operationSchema),
});
export type CandidateDetail = z.infer<typeof candidateDetailSchema>;
export const reviewRequestSchema = z.object({
  version: z.number().int(),
  action: z.enum(["rejudge", "archive"]),
  draft: candidateDraftSchema.optional(),
});
export const mentalEditSchema = z.object({
  baseRevision: z.number().int(),
  content: mentalContentSchema,
});
export const importResultSchema = z.object({
  import: importRecordSchema,
  job: jobSchema,
  duplicate: z.boolean(),
});
export const reviewResultSchema = z.object({ candidateId: id, jobId: id });
export const notebooksSchema = z.array(z.object({ id, name: text }));
export type Notebook = z.infer<typeof notebooksSchema>[number];

export function validateEvidence(draft: CandidateDraft, messages: SourceMessage[]): void {
  const byId = new Map(messages.map((message) => [message.sourceMessageId, message]));
  for (const evidence of draft.evidence) {
    const message = byId.get(evidence.messageId);
    if (!message || !message.text.includes(evidence.quote)) {
      throw new AppError("invalid_evidence", "候選引用無法對應原始訊息，已阻止後續寫入。");
    }
  }
}

export function validateMentalSources(
  content: MentalContent,
  projectId: string,
  candidates: Candidate[],
): void {
  const allowed = new Set(
    candidates
      .filter(
        (candidate) =>
          candidate.projectId === projectId &&
          ["published", "duplicate"].includes(candidate.status) &&
          candidate.judgment?.disposition === "retain",
      )
      .map((candidate) => candidate.id),
  );
  for (const claim of Object.values(content).flat()) {
    if (claim.sources.some((source) => !allowed.has(source))) {
      throw new AppError("invalid_mental_source", "心智卡只能引用此專案已確認的候選來源。");
    }
  }
}
