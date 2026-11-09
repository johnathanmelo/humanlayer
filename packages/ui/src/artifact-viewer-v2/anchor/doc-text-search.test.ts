import { describe, expect, test } from 'vitest'

import type { AnchorBlock } from './block-text-offsets'
import { buildBlockConcat, normalizeWithMap, ownerAt } from './doc-text-search'

/** The previous per-character implementations, kept as the reference behavior. */
function referenceConcat(blocks: Array<{ text: string }>) {
	let text = ''
	const owners: Array<{ blockIndex: number; offset: number }> = []
	blocks.forEach((block, blockIndex) => {
		if (blockIndex > 0) {
			owners.push({ blockIndex: blockIndex - 1, offset: blocks[blockIndex - 1]!.text.length })
			text += '\n'
		}
		for (let i = 0; i < block.text.length; i++) {
			owners.push({ blockIndex, offset: i })
			text += block.text[i]
		}
	})
	return { text, owners }
}

function referenceNormalize(text: string): { text: string; map: number[] } {
	let out = ''
	const map: number[] = []
	let inRun = false
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!
		if (/\s/.test(ch)) {
			if (!inRun && out.length > 0) {
				out += ' '
				map.push(i)
			}
			inRun = true
		} else {
			out += ch
			map.push(i)
			inRun = false
		}
	}
	if (out.endsWith(' ')) {
		out = out.slice(0, -1)
		map.pop()
	}
	return { text: out, map }
}

// Deterministic pseudo-random text with runs of mixed whitespace, typographic characters and
// empty blocks, the cases where the flat index and the owning block are easy to get wrong.
function randomTexts(seed: number, count: number): string[] {
	let state = seed
	const next = () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff
		return state
	}
	const alphabet = ['a', 'b', ' ', '  ', '\t', '\n', '“', '”', '—', '…', 'é', '😀', ' ']
	return Array.from({ length: count }, () =>
		Array.from({ length: next() % 12 }, () => alphabet[next() % alphabet.length]).join(''),
	)
}

const asBlocks = (texts: string[]) => texts.map((text) => ({ text })) as unknown as AnchorBlock[]

describe('buildBlockConcat and ownerAt', () => {
	test.each([1, 2, 3, 4, 5, 6, 7, 8])('match the per-character owner table (seed %i)', (seed) => {
		const blocks = asBlocks(randomTexts(seed, 1 + (seed % 7)))
		const reference = referenceConcat(blocks)
		const concat = buildBlockConcat(blocks)

		expect(concat.text).toBe(reference.text)
		for (let index = -1; index <= reference.text.length; index++) {
			expect(ownerAt(concat, index)).toEqual(reference.owners[index] ?? null)
		}
	})

	test('handles an empty block list', () => {
		const concat = buildBlockConcat([])
		expect(concat.text).toBe('')
		expect(ownerAt(concat, 0)).toBeNull()
	})
})

describe('normalizeWithMap', () => {
	test.each([
		'',
		'   ',
		'plain',
		'  leading and trailing  ',
		'a\n\n\tb',
		'“quoted” — text… end ',
		...randomTexts(42, 20),
		...randomTexts(7, 20),
	])('matches the per-character implementation for %j', (text) => {
		const result = normalizeWithMap(text)
		const reference = referenceNormalize(text)

		expect(result.text).toBe(reference.text)
		expect(Array.from(result.map)).toEqual(reference.map)
	})
})
