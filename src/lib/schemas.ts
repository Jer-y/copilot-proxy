import { z } from 'zod'

const AnthropicCacheControlSchema = z.object({
  type: z.literal('ephemeral'),
  ttl: z.string().optional(),
}).passthrough()

const AnthropicTextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  cache_control: AnthropicCacheControlSchema.optional(),
}).passthrough()

const AnthropicImageBlockSchema = z.object({
  type: z.literal('image'),
  source: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('base64'),
      media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
      data: z.string(),
    }).passthrough(),
    z.object({
      type: z.literal('url'),
      url: z.string().min(1),
    }).passthrough(),
  ]),
  cache_control: AnthropicCacheControlSchema.optional(),
}).passthrough()

const AnthropicDocumentBlockSchema = z.object({
  type: z.literal('document'),
  source: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('base64'),
      media_type: z.string(),
      data: z.string(),
    }).passthrough(),
    z.object({
      type: z.literal('url'),
      url: z.string().min(1),
    }).passthrough(),
    z.object({
      type: z.literal('text'),
      media_type: z.string(),
      data: z.string().optional(),
      text: z.string().optional(),
    }).passthrough().superRefine((value, ctx) => {
      if (typeof value.data === 'string' || typeof value.text === 'string') {
        return
      }

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'document.source.type="text" requires "data" (official) or legacy "text"',
        path: ['data'],
      })
    }),
    z.object({
      type: z.literal('content'),
      content: z.array(AnthropicTextBlockSchema),
    }).passthrough(),
    z.object({
      type: z.literal('file'),
      file_id: z.string().min(1),
    }).passthrough(),
  ]),
  title: z.string().optional(),
  context: z.string().optional(),
  citations: z.object({
    enabled: z.boolean(),
  }).passthrough().optional(),
  cache_control: AnthropicCacheControlSchema.optional(),
}).passthrough()

const AnthropicToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([
    z.string(),
    z.array(z.union([
      AnthropicTextBlockSchema,
      AnthropicImageBlockSchema,
      AnthropicDocumentBlockSchema,
    ])),
  ]),
  is_error: z.boolean().optional(),
}).passthrough()

const AnthropicToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
}).passthrough()

const AnthropicThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),
}).passthrough()

const AnthropicUserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.union([
    z.string(),
    z.array(z.union([
      AnthropicTextBlockSchema,
      AnthropicImageBlockSchema,
      AnthropicDocumentBlockSchema,
      AnthropicToolResultBlockSchema,
    ])),
  ]),
}).passthrough()

const AnthropicRedactedThinkingBlockSchema = z.object({
  type: z.literal('redacted_thinking'),
  data: z.string(),
}).passthrough()

const AnthropicAssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([
    z.string(),
    z.array(z.union([
      AnthropicTextBlockSchema,
      AnthropicToolUseBlockSchema,
      AnthropicThinkingBlockSchema,
      AnthropicRedactedThinkingBlockSchema,
    ])),
  ]),
}).passthrough()

const AnthropicToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()),
  cache_control: AnthropicCacheControlSchema.optional(),
}).passthrough()

const AnthropicToolChoiceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('auto'),
    disable_parallel_tool_use: z.boolean().optional(),
  }).passthrough(),
  z.object({
    type: z.literal('any'),
    disable_parallel_tool_use: z.boolean().optional(),
  }).passthrough(),
  z.object({
    type: z.literal('none'),
    disable_parallel_tool_use: z.boolean().optional(),
  }).passthrough(),
  z.object({
    type: z.literal('tool'),
    name: z.string(),
    disable_parallel_tool_use: z.boolean().optional(),
  }).passthrough(),
])

const AnthropicThinkingConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('enabled'),
    budget_tokens: z.number().int().positive().optional(),
  }).passthrough(),
  z.object({
    type: z.literal('adaptive'),
    display: z.enum(['summarized', 'omitted']).nullable().optional(),
  }).passthrough(),
  z.object({
    type: z.literal('disabled'),
  }).passthrough(),
])

const AnthropicOutputConfigSchema = z.object({
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
  format: z.object({
    type: z.string(),
  }).passthrough().optional(),
}).passthrough()

// ─── Chat Completions (OpenAI format) ─────────────────────────────

export const ChatCompletionsPayloadSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({
    role: z.string(),
    content: z.union([z.string(), z.array(z.unknown()), z.null()]),
  }).passthrough()),
  stream: z.boolean().nullable().optional(),
  temperature: z.number().nullable().optional(),
  top_p: z.number().nullable().optional(),
  max_tokens: z.number().nullable().optional(),
  tools: z.array(z.unknown()).nullable().optional(),
  tool_choice: z.unknown().optional(),
}).passthrough()

// ─── Anthropic Messages ───────────────────────────────────────────

export const AnthropicMessagesPayloadSchema = z.object({
  model: z.string(),
  messages: z.array(z.union([
    AnthropicUserMessageSchema,
    AnthropicAssistantMessageSchema,
  ])),
  max_tokens: z.number().int().nonnegative().optional(),
  stream: z.boolean().optional(),
  system: z.union([z.string(), z.array(AnthropicTextBlockSchema)]).optional(),
  cache_control: AnthropicCacheControlSchema.optional(),
  tools: z.array(AnthropicToolSchema).optional(),
  tool_choice: AnthropicToolChoiceSchema.optional(),
  thinking: AnthropicThinkingConfigSchema.optional(),
  output_config: AnthropicOutputConfigSchema.optional(),
  metadata: z.object({
    user_id: z.string().optional(),
  }).passthrough().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  service_tier: z.enum(['auto', 'standard_only']).optional(),
  speed: z.enum(['fast', 'normal']).optional(),
  stop_sequences: z.array(z.string()).optional(),
}).passthrough()

// ─── Embeddings ───────────────────────────────────────────────────

export const EmbeddingRequestSchema = z.object({
  input: z.union([z.string(), z.array(z.string())]),
  model: z.string(),
}).passthrough()

// ─── Responses (OpenAI Responses API) ─────────────────────────────

const ResponsesMessageInputSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]),
}).passthrough()

const ResponsesFunctionCallInputSchema = z.object({
  type: z.literal('function_call'),
  id: z.string(),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
  status: z.string().optional(),
}).passthrough()

const ResponsesFunctionCallOutputInputSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string(),
  output: z.string(),
}).passthrough()

const ResponsesTypedInputSchema = z.object({
  type: z.string(),
}).passthrough()

const ResponsesInputItemSchema = z.union([
  ResponsesFunctionCallInputSchema,
  ResponsesFunctionCallOutputInputSchema,
  ResponsesMessageInputSchema,
  ResponsesTypedInputSchema,
])

export const ResponsesPayloadSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(ResponsesInputItemSchema)]),
  instructions: z.string().optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  reasoning: z.unknown().optional(),
  text: z.unknown().optional(),
  stream: z.boolean().optional(),
  temperature: z.number().nullable().optional(),
  top_p: z.number().nullable().optional(),
  max_output_tokens: z.number().nullable().optional(),
}).passthrough()
