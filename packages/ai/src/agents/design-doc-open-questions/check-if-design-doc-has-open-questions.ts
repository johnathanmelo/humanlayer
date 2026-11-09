import { createHash } from 'node:crypto'

import * as Sentry from '@sentry/core'
import { Context, Data, Effect, Layer, Schedule } from 'effect'

import { type DesignDocQuestionCounts, inferDesignDocQuestionCounts } from './design-doc-open-questions'

export class DesignQuestionInferenceError extends Data.TaggedError('DesignQuestionInferenceError')<{
	message: string
	cause?: unknown
}> {}

export class DesignDocQuestionCounter extends Context.Service<
	DesignDocQuestionCounter,
	{
		readonly count: (docContent: string) => Promise<DesignDocQuestionCounts>
	}
>()('DesignDocQuestionCounter') {}

const DEFAULT_COUNT_CACHE_ENTRIES = 100

/**
 * Fork-only: wraps a question counter so the same document content is counted once.
 * The daemon re-uploads design-discussion docs on every Read and Edit, and each count is a full
 * Sonnet call over the whole document, so unchanged content must not pay for it again. Calls
 * for the same content share one in-flight promise; a failed count leaves the cache, so a
 * retry runs the model again. Least recently used entries are evicted past `maxEntries`.
 */
export function createCachedQuestionCounter(
	count: (docContent: string) => Promise<DesignDocQuestionCounts>,
	{ maxEntries = DEFAULT_COUNT_CACHE_ENTRIES }: { maxEntries?: number } = {},
): (docContent: string) => Promise<DesignDocQuestionCounts> {
	const cache = new Map<string, Promise<DesignDocQuestionCounts>>()
	return (docContent) => {
		const key = createHash('sha256').update(docContent).digest('hex')
		const cached = cache.get(key)
		if (cached) {
			// Re-insert so the Map's insertion order tracks recency.
			cache.delete(key)
			cache.set(key, cached)
			return cached
		}
		const pending = count(docContent)
		cache.set(key, pending)
		pending.catch(() => {
			if (cache.get(key) === pending) cache.delete(key)
		})
		while (cache.size > maxEntries) {
			const oldest = cache.keys().next().value
			if (oldest === undefined) break
			cache.delete(oldest)
		}
		return pending
	}
}

export const DesignDocQuestionCounterLive = Layer.succeed(DesignDocQuestionCounter, {
	count: createCachedQuestionCounter(inferDesignDocQuestionCounts),
})

const retrySchedule = Schedule.exponential('500 millis').pipe(Schedule.upTo({ times: 2 }))

export const checkIfDesignDocHasOpenQuestionsWithService = (docContent: string) =>
	Effect.gen(function* () {
		const counter = yield* DesignDocQuestionCounter
		return yield* Effect.tryPromise({
			try: () => counter.count(docContent),
			catch: (cause) =>
				new DesignQuestionInferenceError({
					message: 'Failed to count design questions',
					cause,
				}),
		})
	}).pipe(
		Effect.retry(retrySchedule),
		Effect.tapError((error) =>
			Effect.logError('[checkIfDesignDocHasOpenQuestions] Failed after retries', error).pipe(
				Effect.andThen(
					Effect.sync(() =>
						Sentry.captureException(error, { tags: { error_type: 'design_question_inference' } }),
					),
				),
			),
		),
	)

export const checkIfDesignDocHasOpenQuestions = (docContent: string) =>
	checkIfDesignDocHasOpenQuestionsWithService(docContent).pipe(Effect.provide(DesignDocQuestionCounterLive))
