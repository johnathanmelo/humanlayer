import { UnsupportedFunctionalityError } from '@ai-sdk/provider'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { generateText, Output } from 'ai'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'

import {
	type ClaudeCodeQuery,
	createClaudeCodeLanguageModel,
	shouldUseClaudeCodeLogin,
	toClaudeCodePrompt,
} from './claude-code-language-model'

const usage = {
	input_tokens: 3,
	output_tokens: 7,
	cache_creation_input_tokens: 100,
	cache_read_input_tokens: 20,
}

function successResult(fields: { result: string; structured_output?: unknown }): SDKMessage {
	return {
		type: 'result',
		subtype: 'success',
		is_error: false,
		duration_ms: 1200,
		duration_api_ms: 900,
		num_turns: 2,
		stop_reason: 'end_turn',
		total_cost_usd: 0.001,
		usage,
		modelUsage: {},
		permission_denials: [],
		session_id: 'session-1',
		uuid: '00000000-0000-0000-0000-000000000001',
		...fields,
	} as unknown as SDKMessage
}

const initMessage = { type: 'system', subtype: 'init', model: 'claude-haiku-5-5' } as unknown as SDKMessage

function fakeQuery(messages: SDKMessage[]): {
	runQuery: ClaudeCodeQuery
	calls: Array<{ prompt: string; options: Options }>
} {
	const calls: Array<{ prompt: string; options: Options }> = []
	const runQuery: ClaudeCodeQuery = (input) => {
		calls.push(input)
		return (async function* () {
			yield* messages
		})()
	}
	return { runQuery, calls }
}

describe('shouldUseClaudeCodeLogin', () => {
	test.each([
		[{}, true],
		[{ ANTHROPIC_API_KEY: '  ' }, true],
		[{ ANTHROPIC_API_KEY: 'sk-ant-test' }, false],
		[{ VITEST: 'true' }, false],
		[{ NODE_ENV: 'test' }, false],
		[{ HUMANLAYER_AI_PROVIDER: 'claude-code', ANTHROPIC_API_KEY: 'sk-ant-test', VITEST: 'true' }, true],
		[{ HUMANLAYER_AI_PROVIDER: 'anthropic' }, false],
	])('%o → %s', (env, expected) => {
		expect(shouldUseClaudeCodeLogin(env as NodeJS.ProcessEnv)).toBe(expected)
	})
})

describe('toClaudeCodePrompt', () => {
	test('keeps a single user message as the prompt and joins system messages', () => {
		const converted = toClaudeCodePrompt([
			{ role: 'system', content: 'Rule one.' },
			{ role: 'system', content: 'Rule two.' },
			{ role: 'user', content: [{ type: 'text', text: 'Fix the login loop' }] },
		])
		expect(converted).toEqual({
			systemPrompt: 'Rule one.\n\nRule two.',
			prompt: 'Fix the login loop',
			warnings: [],
		})
	})

	test('renders several turns as a transcript and warns about dropped parts', () => {
		const converted = toClaudeCodePrompt([
			{ role: 'user', content: [{ type: 'text', text: 'Hi' }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'Summarize' },
					{ type: 'file', data: 'aGk=', mediaType: 'text/plain' },
				],
			},
		])
		expect(converted.prompt).toBe('User: Hi\n\nAssistant: Hello\n\nUser: Summarize')
		expect(converted.warnings).toEqual([
			{ type: 'unsupported', feature: 'file message parts', details: 'Only text parts reach Claude Code.' },
		])
	})

	test('rejects tool messages', () => {
		expect(() =>
			toClaudeCodePrompt([
				{
					role: 'tool',
					content: [
						{ type: 'tool-result', toolCallId: '1', toolName: 'x', output: { type: 'text', value: 'y' } },
					],
				},
			]),
		).toThrow(UnsupportedFunctionalityError)
	})
})

