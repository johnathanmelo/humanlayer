/**
 * Fork-only: an AI SDK language model that runs each call through the local Claude Code CLI,
 * so server-side AI features use the Claude Code login on this machine instead of an
 * Anthropic API key. Each call starts one headless Claude Code process with no tools, no MCP
 * servers, no user or project settings and no saved session.
 *
 * It supports what the agents in this package use: a system prompt, text messages and JSON
 * output with a schema (`Output.object`). It does not run AI SDK tools.
 */
import { statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
	UnsupportedFunctionalityError,
	type LanguageModelV3,
	type LanguageModelV3CallOptions,
	type LanguageModelV3GenerateResult,
	type LanguageModelV3Prompt,
	type LanguageModelV3StreamPart,
	type LanguageModelV3StreamResult,
	type LanguageModelV3Usage,
	type SharedV3Warning,
} from '@ai-sdk/provider'
import { query, type Options, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'

export type ClaudeCodeModelAlias = 'haiku' | 'sonnet'

/** The slice of the Agent SDK `query` function this model calls. Tests pass a fake. */
export type ClaudeCodeQuery = (input: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>

export interface ClaudeCodeLanguageModelConfig {
	readonly runQuery?: ClaudeCodeQuery
	/** Path to the `claude` binary. Defaults to {@link findClaudeCodeExecutable}. */
	readonly executablePath?: string
	/** Time limit for one call, counted after it gets a process slot. */
	readonly timeoutMs?: number
	/**
	 * How many `claude` processes this model may run at once. Defaults to a limit shared by every
	 * model in the process, read from `HUMANLAYER_CLAUDE_CODE_MAX_CONCURRENCY` (default 3).
	 */
	readonly maxConcurrency?: number
}

const PROVIDER = 'claude-code'
const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_MAX_CONCURRENCY = 3
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.'
const JSON_ONLY_INSTRUCTION = 'Respond with a single JSON value and nothing else.'

/**
 * Decides whether server-side AI calls use the local Claude Code login.
 * `HUMANLAYER_AI_PROVIDER=claude-code` or `=anthropic` forces the choice. Otherwise the login is
 * used when `ANTHROPIC_API_KEY` is unset, except under a test runner, where the upstream
 * behavior stays.
 */
export function shouldUseClaudeCodeLogin(env: NodeJS.ProcessEnv = process.env): boolean {
	const forced = env.HUMANLAYER_AI_PROVIDER?.trim().toLowerCase()
	if (forced === 'claude-code') return true
	if (forced === 'anthropic') return false
	if (env.VITEST || env.NODE_ENV === 'test') return false
	return !env.ANTHROPIC_API_KEY?.trim()
}

export interface ConcurrencyLimiter {
	/** Waits for a free slot and returns the function that frees it. Rejects if `signal` aborts first. */
	acquire(signal?: AbortSignal): Promise<() => void>
}

/** A first-in, first-out limit on how many calls run at once. */
export function createConcurrencyLimiter(max: number): ConcurrencyLimiter {
	let active = 0
	const waiting: Array<() => void> = []

	const releaser = () => {
		let released = false
		return () => {
			if (released) return
			released = true
			const next = waiting.shift()
			// Hand the slot straight to the next waiter, so `active` stays the same.
			if (next) next()
			else active--
		}
	}

	return {
		acquire(signal) {
			if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'))
			if (active < max) {
				active++
				return Promise.resolve(releaser())
			}
			return new Promise((resolve, reject) => {
				const grant = () => {
					signal?.removeEventListener('abort', onAbort)
					resolve(releaser())
				}
				const onAbort = () => {
					const index = waiting.indexOf(grant)
					if (index !== -1) waiting.splice(index, 1)
					reject(signal?.reason ?? new Error('Aborted'))
				}
				waiting.push(grant)
				signal?.addEventListener('abort', onAbort, { once: true })
			})
		},
	}
}

export function maxConcurrencyFromEnv(env: NodeJS.ProcessEnv = process.env): number {
	const configured = Number.parseInt(env.HUMANLAYER_CLAUDE_CODE_MAX_CONCURRENCY?.trim() ?? '', 10)
	return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_CONCURRENCY
}

// Each call is a separate `claude` process of a few hundred MB, so all models share one limit.
let sharedLimiter: ConcurrencyLimiter | undefined
function getSharedLimiter(): ConcurrencyLimiter {
	sharedLimiter ??= createConcurrencyLimiter(maxConcurrencyFromEnv())
	return sharedLimiter
}

function isFile(candidate: string): boolean {
	try {
		return statSync(candidate).isFile()
	} catch {
		return false
	}
}

/** Finds the `claude` binary the same way the daemon does (`claude-session-environment.ts`). */
export function findClaudeCodeExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const configured = env.HUMANLAYER_CLAUDE_PATH?.trim() || env.RIPTIDE_CLAUDE_PATH?.trim()
	if (configured) return configured

	const home = env.HOME?.trim() || os.homedir()
	const candidates = [
		path.join(home, '.local', 'bin', 'claude'),
		path.join(home, '.claude', 'local', 'claude'),
		path.join(home, '.npm', 'bin', 'claude'),
		path.join(home, '.bun', 'bin', 'claude'),
		'/usr/local/bin/claude',
		'/opt/homebrew/bin/claude',
		...(env.PATH ?? '')
			.split(path.delimiter)
			.filter((directory) => directory.length > 0)
			.map((directory) => path.join(directory, 'claude')),
	]
	return candidates.find(isFile)
}

export interface ClaudeCodePrompt {
	readonly systemPrompt: string
	readonly prompt: string
	readonly warnings: SharedV3Warning[]
}

/** Flattens an AI SDK prompt into one system prompt and one user prompt for `claude -p`. */
export function toClaudeCodePrompt(prompt: LanguageModelV3Prompt): ClaudeCodePrompt {
	const system: string[] = []
	const turns: Array<{ role: 'user' | 'assistant'; text: string }> = []
	const droppedPartTypes = new Set<string>()

	for (const message of prompt) {
		if (message.role === 'system') {
			system.push(message.content)
			continue
		}
		if (message.role === 'tool') {
			throw new UnsupportedFunctionalityError({
				functionality: 'tool messages',
				message: 'The Claude Code login provider does not run AI SDK tools.',
			})
		}
		const texts: string[] = []
		for (const part of message.content) {
			if (part.type === 'text') texts.push(part.text)
			else if (part.type !== 'reasoning') droppedPartTypes.add(part.type)
		}
		turns.push({ role: message.role, text: texts.join('') })
	}

	const [onlyTurn] = turns
	const promptText =
		turns.length === 1 && onlyTurn?.role === 'user'
			? onlyTurn.text
			: turns.map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`).join('\n\n')

	const warnings: SharedV3Warning[] = [...droppedPartTypes].map((type) => ({
		type: 'unsupported',
		feature: `${type} message parts`,
		details: 'Only text parts reach Claude Code.',
	}))
	return { systemPrompt: system.join('\n\n'), prompt: promptText, warnings }
}

const UNSUPPORTED_SETTINGS = [
	'maxOutputTokens',
	'temperature',
	'stopSequences',
	'topP',
	'topK',
	'presencePenalty',
	'frequencyPenalty',
	'seed',
] as const satisfies ReadonlyArray<keyof LanguageModelV3CallOptions>

function unsupportedSettingWarnings(options: LanguageModelV3CallOptions): SharedV3Warning[] {
	return UNSUPPORTED_SETTINGS.filter((setting) => options[setting] !== undefined).map((setting) => ({
		type: 'unsupported',
		feature: setting,
		details: 'Claude Code does not expose this setting.',
	}))
}

function toUsage(usage: SDKResultMessage['usage']): LanguageModelV3Usage {
	const noCache = usage.input_tokens
	const cacheRead = usage.cache_read_input_tokens ?? 0
	const cacheWrite = usage.cache_creation_input_tokens ?? 0
	return {
		inputTokens: { total: noCache + cacheRead + cacheWrite, noCache, cacheRead, cacheWrite },
		outputTokens: { total: usage.output_tokens, text: usage.output_tokens, reasoning: undefined },
	}
}

function describeFailure(result: SDKResultMessage): string {
	if (result.subtype === 'success') return result.result
	return result.errors.length > 0 ? result.errors.join('; ') : result.subtype
}

export function createClaudeCodeLanguageModel(
	alias: ClaudeCodeModelAlias,
	config: ClaudeCodeLanguageModelConfig = {},
): LanguageModelV3 {
	const runQuery: ClaudeCodeQuery = config.runQuery ?? query
	const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const limiter = config.maxConcurrency ? createConcurrencyLimiter(config.maxConcurrency) : undefined

	async function doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
		if (options.tools && options.tools.length > 0) {
			throw new UnsupportedFunctionalityError({
				functionality: 'tools',
				message: 'The Claude Code login provider does not run AI SDK tools.',
			})
		}

		const release = await (limiter ?? getSharedLimiter()).acquire(options.abortSignal)
		try {
			return await generateWithSlot(options)
		} finally {
			release()
		}
	}

	async function generateWithSlot(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
		const converted = toClaudeCodePrompt(options.prompt)
		const warnings = [...converted.warnings, ...unsupportedSettingWarnings(options)]
		const responseFormat = options.responseFormat
		const schema = responseFormat?.type === 'json' ? responseFormat.schema : undefined
		const baseSystemPrompt = converted.systemPrompt || DEFAULT_SYSTEM_PROMPT
		const systemPrompt =
			responseFormat?.type === 'json' && !schema
				? `${baseSystemPrompt}\n\n${JSON_ONLY_INSTRUCTION}`
				: baseSystemPrompt
		const executablePath = config.executablePath ?? findClaudeCodeExecutable()

		const abortController = new AbortController()
		const forwardAbort = () => abortController.abort(options.abortSignal?.reason)
		if (options.abortSignal?.aborted) forwardAbort()
		options.abortSignal?.addEventListener('abort', forwardAbort, { once: true })
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			abortController.abort()
		}, timeoutMs)

		const outputFormat: Options['outputFormat'] = schema
			? { type: 'json_schema', schema: schema as Record<string, unknown> }
			: undefined
		const sdkOptions: Options = {
			// Undefined falls back to the executable bundled with the SDK.
			pathToClaudeCodeExecutable: executablePath,
			model: alias,
			systemPrompt,
			tools: [],
			mcpServers: {},
			strictMcpConfig: true,
			settingSources: [],
			persistSession: false,
			thinking: { type: 'disabled' },
			cwd: os.tmpdir(),
			abortController,
			env: {
				...process.env,
				CLAUDE_AGENT_SDK_CLIENT_APP: 'humanlayer-api',
				CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
				// Skips the auto-update check and telemetry each process would otherwise do at startup.
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
			},
			outputFormat,
		}

		let modelId: string = alias
		let result: SDKResultMessage | undefined
		try {
			for await (const message of runQuery({ prompt: converted.prompt, options: sdkOptions })) {
				if (message.type === 'system' && message.subtype === 'init') modelId = message.model
				else if (message.type === 'result') result = message
			}
		} catch (error) {
			if (timedOut) {
				throw new Error(`Claude Code did not answer within ${Math.round(timeoutMs / 1000)}s`, { cause: error })
			}
			throw error
		} finally {
			clearTimeout(timer)
			options.abortSignal?.removeEventListener('abort', forwardAbort)
		}

		if (!result) throw new Error('Claude Code exited without a result')
		if (result.subtype !== 'success' || result.is_error) {
			throw new Error(`Claude Code call failed (${result.subtype}): ${describeFailure(result)}`)
		}

		const text = result.structured_output !== undefined ? JSON.stringify(result.structured_output) : result.result
		return {
			content: [{ type: 'text', text }],
			finishReason: { unified: 'stop', raw: result.stop_reason ?? undefined },
			usage: toUsage(result.usage),
			providerMetadata: {
				[PROVIDER]: {
					sessionId: result.session_id,
					durationMs: result.duration_ms,
					costUsd: result.total_cost_usd,
				},
			},
			response: { id: result.session_id, modelId, timestamp: new Date() },
			warnings,
		}
	}

	async function doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
		const generated = await doGenerate(options)
		const text = generated.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
		const stream = new ReadableStream<LanguageModelV3StreamPart>({
			start(controller) {
				controller.enqueue({ type: 'stream-start', warnings: generated.warnings })
				if (generated.response) controller.enqueue({ type: 'response-metadata', ...generated.response })
				controller.enqueue({ type: 'text-start', id: '0' })
				controller.enqueue({ type: 'text-delta', id: '0', delta: text })
				controller.enqueue({ type: 'text-end', id: '0' })
				controller.enqueue({
					type: 'finish',
					usage: generated.usage,
					finishReason: generated.finishReason,
					providerMetadata: generated.providerMetadata,
				})
				controller.close()
			},
		})
		return { stream }
	}

	return {
		specificationVersion: 'v3',
		provider: PROVIDER,
		modelId: alias,
		supportedUrls: {},
		doGenerate,
		doStream,
	}
}
