import { Code } from '@tiptap/extension-code'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details'
import { Highlight } from '@tiptap/extension-highlight'
import { Image } from '@tiptap/extension-image'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { BlockMath } from '@tiptap/extension-mathematics'
import { Mention } from '@tiptap/extension-mention'
import { TableKit } from '@tiptap/extension-table'
import { Typography } from '@tiptap/extension-typography'
import { Markdown } from '@tiptap/markdown'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { ReactNodeViewRenderer, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { all, createLowlight } from 'lowlight'
import { useRef } from 'react'

import { createCodeBlockComponent, type CustomLanguageRenderers } from '../../markdown-viewer/CodeBlock'
import { ArtifactSearch } from '../../markdown-viewer/ArtifactSearchExtension'
import { FrontmatterNode } from '../../markdown-viewer/FrontmatterNode'
import { parseFrontmatter } from '../../markdown-viewer/parseFrontmatter'
import { TaskItemComponent } from '../../markdown-viewer/TaskItemComponent'
import { SectionFoldingExtension } from '../folding/SectionFoldingExtension'
import { CommentHighlightExtension } from './CommentHighlightExtension'
import { KeyboardFocusExtension } from './KeyboardFocusExtension'
import { extractRenderedSelection } from './rendered-range'
import { buildSelectionIntent, type SelectionResult } from './selection'

const lowlight = createLowlight(all)
// Fences without a language render as plain text. Otherwise lowlight's highlightAuto tries every
// registered grammar (about 190), synchronously, on each unlabelled block of a large document.
const CODE_BLOCK_DEFAULT_LANGUAGE = 'plaintext'

export interface UseMarkdownViewerV2EditorOptions {
	content: string
	customLanguageRenderers?: CustomLanguageRenderers
}

export type SelectionInputSource = 'mouse' | 'keyboard'
export type SelectionResultHandler = (result: SelectionResult, editor: Editor, source: SelectionInputSource) => void

function selectionRectFallback(editor: Editor, from: number, to: number): DOMRect | null {
	try {
		const fromCoords = editor.view.coordsAtPos(from)
		const toCoords = editor.view.coordsAtPos(to)
		const left = Math.min(fromCoords.left, toCoords.left)
		const top = Math.min(fromCoords.top, toCoords.top)
		return new DOMRect(left, top, Math.abs(toCoords.right - left), Math.max(fromCoords.bottom, toCoords.bottom) - top)
	} catch {
		return null
	}
}

/**
 * Replace a live viewer editor's document with new artifact markdown, keeping
 * the editor instance. The new markdown is parsed off-view and only the range
 * that differs from the current document is replaced, so the unchanged blocks
 * keep their DOM, their React node views and their code highlighting: an agent
 * edit near the end of a large document no longer re-renders all of it. Mirrors
 * creation: FrontmatterNode only inserts its block in `onCreate`, so the new
 * document carries it at position 0. The transaction emits `update`, which
 * consumers use to re-derive the document.
 */
export function replaceEditorMarkdown(editor: Editor, content: string): void {
	const { data, body } = parseFrontmatter(content)
	const next = parseViewerDocument(editor, body, data)
	if (!next) {
		replaceEditorMarkdownFully(editor, body, data)
		return
	}

	const current = editor.state.doc
	const start = current.content.findDiffStart(next.content)
	if (start === null) return
	const end = current.content.findDiffEnd(next.content)
	if (!end) return
	let { a: endA, b: endB } = end
	// When the changed range repeats content on either side, the two scans can cross.
	const overlap = start - Math.min(endA, endB)
	if (overlap > 0) {
		endA += overlap
		endB += overlap
	}

	let tr
	try {
		tr = editor.state.tr.replace(start, endA, next.slice(start, endB))
		if (!tr.doc.eq(next)) {
			// The slice did not fit back into the same structure; replace the whole content instead.
			tr = editor.state.tr.replaceWith(0, current.content.size, next.content)
		}
	} catch {
		replaceEditorMarkdownFully(editor, body, data)
		return
	}
	editor.view.dispatch(tr)
}

/**
 * The viewer document for markdown, or null when this editor cannot parse it without the view.
 * Not validated with `check()`, like TipTap's own `setContent`: parsed markdown can carry mark
 * sets the schema calls invalid (bold inside inline code), which the live document has too.
 */
function parseViewerDocument(editor: Editor, body: string, data: Record<string, unknown>): ProseMirrorNode | null {
	if (!editor.markdown) return null
	try {
		const parsed = editor.markdown.parse(body)
		const blocks = [
			...(Object.keys(data).length > 0 ? [{ type: 'frontmatter', attrs: { data } }] : []),
			...(parsed.content ?? []),
		]
		return withTrailingNode(editor, editor.schema.nodeFromJSON({ type: 'doc', content: blocks }))
	} catch {
		return null
	}
}

/**
 * Apply StarterKit's TrailingNode rule to a document built off-view. The live document gets its
 * trailing paragraph from an appendTransaction; without the same node here, the diff would always
 * reach the end of the document and rebuild every block after the edit.
 */
function withTrailingNode(editor: Editor, doc: ProseMirrorNode): ProseMirrorNode {
	const trailing = editor.extensionManager.extensions.find((extension) => extension.name === 'trailingNode')
	if (!trailing) return doc
	const options = trailing.options as { node?: string; notAfter?: string[] }
	const defaultNode = options.node || editor.schema.topNodeType.contentMatch.defaultType?.name || 'paragraph'
	const lastChild = doc.lastChild
	if (lastChild && [...(options.notAfter ?? []), defaultNode].includes(lastChild.type.name)) return doc
	const type = editor.schema.nodes[defaultNode]
	return type ? doc.copy(doc.content.addToEnd(type.create())) : doc
}

function replaceEditorMarkdownFully(editor: Editor, body: string, data: Record<string, unknown>): void {
	const chain = editor.chain().setContent(body, { contentType: 'markdown' })
	if (Object.keys(data).length > 0) {
		chain.insertContentAt(0, { type: 'frontmatter', attrs: { data } }, { updateSelection: false })
	}
	chain.run()
}

/** Create the read-only Artifact Viewer V2 TipTap editor. */
export function useMarkdownViewerV2Editor({
	content,
	customLanguageRenderers,
}: UseMarkdownViewerV2EditorOptions,
onSelectionResult?: SelectionResultHandler): Editor | null {
	const CodeBlockComponent = createCodeBlockComponent(customLanguageRenderers)
	const { data: frontmatterData, body } = parseFrontmatter(content)
	const mouseSelectingRef = useRef(false)

	return useEditor({
		extensions: [
			StarterKit.configure({ codeBlock: false }),
			Code,
			Markdown,
			Typography,
			Image,
			Highlight,
			Details,
			DetailsContent,
			DetailsSummary,
			TaskItem.extend({
				addNodeView() {
					return ReactNodeViewRenderer(TaskItemComponent)
				},
			}),
			TaskList,
			Mention,
			BlockMath,
			TableKit,
			CodeBlockLowlight.extend({
				addNodeView() {
					return ReactNodeViewRenderer(CodeBlockComponent)
				},
			}).configure({ lowlight, defaultLanguage: CODE_BLOCK_DEFAULT_LANGUAGE }),
			FrontmatterNode.configure({ data: frontmatterData }),
			KeyboardFocusExtension,
			SectionFoldingExtension,
			ArtifactSearch,
			CommentHighlightExtension,
		],
		content: body,
		contentType: 'markdown',
		editable: false,
		editorProps: {
			attributes: { class: 'tiptap' },
			handleDOMEvents: {
				mousedown: (view) => {
					mouseSelectingRef.current = true
					view.dom.ownerDocument.addEventListener(
						'mouseup',
						() => {
							queueMicrotask(() => {
								mouseSelectingRef.current = false
							})
						},
						{ once: true },
					)
					return false
				},
			},
		},
		onSelectionUpdate: ({ editor }) => {
			const handler = onSelectionResult
			if (!handler) return
			const source: SelectionInputSource = mouseSelectingRef.current ? 'mouse' : 'keyboard'
			const { from, to, empty } = editor.state.selection
			if (empty) {
				handler({ status: 'empty' }, editor, source)
				return
			}
			const rendered = extractRenderedSelection(
				editor.view.dom.ownerDocument.getSelection(),
				editor.view.dom as HTMLElement,
			)
			if (!rendered) {
				handler({ status: 'empty' }, editor, source)
				return
			}
			const result = buildSelectionIntent(editor.state.doc, from, to, rendered.quote, rendered.rect)
			if (result.status === 'selection' && result.intent.rect == null) {
				handler(
					{
						status: 'selection',
						intent: { ...result.intent, rect: selectionRectFallback(editor, result.intent.from, result.intent.to) },
					},
					editor,
					source,
				)
				return
			}
			handler(result, editor, source)
		},
	})
}
