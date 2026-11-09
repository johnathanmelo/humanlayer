import { openai } from '@ai-sdk/openai'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { resolvePrimaryModel } from '@humanlayer/ai/providers'
import { createReliableLanguageModel } from '@humanlayer/ai/reliable-language-model'

import { Sentry } from '../instrument'
import { logger } from '../logger'

type RiptideModelAlias = 'haiku' | 'sonnet'

// Fork-only: resolvePrimaryModel returns the Anthropic API models when ANTHROPIC_API_KEY is set,
// and the local Claude Code login otherwise. See FORK.md.
const PRIMARY: Record<RiptideModelAlias, LanguageModelV3> = {
	haiku: resolvePrimaryModel('haiku'),
	sonnet: resolvePrimaryModel('sonnet'),
}

const SECONDARY: Record<RiptideModelAlias, LanguageModelV3> = {
	haiku: openai('gpt-5-mini'),
	sonnet: openai('gpt-5'),
}

// Fork-only: without an OpenAI key the fallback can only fail, and wrapping the primary would retry
// it up to 4 times first (each Claude Code call may take minutes). Mirrors resolveModel in
// packages/ai/src/providers/models.ts.
const isFallbackEnabled = Boolean(process.env.OPENAI_API_KEY?.trim())

export function createRiptideReliableLanguageModel(alias: RiptideModelAlias): LanguageModelV3 {
	if (!isFallbackEnabled) return PRIMARY[alias]
	return createReliableLanguageModel({
		primary: PRIMARY[alias],
		secondary: SECONDARY[alias],
		onAnyError: (error) => {
			Sentry.addBreadcrumb({
				category: 'ai-inference',
				level: 'warning',
				message: 'AI language model call failed; retrying reliable model path',
				data: {
					alias,
					error_message: error instanceof Error ? error.message : String(error),
				},
			})
			logger.warn(
				{
					alias,
					error_message: error instanceof Error ? error.message : String(error),
				},
				'AI language model call failed; retrying reliable model path',
			)
		},
		onFailure: (error) => {
			Sentry.captureException(error, {
				tags: {
					error_type: 'ai_fallback_exhausted',
					model_alias: alias,
				},
				extra: {
					fallback_provider: 'openai',
					primary_provider: 'anthropic',
				},
			})
		},
	})
}
