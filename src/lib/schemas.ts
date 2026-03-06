import { z } from 'zod'

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
  messages: z.array(z.object({
    role: z.string(),
    content: z.union([z.string(), z.array(z.unknown())]),
  }).passthrough()),
  max_tokens: z.number(),
  stream: z.boolean().optional(),
  system: z.union([z.string(), z.array(z.unknown())]).optional(),
  tools: z.array(z.unknown()).optional(),
  thinking: z.unknown().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
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
