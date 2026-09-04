import { Buffer } from "node:buffer"
import path from "node:path"
import { z } from "zod/v4"

import { EgoChatError } from "./errors.mjs"
import { DEFAULT_MODEL_POLICY, MAX_PROMPT_BYTES, MAX_WAIT_MS } from "./constants.mjs"

export const WorkflowIdSchema = z.uuid()
export const BindingKeySchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
const TASK_SPACE_FORBIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029]/u
export const TaskSpaceSchema = z.union([
  z.string().min(1).max(120).refine(
    (value) => !TASK_SPACE_FORBIDDEN_CHARACTERS.test(value),
    "Task-space selectors cannot contain control or invisible formatting characters",
  ),
  z.number().int().positive().safe(),
])
export const TargetIdSchema = z.string().min(1).max(200)
export const SafeTextSchema = z.string().min(1).refine(
  (value) => Buffer.byteLength(value, "utf8") <= MAX_PROMPT_BYTES,
  `Text must be at most ${MAX_PROMPT_BYTES} UTF-8 bytes`,
)

export const StartProbeSchema = z.object({
  delayMs: z.number().int().min(1).max(MAX_WAIT_MS),
  value: SafeTextSchema,
})

export const AwaitWorkflowSchema = z.object({
  timeoutMs: z.number().int().min(1).max(MAX_WAIT_MS),
  workflowId: WorkflowIdSchema,
})

export const WorkflowIdInputSchema = z.object({
  workflowId: WorkflowIdSchema,
})

export const AbandonWorkflowSchema = z.object({
  acknowledgePotentialDelivery: z.literal(true),
  workflowId: WorkflowIdSchema,
})

export const ResultReadSchema = z.object({
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  maxBytes: z.number().int().min(4).max(256 * 1024).default(64 * 1024),
  offset: z.number().int().min(0).max(256 * 1024).default(0),
  workflowId: WorkflowIdSchema,
})

export const EgoPreflightSchema = z.object({
  taskSpace: TaskSpaceSchema,
})

export function normalizeChatGptUrl(value) {
  const parsed = new URL(value)
  parsed.hash = ""
  parsed.search = ""
  if (parsed.hostname === "www.chatgpt.com") {
    parsed.hostname = "chatgpt.com"
  }
  if (parsed.pathname.length > 1) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "")
  }
  return parsed.toString()
}

function isChatGptUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === "https:"
      && (parsed.hostname === "chatgpt.com" || parsed.hostname === "www.chatgpt.com")
      && parsed.username === ""
      && parsed.password === ""
      && parsed.port === ""
  } catch (_error) {
    return false
  }
}

function isCanonicalConversationUrl(value) {
  if (!isChatGptUrl(value)) {
    return false
  }
  return /(?:^|\/)c\/[^/]+(?:\/|$)/.test(new URL(value).pathname)
}

export const ChatGptUrlSchema = z.string().min(1).max(2_048)
  .refine(isChatGptUrl, "URL must use HTTPS on chatgpt.com")
  .transform(normalizeChatGptUrl)

export const CanonicalConversationUrlSchema = z.string().min(1).max(2_048)
  .refine(isCanonicalConversationUrl, "URL must identify a canonical ChatGPT conversation")
  .transform(normalizeChatGptUrl)

export const ConversationBindSchema = z.discriminatedUnion("mode", [
  z.object({
    bindingKey: BindingKeySchema,
    mode: z.literal("create_once"),
    projectUrl: ChatGptUrlSchema.optional(),
    startUrl: ChatGptUrlSchema,
    targetId: TargetIdSchema,
    taskSpace: TaskSpaceSchema,
  }),
  z.object({
    bindingKey: BindingKeySchema,
    canonicalUrl: CanonicalConversationUrlSchema,
    mode: z.literal("existing"),
    projectUrl: ChatGptUrlSchema.optional(),
    targetId: TargetIdSchema.optional(),
    taskSpace: TaskSpaceSchema,
  }),
])

export const ConversationAdoptionSchema = z.object({
  allowTaskSpaceReclaim: z.literal(true).default(true),
  bindingKey: BindingKeySchema.optional(),
  canonicalUrl: CanonicalConversationUrlSchema,
  projectUrl: ChatGptUrlSchema.optional(),
  targetId: TargetIdSchema.optional(),
  taskSpace: TaskSpaceSchema.default("ego-chat-adoptions"),
  timeoutMs: z.number().int().min(30_000).max(MAX_WAIT_MS - 60_000).default(15 * 60 * 1_000),
})

export const ConversationKeyInputSchema = z.object({
  bindingKey: BindingKeySchema,
})

export const HeadChangeEvidenceSchema = z.object({
  changeKind: z.enum([
    "branch_changed",
    "conversation_cleared",
    "message_appended",
    "tail_content_changed",
    "tail_identity_changed",
    "tail_role_changed",
    "unknown",
  ]),
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expectedMessageCount: z.number().int().min(0).nullable(),
  expectedRole: z.enum(["assistant", "user"]).nullable(),
  observedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  observedRenderedMessageCount: z.number().int().min(0),
  observedRole: z.enum(["assistant", "user"]).nullable(),
}).strict()

const ModelPolicyLabelSchema = z.string().trim().min(1).max(120)
  .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), "Label must not contain control characters")

