import { z } from 'zod'

const AnthropicCacheControlSchema = z.object({
  type: z.literal('ephemeral'),
  ttl: z.string().optional(),
}).passthrough()

const AnthropicTextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  cache_control: AnthropicCacheControlSchema.nullable().optional(),
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
  cache_control: AnthropicCacheControlSchema.nullable().optional(),
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
  title: z.string().nullable().optional(),
  context: z.string().nullable().optional(),
  citations: z.object({
    enabled: z.boolean(),
  }).passthrough().nullable().optional(),
  cache_control: AnthropicCacheControlSchema.nullable().optional(),
}).passthrough()

const AnthropicSearchResultBlockSchema = z.object({
  type: z.literal('search_result'),
  source: z.string(),
  title: z.string(),
  content: z.array(AnthropicTextBlockSchema),
  cache_control: AnthropicCacheControlSchema.nullable().optional(),
  citations: z.object({
    enabled: z.boolean(),
  }).passthrough().optional(),
}).passthrough()

const AnthropicToolReferenceBlockSchema = z.object({
  type: z.literal('tool_reference'),
  tool_name: z.string(),
  cache_control: AnthropicCacheControlSchema.nullable().optional(),
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
      AnthropicSearchResultBlockSchema,
      AnthropicToolReferenceBlockSchema,
    ])),
  ]).optional(),
  is_error: z.boolean().optional(),
  cache_control: AnthropicCacheControlSchema.nullable().optional(),
}).passthrough()

const AnthropicToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  cache_control: AnthropicCacheControlSchema.nullable().optional(),
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

const AnthropicServerToolUseBlockSchema = z.object({
  type: z.literal('server_tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  cache_control: AnthropicCacheControlSchema.nullable().optional(),
}).passthrough()

const STANDARD_ASSISTANT_CONTENT_BLOCK_TYPES = new Set([
  'text',
  'image',
  'document',
  'tool_result',
  'tool_use',
  'thinking',
  'redacted_thinking',
  'server_tool_use',
])

// Anthropic-hosted tools emit evolving content block shapes such as
// server_tool_use, web_fetch_tool_result, and code_execution_tool_result.
// Preserve unknown server blocks for native replay, while ensuring this
// fallback cannot accidentally make a malformed standard block valid.
const AnthropicServerContentBlockSchema = z.object({
  type: z.string().min(1),
}).passthrough().superRefine((value, ctx) => {
  if (STANDARD_ASSISTANT_CONTENT_BLOCK_TYPES.has(value.type)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Malformed assistant content block of type "${value.type}"`,
      path: ['type'],
    })
  }
})

const AnthropicAssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([
    z.string(),
    z.array(z.union([
      AnthropicTextBlockSchema,
      AnthropicToolUseBlockSchema,
      AnthropicThinkingBlockSchema,
      AnthropicRedactedThinkingBlockSchema,
      AnthropicServerToolUseBlockSchema,
      AnthropicServerContentBlockSchema,
    ])),
  ]),
}).passthrough()

const AnthropicSystemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.union([
    z.string(),
    z.array(AnthropicTextBlockSchema),
  ]),
}).passthrough()

const AnthropicCustomToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()),
  cache_control: AnthropicCacheControlSchema.nullable().optional(),
}).passthrough()

const AnthropicAdvisorToolSchema = z.object({
  type: z.literal('advisor_20260301'),
  name: z.string(),
  model: z.string(),
  cache_control: AnthropicCacheControlSchema.nullable().optional(),
}).passthrough()

const AnthropicMcpToolConfigSchema = z.object({
  defer_loading: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).passthrough()

const AnthropicMcpToolsetSchema = z.object({
  type: z.literal('mcp_toolset'),
  mcp_server_name: z.string(),
  cache_control: AnthropicCacheControlSchema.nullable().optional(),
  configs: z.record(z.string(), AnthropicMcpToolConfigSchema).nullable().optional(),
  default_config: AnthropicMcpToolConfigSchema.optional(),
}).passthrough()

const AnthropicServerToolSchema = z.object({
  type: z.string().refine(
    type => type !== 'custom' && type !== 'advisor_20260301' && type !== 'mcp_toolset',
    { message: 'Typed custom/advisor/MCP toolsets must include their required fields' },
  ),
  name: z.string(),
  cache_control: AnthropicCacheControlSchema.nullable().optional(),
}).passthrough()

const AnthropicToolSchema = z.union([
  AnthropicCustomToolSchema,
  AnthropicAdvisorToolSchema,
  AnthropicMcpToolsetSchema,
  AnthropicServerToolSchema,
])

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
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
  format: z.object({
    type: z.string(),
  }).passthrough().nullable().optional(),
  task_budget: z.object({
    type: z.literal('tokens'),
    total: z.number().int().positive(),
    remaining: z.number().int().nonnegative().nullable().optional(),
  }).passthrough().nullable().optional(),
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
  max_completion_tokens: z.number().nullable().optional(),
  tools: z.array(z.unknown()).nullable().optional(),
  tool_choice: z.unknown().optional(),
}).passthrough()

// ─── Anthropic Messages ───────────────────────────────────────────

export const AnthropicMessagesPayloadSchema = z.object({
  model: z.string(),
  messages: z.array(z.union([
    AnthropicUserMessageSchema,
    AnthropicAssistantMessageSchema,
    AnthropicSystemMessageSchema,
  ])),
  max_tokens: z.number().int().nonnegative().optional(),
  stream: z.boolean().optional(),
  system: z.union([z.string(), z.array(AnthropicTextBlockSchema)]).optional(),
  cache_control: AnthropicCacheControlSchema.nullable().optional(),
  tools: z.array(AnthropicToolSchema).optional(),
  tool_choice: AnthropicToolChoiceSchema.optional(),
  thinking: AnthropicThinkingConfigSchema.optional(),
  output_config: AnthropicOutputConfigSchema.optional(),
  metadata: z.object({
    user_id: z.string().nullable().optional(),
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
  dimensions: z.number().int().positive().optional(),
  encoding_format: z.enum(['float', 'base64']).optional(),
  user: z.string().optional(),
}).passthrough()

// ─── Responses (OpenAI Responses API) ─────────────────────────────

const ResponsesMessageInputSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]),
}).passthrough()

const ResponsesFunctionCallInputSchema = z.object({
  type: z.literal('function_call'),
  id: z.string().optional(),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
  status: z.string().optional(),
}).passthrough()

const ResponsesFunctionCallOutputInputSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string(),
  output: z.union([
    z.string(),
    z.array(z.discriminatedUnion('type', [
      z.object({
        type: z.literal('input_text'),
        text: z.string(),
      }).passthrough(),
      z.object({
        type: z.literal('input_image'),
        image_url: z.string().nullable().optional(),
        file_id: z.string().nullable().optional(),
      }).passthrough().superRefine((value, ctx) => {
        if (typeof value.image_url === 'string' || typeof value.file_id === 'string') {
          return
        }

        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'input_image requires either "image_url" or "file_id"',
          path: ['image_url'],
        })
      }),
      z.object({
        type: z.literal('input_file'),
      }).passthrough(),
    ])),
  ]),
  status: z.enum(['completed', 'incomplete', 'in_progress']).nullable().optional(),
  is_error: z.boolean().optional(),
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
  instructions: z.string().nullable().optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  reasoning: z.unknown().optional(),
  text: z.unknown().optional(),
  stream: z.boolean().nullable().optional(),
  temperature: z.number().nullable().optional(),
  top_p: z.number().nullable().optional(),
  max_output_tokens: z.number().nullable().optional(),
}).passthrough()
