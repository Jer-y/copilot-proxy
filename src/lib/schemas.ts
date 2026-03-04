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

export const ResponsesPayloadSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(z.unknown())]),
  tools: z.array(z.unknown()).optional(),
  reasoning: z.unknown().optional(),
  stream: z.boolean().optional(),
  temperature: z.number().nullable().optional(),
  top_p: z.number().nullable().optional(),
}).passthrough()
