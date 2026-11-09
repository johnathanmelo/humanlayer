import { blockOffsetToPos, type AnchorBlock } from './block-text-offsets'
import type { BlockPoint } from './types'

/**
 * Candidate enumeration and scoring for V2 anchor resolution.
 *
 * Resolution never accepts "the first block whose text matches": every
 * matching block in the document is enumerated, scored against the anchor's
 * stored block + neighboring-context evidence, and the winner must be
 * deterministic. Ties on score break by document order (earliest position),
 * which is stable across reloads of the same document.
 */

/** Whitespace-normalize rendered text for drift-tolerant comparison. */
export function normalizeAnchorText(text: string): string {
	return text.replace(/\s+/g, ' ').trim()
}

/**
 * Fold typographic transforms (smart quotes/dashes/ellipses) back to their
 * plain-ASCII originals so a stored quote authored before a Typography pass —
 * or vice versa — still matches. Applied only in the normalized/transformed
 * search stage, never to the exact-offset verification.
 */
export function transformQuoteText(text: string): string {
	return normalizeAnchorText(
		text
			.replace(/[‘’‚‛]/g, "'")
			.replace(/[“”„‟]/g, '"')
			.replace(/[–—]/g, '-')
			.replace(/…/g, '...'),
	)
}

export interface ScoredBlockCandidate {
	/** Index into the anchor-block list. */
	index: number
	score: number
}

function contextScore(blocks: AnchorBlock[], index: number, point: BlockPoint): number {
	let score = 0
	const previousText = blocks[index - 1]?.text ?? null
	const nextText = blocks[index + 1]?.text ?? null
	// Exact neighbor agreement is strong evidence; normalized agreement still
	// counts (the neighbor merely reflowed), but less.
	if (previousText === point.previousBlockText) score += 4
	else if (
		previousText != null &&
		point.previousBlockText != null &&
		normalizeAnchorText(previousText) === normalizeAnchorText(point.previousBlockText)
	) {
		score += 2
	}
	if (nextText === point.nextBlockText) score += 4
	else if (
		nextText != null &&
		point.nextBlockText != null &&
		normalizeAnchorText(nextText) === normalizeAnchorText(point.nextBlockText)
	) {
		score += 2
	}
	return score
}

/**
 * Enumerate every block matching `matchesBlock`, scored by how well its
 * neighborhood agrees with the stored fingerprint. Returns candidates sorted
 * best-first (score descending, then document order). Callers own the match
 * predicate so exact and normalized/transformed passes stay separate, ordered
 * stages instead of one fuzzy search.
 */
export function findBlockCandidates(
	blocks: AnchorBlock[],
	point: BlockPoint,
	matchesBlock: (block: AnchorBlock) => boolean,
): ScoredBlockCandidate[] {
	const candidates: ScoredBlockCandidate[] = []
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index]!
		if (block.type !== point.blockType) continue
		if (!matchesBlock(block)) continue
		candidates.push({ index, score: contextScore(blocks, index, point) })
	}
	candidates.sort((a, b) => b.score - a.score || a.index - b.index)
	return candidates
}

/** A quote located across one or more blocks, ready to map back to PM positions. */
export interface QuoteRangeMatch {
	from: number
	to: number
	startBlockIndex: number
}

interface CharOwner {
	blockIndex: number
	/** Character offset into that block's `textContent`. */
	offset: number
}

/**
 * The block list flattened into one searchable string. Blocks are joined by a
 * single `\n`, which both mirrors {@link pmTextBetween}'s block separator and
 * lets a multi-block quote match contiguously. `starts[i]` is where block `i`
 * begins in `text`; the owner of any character is found with {@link ownerAt}
 * instead of a per-character table, which for a large document meant one
 * object per character on every comment resolution.
 */
export interface BlockConcat {
	text: string
	starts: number[]
}

interface SearchIndex {
	concat: BlockConcat
	normalized?: NormalizedText
	transformed?: NormalizedText
}

