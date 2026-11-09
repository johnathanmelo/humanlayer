import { Editor } from '@tiptap/core'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import { afterEach, describe, expect, test } from 'vitest'

import { FrontmatterNode } from '../../markdown-viewer/FrontmatterNode'
import { parseFrontmatter } from '../../markdown-viewer/parseFrontmatter'
import { replaceEditorMarkdown } from './useMarkdownViewerV2Editor'

const lowlight = createLowlight(common)
// The real node view renders through React; these tests only look at the document.
const PlainFrontmatterNode = FrontmatterNode.extend({ addNodeView: () => null })

let editors: Editor[] = []
afterEach(() => {
	for (const editor of editors) editor.destroy()
	editors = []
})

/** An editor built the way the viewer builds one for `content`, after its async `create`. */
async function makeEditor(content: string): Promise<Editor> {
	const { data, body } = parseFrontmatter(content)
	const editor = new Editor({
		extensions: [
			StarterKit.configure({ codeBlock: false }),
			Markdown,
			CodeBlockLowlight.configure({ lowlight, defaultLanguage: 'plaintext' }),
			PlainFrontmatterNode.configure({ data }),
		],
		content: body,
		contentType: 'markdown',
		editable: false,
	})
	editors.push(editor)
	// FrontmatterNode inserts its block in `onCreate`, which TipTap runs asynchronously.
	await new Promise<void>((resolve) => editor.on('create', () => resolve()))
	return editor
}

/** The previous implementation, which rebuilt the whole document: the reference result. */
function replaceWholeDocument(editor: Editor, content: string): void {
	const { data, body } = parseFrontmatter(content)
	const chain = editor.chain().setContent(body, { contentType: 'markdown' })
	if (Object.keys(data).length > 0) {
		chain.insertContentAt(0, { type: 'frontmatter', attrs: { data } }, { updateSelection: false })
	}
	chain.run()
}

async function expectedDocument(before: string, after: string) {
	const editor = await makeEditor(before)
	replaceWholeDocument(editor, after)
	return editor.state.doc.toJSON()
}

function section(index: number): string {
	return [
		`## Section ${index}`,
		'',
		`Paragraph ${index} explains the change in detail.`,
		'',
		'```ts',
		`export const value${index} = ${index}`,
		'```',
		'',
		`- item ${index}a`,
		`- item ${index}b`,
	].join('\n')
}

function longDocument(sections: number, edit?: { index: number; text: string }): string {
	const parts = Array.from({ length: sections }, (_, index) =>
		edit?.index === index ? edit.text : section(index),
	)
	return `---\ntype: research\nstatus: draft\n---\n# Research\n\n${parts.join('\n\n')}\n`
}

describe('replaceEditorMarkdown', () => {
	test('replaces only the edited block and keeps every other block as the same node', async () => {
		const before = longDocument(20)
		const after = longDocument(20, { index: 12, text: section(12).replace('in detail', 'in more detail') })
		const editor = await makeEditor(before)
		const previous = editor.state.doc

		replaceEditorMarkdown(editor, after)

		const next = editor.state.doc
		expect(next.toJSON()).toEqual(await expectedDocument(before, after))
		let reused = 0
		for (let index = 0; index < next.childCount; index++) {
			if (next.child(index) === previous.child(index)) reused++
		}
		// Only the edited paragraph is new.
		expect(reused).toBe(next.childCount - 1)
	})

	test.each([
		['appends a section', longDocument(5), longDocument(6)],
		['removes a section', longDocument(6), longDocument(5)],
		['edits a code block', longDocument(5), longDocument(5, { index: 2, text: section(2).replace('= 2', '= 22') })],
		['changes the frontmatter', longDocument(3), longDocument(3).replace('status: draft', 'status: final')],
		['adds frontmatter', '# Title\n\nBody', '---\ntype: plan\n---\n# Title\n\nBody'],
		['removes frontmatter', '---\ntype: plan\n---\n# Title\n\nBody', '# Title\n\nBody'],
		['repeats a block next to its copy', 'A\n\nB\n\nC', 'A\n\nB\n\nB\n\nC'],
		['empties the document', '# Title\n\nBody', ''],
		['fills an empty document', '', '# Title\n\nBody'],
	])('%s: ends with the same document as a full rebuild', async (_name, before, after) => {
		const editor = await makeEditor(before)

		replaceEditorMarkdown(editor, after)

		expect(editor.state.doc.toJSON()).toEqual(await expectedDocument(before, after))
	})

	test('dispatches nothing when the markdown parses to the same document', async () => {
		const content = longDocument(4)
		const editor = await makeEditor(content)
		replaceEditorMarkdown(editor, content)
		let updates = 0
		editor.on('update', () => {
			updates++
		})

		replaceEditorMarkdown(editor, content)

		expect(updates).toBe(0)
	})

	test('emits one update for a change', async () => {
		const editor = await makeEditor(longDocument(4))
		let updates = 0
		editor.on('update', () => {
			updates++
		})

		replaceEditorMarkdown(editor, longDocument(5))

		expect(updates).toBe(1)
	})
})
