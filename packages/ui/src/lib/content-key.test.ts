import { describe, expect, test } from 'vitest'

import { contentKey } from './content-key'

describe('contentKey', () => {
	test('is stable for the same text and differs for small edits', () => {
		const text = '# Research\n\n'.repeat(5000)
		expect(contentKey(text)).toBe(contentKey(`${text}`))
		expect(contentKey(text)).not.toBe(contentKey(`${text} `))
		expect(contentKey('ab')).not.toBe(contentKey('ba'))
	})

	test('starts with the text length', () => {
		expect(contentKey('')).toMatch(/^0:/)
		expect(contentKey('héllo')).toMatch(/^5:/)
	})
})