/**
 * Search data per block list. Every comment of one projection resolves against
 * the same `AnchorBlock[]`, so the document is flattened and normalized once
 * instead of once per comment.
 */
const searchIndexes = new WeakMap<AnchorBlock[], SearchIndex>()

function searchIndexFor(blocks: AnchorBlock[]): SearchIndex {
	let index = searchIndexes.get(blocks)
	if (!index) {
		index = { concat: buildBlockConcat(blocks) }
		searchIndexes.set(blocks, index)
	}
	return index
}

export function buildBlockConcat(blocks: AnchorBlock[]): BlockConcat {
	const starts: number[] = []
	let offset = 0
	for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
		if (blockIndex > 0) offset += 1
		starts.push(offset)
		offset += blocks[blockIndex]!.text.length
	}
	return { text: blocks.map((block) => block.text).join('\n'), starts }
}

/**
 * The block and offset a flat index belongs to. The separator after a block is
 * owned by that block's trailing edge (offset = its text length), so a match
 * that lands on it maps to a real block offset.
 */
export function ownerAt(concat: BlockConcat, flatIndex: number): CharOwner | null {
	if (flatIndex < 0 || flatIndex >= concat.text.length) return null
	let low = 0
	let high = concat.starts.length - 1
	while (low < high) {
		const middle = (low + high + 1) >> 1
		if (concat.starts[middle]! <= flatIndex) low = middle
		else high = middle - 1
	}
	return { blockIndex: low, offset: flatIndex - concat.starts[low]! }
}

export interface NormalizedText {
	text: string
	/** `map[i]` is the index in the original text of normalized character `i`. */
	map: ArrayLike<number>
}

/**
 * Collapse whitespace runs to one space, keeping a map back to original indices.
 * Leading and trailing whitespace is dropped. Works run by run rather than
 * testing a regex on every character.
 */
export function normalizeWithMap(text: string): NormalizedText {
	const parts: string[] = []
	const map = new Int32Array(text.length)
	let length = 0
	let chunkStart = 0
	const whitespace = /\s+/g
	for (let run = whitespace.exec(text); run; run = whitespace.exec(text)) {
		for (let i = chunkStart; i < run.index; i++) map[length++] = i
		if (run.index > chunkStart) parts.push(text.slice(chunkStart, run.index))
		if (length > 0) {
			parts.push(' ')
			map[length++] = run.index
		}
		chunkStart = run.index + run[0].length
	}
	for (let i = chunkStart; i < text.length; i++) map[length++] = i
	if (chunkStart < text.length) parts.push(text.slice(chunkStart))
	// Drop the space a run at the very end produced.
	if (parts.at(-1) === ' ') {
		parts.pop()
		length--
	}
	return { text: parts.join(''), map: map.subarray(0, length) }
}

/**
 * Find every occurrence of a needle in a haystack (exact substring), returning
 * flat start indices.
 */
function allIndicesOf(haystack: string, needle: string): number[] {
	const hits: number[] = []
	if (needle.length === 0) return hits
	let from = 0
	for (;;) {
		const idx = haystack.indexOf(needle, from)
		if (idx === -1) break
		hits.push(idx)
		from = idx + 1
	}
	return hits
}

/**
 * Locate a stored quote across the block list and map it back to PM positions.
 * Runs plannotator's ordered fallback: exact substring, then
 * whitespace-normalized, then typographic-transform-normalized. Every
 * occurrence is scored by how well the containing start block's neighborhood
 * agrees with the stored `start` fingerprint — a duplicate quote is never taken
 * by first-match. Ties break by document order.
 *
 * Returns null when no occurrence exists in any stage (the caller reports
 * Outdated — a failed precise range is never floored to a whole block).
 */