export const ModelPolicyObservationSchema = z.object({
  adjusted: z.boolean(),
  effortLabel: ModelPolicyLabelSchema,
  key: z.literal(DEFAULT_MODEL_POLICY.key),
  modelLabel: ModelPolicyLabelSchema,
  pillLabel: ModelPolicyLabelSchema,
  powerLevel: z.number().int().positive().max(20),
  powerMax: z.number().int().positive().max(20),
}).refine(
  (value) => value.powerLevel === value.powerMax,
  { message: "The observed ChatGPT power level must be the maximum", path: ["powerLevel"] },
)

export const ConversationReconcileSchema = z.object({
  allowProtocolRepairCapture: z.literal(true).optional(),
  allowTaskSpaceReclaim: z.literal(true).default(true),
  bindingKey: BindingKeySchema,
  expectedPreviousContentDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expectedPreviousMessageId: TargetIdSchema.optional(),
  expectedTerminalMarker: z.string().min(1).max(200).optional(),
  turnMarker: z.string().regex(/^EGO_CHAT_[A-Z0-9_-]{8,160}$/).optional(),
  workflowId: WorkflowIdSchema,
})

export const WorkflowReconcileObservationSchema = z.object({
  bindingKey: BindingKeySchema,
  workflowId: WorkflowIdSchema,
}).strict()

export const ConversationReanchorSchema = z.object({
  acknowledgeExternalChange: z.literal(true),
  bindingKey: BindingKeySchema,
  expectedBindingRevision: z.number().int().positive(),
  expectedObservedHeadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sourceWorkflowId: WorkflowIdSchema,
}).strict()

const ConversationHeadAnchorSchema = z.object({
  contentDigest: z.string().min(1).max(256).nullable(),
  fingerprint: z.string().min(1).max(256).nullable(),
  fingerprintVersion: z.string().min(1).max(64).nullable(),
  messageId: TargetIdSchema.nullable(),
  role: z.enum(["assistant", "user"]).nullable(),
}).strict()

export const EgoExchangeSchema = z.object({
  allowProtocolRepairCapture: z.literal(true).optional(),
  allowTaskSpaceReclaim: z.literal(true).default(true),
  bindingKey: BindingKeySchema,
  expectedPreviousHead: ConversationHeadAnchorSchema.optional(),
  expectedTerminalMarker: z.string().min(1).max(200),
  prompt: SafeTextSchema,
  timeoutMs: z.number().int().min(30_000).max(MAX_WAIT_MS),
  turnMarker: z.string().regex(/^EGO_CHAT_[A-Z0-9_-]{8,160}$/),
})

const ConvergenceTextSchema = (maximum) => z.string().trim().min(1).max(maximum)
  .refine((value) => !value.includes("\0"), "Text must not contain null bytes")

export const StartConvergenceSchema = z.object({
  acceptanceCriteria: z.array(ConvergenceTextSchema(2_000)).min(1).max(8),
  allowTaskSpaceReclaim: z.literal(true).default(true),
  bindingKey: BindingKeySchema,
  chatGptTimeoutMs: z.number().int().min(30_000).max(MAX_WAIT_MS).default(15 * 60 * 1_000)
    .describe("Per-review browser recovery deadline. This does not bound the durable workflow or its host attachment."),
  codexSandbox: z.enum(["read-only", "workspace-write"]).default("read-only"),
  codexTurnTimeoutMs: z.number().int().min(30_000).max(MAX_WAIT_MS).default(15 * 60 * 1_000)
    .describe("Per-turn App Server recovery deadline. This does not bound the durable workflow or its host attachment."),
  cwd: z.string().trim().min(1).max(1_024).refine(path.isAbsolute, "Working directory must be absolute"),
  maxCycles: z.number().int().min(1).optional(),
  target: ConvergenceTextSchema(8_000),
  wallClockTimeoutMs: z.number().int().min(120_000).max(MAX_WAIT_MS).default(MAX_WAIT_MS)
    .describe("Host attachment window, at most eight hours. Expiry detaches the waiter without terminating the durable convergence workflow."),
}).superRefine((value, context) => {
  const contractBytes = Buffer.byteLength(JSON.stringify({
    acceptanceCriteria: value.acceptanceCriteria,
    target: value.target,
  }), "utf8")
  if (contractBytes > 20 * 1_024) {
    context.addIssue({
      code: "custom",
      message: "The combined target and acceptance contract must be at most 20 KiB",
      path: ["target"],
    })
  }
})

export function parse(schema, value, label = "input") {
  const result = schema.safeParse(value)
  if (result.success) {
    return result.data
  }

  throw new EgoChatError("invalid_input", `Invalid ${label}.`, {
    issues: result.error.issues.map((issue) => ({
      message: issue.message,
      path: issue.path.join("."),
    })),
  })
}

export function assertOwnedAbsolutePath(candidate, parent, label) {
  const resolved = path.resolve(candidate)
  const resolvedParent = path.resolve(parent)
  if (resolved !== resolvedParent && !resolved.startsWith(`${resolvedParent}${path.sep}`)) {
    throw new EgoChatError("invalid_path", `${label} must remain inside the configured data directory.`)
  }
  return resolved
}
