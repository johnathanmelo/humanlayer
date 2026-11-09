import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

import { buildHeadingAnchors, buildOutline, collectDocumentHeadings } from '../toc/build-outline'
import { buildNavigableBlocks } from '../viewer/build-navigable-blocks'
import type { SectionRange } from './section-ranges'
import { buildSectionRanges } from './section-ranges'

interface FoldingInput { ranges: SectionRange[]; foldedHeadingIds: ReadonlySet<string> }
/**
 * The decorations are built when the plugin state changes (new folds, new ranges or a new
 * document), not in `props.decorations`: ProseMirror calls that on every view update,
 * selection changes included, and building them walks the whole document.
 */
interface FoldingState extends FoldingInput { decorations: DecorationSet }
const foldingKey = new PluginKey<FoldingState>('artifactViewerV2SectionFolding')

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Build the lucide `ChevronRight` glyph as a standalone SVG — the same icon and
 * stroke treatment the left sidebar task tree's disclosure uses (`lucide-react`
 * ChevronRight at size-3). It is drawn imperatively because the fold control is
 * a ProseMirror widget decoration, not a React node; rotation to the expanded
 * state is applied by CSS keyed on the button's `aria-expanded`.
 */
function createChevronRightIcon(): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg')
	svg.setAttribute('xmlns', SVG_NS)
	svg.setAttribute('width', '12')
	svg.setAttribute('height', '12')
	svg.setAttribute('viewBox', '0 0 24 24')
	svg.setAttribute('fill', 'none')
	svg.setAttribute('stroke', 'currentColor')
	svg.setAttribute('stroke-width', '2')
	svg.setAttribute('stroke-linecap', 'round')
	svg.setAttribute('stroke-linejoin', 'round')
	svg.setAttribute('class', 'lucide lucide-chevron-right')
	svg.setAttribute('aria-hidden', 'true')
	const path = document.createElementNS(SVG_NS, 'path')
	path.setAttribute('d', 'm9 18 6-6-6-6')
	svg.appendChild(path)
	return svg
}

function buildFoldingDecorations(doc: ProseMirrorNode, folding: FoldingInput): DecorationSet {
	const headings = collectDocumentHeadings(doc)
	const outline = buildOutline(headings)
	const ranges = folding.ranges.length > 0
		? folding.ranges
		: buildSectionRanges(outline, buildNavigableBlocks(doc, outline))
	const decorations: Decoration[] = []
	for (const heading of buildHeadingAnchors(headings)) {
		const node = doc.nodeAt(heading.pos)
		if (!node) continue
		decorations.push(Decoration.node(heading.pos, heading.pos + node.nodeSize, {
			id: heading.id,
			'data-heading-id': heading.id,
		}))
	}
	for (const range of ranges) {
		const heading = doc.nodeAt(range.headingPos)
		if (!heading) continue
		const folded = folding.foldedHeadingIds.has(range.id)
		decorations.push(Decoration.widget(range.headingPos + 1, () => {
			const button = document.createElement('button')
			button.type = 'button'
			button.className = 'artifact-viewer-v2-heading-disclosure'
			button.dataset.headingId = range.id
			button.setAttribute('aria-label', `${folded ? 'Expand' : 'Collapse'} ${heading.textContent}`)
			button.setAttribute('aria-expanded', String(!folded))
			button.appendChild(createChevronRightIcon())
			return button
		// `side: -1` places the control at the very start of the heading, before
		// its authored inline content; `marks: []` keeps it out of any leading
		// inline-code/bold mark span so it never inherits that box or background.
		}, { key: `fold-${range.id}-${folded}`, side: -1, marks: [] }))
		decorations.push(Decoration.node(range.headingPos, range.headingPos + heading.nodeSize, {
			class: folded ? 'artifact-viewer-v2-heading-collapsed' : '',
			'aria-expanded': String(!folded),
		}))
		if (!folded) continue
		const from = range.headingPos + heading.nodeSize
		const to = Math.min(range.endPos, doc.content.size)
		doc.nodesBetween(from, to, (node, pos) => {
			if (pos < from || pos + node.nodeSize > to) return true
			decorations.push(Decoration.node(pos, pos + node.nodeSize, {
				class: 'artifact-viewer-v2-section-hidden',
			}))
			return false
		})
	}
	return DecorationSet.create(doc, decorations)
}

function foldingState(doc: ProseMirrorNode, folding: FoldingInput): FoldingState {
	return { ...folding, decorations: buildFoldingDecorations(doc, folding) }
}

export const SectionFoldingExtension = Extension.create({
	name: 'artifactViewerV2SectionFolding',
	addProseMirrorPlugins() {
		return [new Plugin<FoldingState>({
			key: foldingKey,
			state: {
				init: (_, { doc }) => foldingState(doc, { ranges: [], foldedHeadingIds: new Set() }),
				apply(tr, value, _oldState, newState) {
					const meta = tr.getMeta(foldingKey) as FoldingInput | undefined
					if (meta) return foldingState(newState.doc, meta)
					// A new document invalidates the ranges' positions; folds stay keyed by heading id.
					return tr.docChanged
						? foldingState(newState.doc, { ranges: [], foldedHeadingIds: value.foldedHeadingIds })
						: value
				},
			},
			props: {
				decorations(state) {
					return foldingKey.getState(state)?.decorations ?? DecorationSet.empty
				},
			},
		})]
	},
})

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false
	for (const id of a) if (!b.has(id)) return false
	return true
}

/**
 * Apply section ranges and folds. The controller calls this on every render, so it skips the
 * transaction (and the decoration rebuild) when nothing changed: the same memoized ranges and
 * the same folded ids.
 */
export function setSectionFolding(view: EditorView, ranges: SectionRange[], foldedHeadingIds: ReadonlySet<string>) {
	const current = foldingKey.getState(view.state)
	if (current && current.ranges === ranges && sameIds(current.foldedHeadingIds, foldedHeadingIds)) return
	view.dispatch(view.state.tr.setMeta(foldingKey, { ranges, foldedHeadingIds: new Set(foldedHeadingIds) }))
}

export function getFoldedHeadingIds(state: EditorState): ReadonlySet<string> {
	return foldingKey.getState(state)?.foldedHeadingIds ?? new Set()
}