export function findQuoteRange(blocks: AnchorBlock[], selectedText: string, startPoint: BlockPoint): QuoteRangeMatch | null {
	if (selectedText.length === 0) return null
	const index = searchIndexFor(blocks)
	const { concat } = index

	// Stage A — exact substring in the raw concatenated text.
	const exact = pickQuoteOccurrence(blocks, concat, allIndicesOf(concat.text, selectedText), selectedText.length, startPoint)
	if (exact) return exact

	// Stage B — whitespace-normalized search, indices mapped back through the map.
	index.normalized ??= normalizeWithMap(concat.text)
	const normalizedHaystack = index.normalized
	const normalizedNeedle = normalizeAnchorText(selectedText)
	const normalized = pickNormalizedOccurrence(blocks, concat, normalizedHaystack, normalizedNeedle, startPoint)
	if (normalized) return normalized

	// Stage C — typographic transforms folded (smart quotes/dashes) on both sides.
	const transformedNeedle = transformQuoteText(selectedText)
	// Re-normalize the haystack text through the transform for parity.
	index.transformed ??= { text: transformQuoteText(normalizedHaystack.text), map: normalizedHaystack.map }
	const transformedHay = index.transformed
	if (transformedHay.text === normalizedHaystack.text.replace(/\s+/g, ' ').trim()) {
		// No typographic characters present — Stage C is identical to Stage B.
		return null
	}
	return pickNormalizedOccurrence(blocks, concat, transformedHay, transformedNeedle, startPoint)
}

function pickQuoteOccurrence(
	blocks: AnchorBlock[],
	concat: BlockConcat,
	flatStarts: number[],
	length: number,
	startPoint: BlockPoint,
): QuoteRangeMatch | null {
	let best: { match: QuoteRangeMatch; score: number; flatStart: number } | null = null
	for (const flatStart of flatStarts) {
		const match = mapFlatRange(blocks, concat, flatStart, flatStart + length)
		if (!match) continue
		const score = contextScore(blocks, match.startBlockIndex, startPoint)
		if (!best || score > best.score || (score === best.score && flatStart < best.flatStart)) {
			best = { match, score, flatStart }
		}
	}
	return best?.match ?? null
}

function pickNormalizedOccurrence(
	blocks: AnchorBlock[],
	concat: BlockConcat,
	normalizedHaystack: NormalizedText,
	normalizedNeedle: string,
	startPoint: BlockPoint,
): QuoteRangeMatch | null {
	if (normalizedNeedle.length === 0) return null
	const hits = allIndicesOf(normalizedHaystack.text, normalizedNeedle)
	let best: { match: QuoteRangeMatch; score: number; flatStart: number } | null = null
	for (const hit of hits) {
		const flatStart = normalizedHaystack.map[hit]
		const flatEnd = normalizedHaystack.map[hit + normalizedNeedle.length - 1]
		if (flatStart == null || flatEnd == null) continue
		const match = mapFlatRange(blocks, concat, flatStart, flatEnd + 1)
		if (!match) continue
		const score = contextScore(blocks, match.startBlockIndex, startPoint)
		if (!best || score > best.score || (score === best.score && flatStart < best.flatStart)) {
			best = { match, score, flatStart }
		}
	}
	return best?.match ?? null
}

/** Map a `[flatStart, flatEnd)` range in the concatenated text to PM positions. */
function mapFlatRange(
	blocks: AnchorBlock[],
	concat: BlockConcat,
	flatStart: number,
	flatEnd: number,
): QuoteRangeMatch | null {
	const startOwner = ownerAt(concat, flatStart)
	const endOwner = ownerAt(concat, flatEnd - 1)
	if (!startOwner || !endOwner) return null
	const startBlock = blocks[startOwner.blockIndex]
	const endBlock = blocks[endOwner.blockIndex]
	if (!startBlock || !endBlock) return null
	const from = blockOffsetToPos(startBlock, startOwner.offset)
	const to = blockOffsetToPos(endBlock, endOwner.offset + 1)
	if (to <= from) return null
	return { from, to, startBlockIndex: startOwner.blockIndex }
}
