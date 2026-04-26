import { beforeEach, describe, expect, test } from 'bun:test'

import { clearProbeCache } from '~/lib/api-probe'
import {
  planChatCompletionsBackends,
  planMessagesBackends,
  planResponsesBackends,
} from '~/lib/routing-policy'

beforeEach(() => {
  clearProbeCache()
})

describe('planMessagesBackends', () => {
  test('prefers native Anthropic for Claude by default', () => {
    const policy = planMessagesBackends('claude-opus-4.6', {
      model: 'claude-opus-4.6',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(policy).toEqual({
      resolvedBackend: 'anthropic-messages',
      steps: [
        { api: 'anthropic-messages' },
        { api: 'chat-completions' },
      ],
    })
  })

  test('bypasses native Anthropic for json_object requests', () => {
    const policy = planMessagesBackends('claude-opus-4.6', {
      model: 'claude-opus-4.6',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Return JSON.' }],
      output_config: {
        format: {
          type: 'json_object',
        },
      },
    })

    expect(policy).toEqual({
      resolvedBackend: 'anthropic-messages',
      steps: [
        { api: 'chat-completions', context: 'json_object requires an OpenAI-compatible backend' },
      ],
    })
  })

  test('keeps json_schema requests on native Anthropic so Copilot can surface unsupported output_config.format', () => {
    const policy = planMessagesBackends('claude-opus-4.6', {
      model: 'claude-opus-4.6',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Return JSON.' }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
          },
        },
      },
    })

    expect(policy).toEqual({
      resolvedBackend: 'anthropic-messages',
      steps: [
        {
          api: 'anthropic-messages',
          context: 'json_schema structured output requires native Anthropic /v1/messages passthrough',
        },
      ],
    })
  })

  test('bypasses native Anthropic for URL-backed document blocks', () => {
    const policy = planMessagesBackends('claude-opus-4.6', {
      model: 'claude-opus-4.6',
      max_tokens: 64,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'url',
                url: 'https://example.com/report.pdf',
              },
            },
          ],
        },
      ],
    })

    expect(policy).toEqual({
      resolvedBackend: 'anthropic-messages',
      steps: [
        {
          api: 'chat-completions',
          context: 'document.source.type="url" is expanded locally because Copilot native /v1/messages rejects URL-backed documents',
        },
      ],
    })
  })

  test('prefers responses for responses-backed models', () => {
    const policy = planMessagesBackends('gpt-5.4', {
      model: 'gpt-5.4',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(policy).toEqual({
      resolvedBackend: 'responses',
      steps: [{ api: 'responses' }],
    })
  })

  test('keeps only chat-completions for chat-completions-only models', () => {
    const policy = planMessagesBackends('gpt-4o', {
      model: 'gpt-4o',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(policy).toEqual({
      resolvedBackend: 'chat-completions',
      steps: [{ api: 'chat-completions' }],
    })
  })
})

describe('planResponsesBackends', () => {
  test('prefers native Anthropic for Claude responses requests by default', () => {
    const policy = planResponsesBackends('claude-opus-4.6', {
      model: 'claude-opus-4.6',
      input: 'hi',
    })

    expect(policy).toEqual({
      resolvedBackend: 'anthropic-messages',
      steps: [
        { api: 'anthropic-messages' },
        { api: 'chat-completions' },
      ],
    })
  })

  test('routes Claude json_object requests only through OpenAI-compatible backends', () => {
    const policy = planResponsesBackends('claude-opus-4.6', {
      model: 'claude-opus-4.6',
      input: 'Return JSON.',
      text: {
        format: {
          type: 'json_object',
        },
      },
    })

    expect(policy).toEqual({
      resolvedBackend: 'anthropic-messages',
      exhaustedError: 'Model claude-opus-4.6 does not support /chat/completions (json_object structured output).',
      steps: [
        { api: 'chat-completions', context: 'json_object structured output' },
      ],
    })
  })

  test('keeps Claude json_schema responses requests on native Anthropic so unsupported format is not falsely treated as supported', () => {
    const policy = planResponsesBackends('claude-opus-4.6', {
      model: 'claude-opus-4.6',
      input: 'Return JSON.',
      text: {
        format: {
          type: 'json_schema',
          name: 'sample',
          schema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
          },
        },
      },
    })

    expect(policy).toEqual({
      resolvedBackend: 'anthropic-messages',
      steps: [
        {
          api: 'anthropic-messages',
          context: 'json_schema structured output requires native Anthropic /v1/messages passthrough',
        },
      ],
    })
  })

  test('rejects input_file when Claude would need Anthropic translation', () => {
    const policy = planResponsesBackends('claude-opus-4.6', {
      model: 'claude-opus-4.6',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Summarize this file.' },
            { type: 'input_file', file_url: 'https://example.com/report.pdf' },
          ],
        },
      ],
    })

    expect(policy.localError).toBe(
      'input_file is only supported when routing this model directly through /responses. Use a model that supports /responses directly, or provide content that can be represented as translated text/image blocks.',
    )
    expect(policy.steps).toEqual([
      { api: 'anthropic-messages' },
      { api: 'chat-completions' },
    ])
  })

  test('rejects hosted Responses tools when translation would be required', () => {
    const policy = planResponsesBackends('claude-opus-4.6', {
      model: 'claude-opus-4.6',
      input: 'Search the web.',
      tools: [
        {
          type: 'web_search',
        },
      ],
    })

    expect(policy.localError).toBe(
      'Hosted Responses tools are only supported when routing this model directly through /responses. Use a Responses-backed model or replace hosted tools with function tools.',
    )
    expect(policy.steps).toEqual([
      { api: 'anthropic-messages' },
      { api: 'chat-completions' },
    ])
  })

  test('prefers responses for responses-native models', () => {
    const policy = planResponsesBackends('gpt-5.4', {
      model: 'gpt-5.4',
      input: 'hi',
    })

    expect(policy).toEqual({
      resolvedBackend: 'responses',
      steps: [{ api: 'responses' }],
    })
  })

  test('keeps only chat-completions for chat-completions-only models', () => {
    const policy = planResponsesBackends('gpt-4o', {
      model: 'gpt-4o',
      input: 'hi',
    })

    expect(policy).toEqual({
      resolvedBackend: 'chat-completions',
      steps: [{ api: 'chat-completions' }],
    })
  })
})

describe('planChatCompletionsBackends', () => {
  test('keeps chat-completions first for dual-stack models', () => {
    expect(planChatCompletionsBackends('gpt-5')).toEqual({
      resolvedBackend: 'chat-completions',
      steps: [
        { api: 'chat-completions' },
        { api: 'responses' },
      ],
    })
  })

  test('uses responses directly for responses-only models', () => {
    expect(planChatCompletionsBackends('gpt-5.4')).toEqual({
      resolvedBackend: 'responses',
      steps: [{ api: 'responses' }],
    })
  })

  test('keeps only chat-completions for Claude models', () => {
    expect(planChatCompletionsBackends('claude-opus-4.6')).toEqual({
      resolvedBackend: 'chat-completions',
      steps: [{ api: 'chat-completions' }],
    })
  })
})
