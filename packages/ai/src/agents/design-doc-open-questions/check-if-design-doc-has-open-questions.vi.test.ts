import { describe, expect, test } from 'vitest'

import { createCachedQuestionCounter } from './check-if-design-doc-has-open-questions'
import type { DesignDocQuestionCounts } from './design-doc-open-questions'

function countingCounter(results: Array<DesignDocQuestionCounts | Error>) {
	const calls: string[] = []
	const count = async (docContent: string) => {
		calls.push(docContent)
		const next = results[Math.min(calls.length - 1, results.length - 1)]
		if (next instanceof Error) throw next
		return next as DesignDocQuestionCounts
	}
	return { calls, count }
}

const OPEN = { numOpenQuestions: 2, numResolvedQuestions: 1 }
const RESOLVED = { numOpenQuestions: 0, numResolvedQuestions: 3 }

describe('createCachedQuestionCounter', () => {
	test('counts the same content once', async () => {
		const { calls, count } = countingCounter([OPEN])
		const cached = createCachedQuestionCounter(count)

		expect(await cached('# Design\n\n#### Q1')).toEqual(OPEN)
		expect(await cached('# Design\n\n#### Q1')).toEqual(OPEN)

		expect(calls).toHaveLength(1)
	})

	test('shares one in-flight call between concurrent callers', async () => {
		const { calls, count } = countingCounter([OPEN])
		const cached = createCachedQuestionCounter(count)

		const [first, second] = await Promise.all([cached('doc'), cached('doc')])

		expect(first).toEqual(OPEN)
		expect(second).toEqual(OPEN)
		expect(calls).toHaveLength(1)
	})

	test('counts changed content again', async () => {
		const { calls, count } = countingCounter([OPEN, RESOLVED])
		const cached = createCachedQuestionCounter(count)

		expect(await cached('before')).toEqual(OPEN)
		expect(await cached('after')).toEqual(RESOLVED)

		expect(calls).toEqual(['before', 'after'])
	})

	test('does not cache a failed count', async () => {
		const { calls, count } = countingCounter([new Error('model unavailable'), RESOLVED])
		const cached = createCachedQuestionCounter(count)

		await expect(cached('doc')).rejects.toThrow('model unavailable')
		expect(await cached('doc')).toEqual(RESOLVED)

		expect(calls).toHaveLength(2)
	})

	test('evicts the least recently used content past the limit', async () => {
		const { calls, count } = countingCounter([OPEN])
		const cached = createCachedQuestionCounter(count, { maxEntries: 2 })

		await cached('a')
		await cached('b')
		await cached('a') // a is now the most recently used
		await cached('c') // evicts b
		await cached('a')
		await cached('b')

		expect(calls).toEqual(['a', 'b', 'c', 'b'])
	})
})
