/**
 * A fast, non-cryptographic key for a text: its length plus a 53-bit cyrb53 hash. Meant for
 * cache keys and React keys over large document text, where a SHA-256 in JavaScript (ohash in
 * the browser) costs milliseconds per call. Not for anything that needs collision resistance.
 */
export function contentKey(text: string): string {
	let h1 = 0xdeadbeef
	let h2 = 0x41c6ce57
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		h1 = Math.imul(h1 ^ code, 2654435761)
		h2 = Math.imul(h2 ^ code, 1597334677)
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
	const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0)
	return `${text.length}:${hash.toString(36)}`
}