describe('createClaudeCodeLanguageModel', () => {
	test('returns structured output parsed by generateText with Output.object', async () => {
		const { runQuery, calls } = fakeQuery([
			initMessage,
			successResult({ result: 'ignored', structured_output: { title: 'Fix Safari login loop' } }),
		])
		const model = createClaudeCodeLanguageModel('haiku', { runQuery, executablePath: '/opt/claude' })

		const {
			output,
			usage: callUsage,
			response,
		} = await generateText({
			model,
			system: 'Write a short task title.',
			prompt: 'Fix the login redirect loop on Safari',
			output: Output.object({ schema: z.object({ title: z.string() }) }),
			maxRetries: 0,
		})

		expect(output).toEqual({ title: 'Fix Safari login loop' })
		expect(callUsage.inputTokens).toBe(123)
		expect(callUsage.outputTokens).toBe(7)
		expect(response.modelId).toBe('claude-haiku-5-5')

		const [call] = calls
		expect(call?.prompt).toBe('Fix the login redirect loop on Safari')
		expect(call?.options).toMatchObject({
			pathToClaudeCodeExecutable: '/opt/claude',
			model: 'haiku',
			systemPrompt: 'Write a short task title.',
			tools: [],
			mcpServers: {},
			strictMcpConfig: true,
			settingSources: [],
			persistSession: false,
			thinking: { type: 'disabled' },
		})
		expect(call?.options.outputFormat?.type).toBe('json_schema')
		expect(call?.options.outputFormat?.schema).toMatchObject({ type: 'object', required: ['title'] })
	})

	test('returns the plain result text when no schema is requested', async () => {
		const { runQuery, calls } = fakeQuery([successResult({ result: 'Plain answer' })])
		const model = createClaudeCodeLanguageModel('sonnet', { runQuery })

		const { text } = await generateText({ model, prompt: 'Say something', maxRetries: 0 })

		expect(text).toBe('Plain answer')
		expect(calls[0]?.options.outputFormat).toBeUndefined()
		expect(calls[0]?.options.systemPrompt).toBe('You are a helpful assistant.')
	})

	test('throws the Claude Code message when the result is an error', async () => {
		const { runQuery } = fakeQuery([
			{ ...successResult({ result: 'Not logged in · Please run /login' }), is_error: true } as SDKMessage,
		])
		const model = createClaudeCodeLanguageModel('haiku', { runQuery })

		await expect(generateText({ model, prompt: 'Hi', maxRetries: 0 })).rejects.toThrow(
			'Claude Code call failed (success): Not logged in · Please run /login',
		)
	})

	test('throws when Claude Code exits without a result', async () => {
		const { runQuery } = fakeQuery([initMessage])
		const model = createClaudeCodeLanguageModel('haiku', { runQuery })

		await expect(generateText({ model, prompt: 'Hi', maxRetries: 0 })).rejects.toThrow(
			'Claude Code exited without a result',
		)
	})

	test('reports a timeout instead of a bare abort', async () => {
		const runQuery: ClaudeCodeQuery = ({ options }) =>
			(async function* () {
				await new Promise((_, reject) => {
					options.abortController?.signal.addEventListener('abort', () => reject(new Error('aborted')))
				})
				yield initMessage
			})()
		const model = createClaudeCodeLanguageModel('haiku', { runQuery, timeoutMs: 10 })

		await expect(generateText({ model, prompt: 'Hi', maxRetries: 0 })).rejects.toThrow(
			'Claude Code did not answer within 0s',
		)
	})

	test('streams the generated text', async () => {
		const { runQuery } = fakeQuery([successResult({ result: 'Streamed answer' })])
		const model = createClaudeCodeLanguageModel('haiku', { runQuery })

		const { stream } = await model.doStream({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
		})
		const parts: string[] = []
		for await (const part of stream) {
			if (part.type === 'text-delta') parts.push(part.delta)
		}

		expect(parts.join('')).toBe('Streamed answer')
	})
})
