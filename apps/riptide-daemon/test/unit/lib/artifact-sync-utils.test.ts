import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import matter from 'gray-matter'
import { describe, expect, test } from 'vitest'

import { createArtifactSyncLedger } from '../../../src/lib/artifact-sync-ledger'
import {
	findUnchangedTextRead,
	getOperationType,
	getTaskArtifactPathsFromApplyPatch,
	isApplyPatchTool,
	isEditTool,
	isReadTool,
	isTextFile,
	isWriteTool,
	parseArtifactFrontmatter,
	rememberDesignQuestions,
	scanTaskArtifactDirectory,
} from '../../../src/lib/artifact-sync-utils'
import { createUniqueTempDir } from '../../helpers/concurrency'

describe('artifact file classification', () => {
	test.each([
		'artifact.md',
		'artifact.mdx',
		'artifact.txt',
		'artifact.json',
		'artifact.jsonl',
		'ARTIFACT.JSON',
		'ARTIFACT.JSONL',
	])('classifies %s as text', (fileName) => {
		expect(isTextFile(fileName)).toBe(true)
	})

	test.each(['artifact.png', 'artifact.pdf', 'artifact.json.gz'])('classifies %s as binary', (fileName) => {
		expect(isTextFile(fileName)).toBe(false)
	})
})

describe('tool name normalization', () => {
	test.each(['Read', 'read'])('recognizes %s as read', (toolName) => {
		expect(isReadTool(toolName)).toBe(true)
		expect(getOperationType(toolName)).toBe('Read')
	})

	test.each(['Write', 'write'])('recognizes %s as write', (toolName) => {
		expect(isWriteTool(toolName)).toBe(true)
		expect(getOperationType(toolName)).toBe('Write')
	})

	test.each(['Edit', 'edit', 'MultiEdit', 'multi_edit', 'apply_patch', 'apply-patch'])(
		'recognizes %s as edit family',
		(toolName) => {
			expect(isEditTool(toolName)).toBe(true)
			expect(getOperationType(toolName)).toBe('Edit')
		},
	)

	test.each(['apply_patch', 'apply-patch'])('recognizes %s as apply_patch', (toolName) => {
		expect(isApplyPatchTool(toolName)).toBe(true)
	})

	test('returns undefined for non-file tools', () => {
		expect(getOperationType('functions.agent')).toBeUndefined()
	})
})

describe('getTaskArtifactPathsFromApplyPatch', () => {
	test('returns only files under the current task artifact directory', () => {
		const cwd = '/repo'
		const taskSlug = 'core-1025-task'
		const toolInput = {
			patch_text: `*** Begin Patch
*** Update File: src/index.ts
@@
-old
+new
*** Update File: .humanlayer/tasks/core-1025-task/research.md
@@
-draft
+updated
*** Update File: .humanlayer/tasks/other-task/plan.md
@@
-old
+new
*** End Patch`,
		}

		expect(getTaskArtifactPathsFromApplyPatch(toolInput, cwd, taskSlug)).toEqual([
			'/repo/.humanlayer/tasks/core-1025-task/research.md',
		])
	})

	test('extracts add and update patch shapes seen in local conversation_events', () => {
		const cwd = '/repo'
		const addToolInput = {
			patch_text: `*** Begin Patch
*** Add File: .humanlayer/tasks/comments-test/poem.md
+At dawn the keys awake in rows,
+Soft thunder under careful hands;
*** End Patch`,
		}
		const updateToolInput = {
			patch_text: `*** Begin Patch
*** Update File: .humanlayer/tasks/comments-test/poem.md
@@
-The bugs are small, but bright and sly,
+The rough edges whisper, then recede,
*** End Patch`,
		}

		expect(getTaskArtifactPathsFromApplyPatch(addToolInput, cwd, 'comments-test')).toEqual([
			'/repo/.humanlayer/tasks/comments-test/poem.md',
		])
		expect(getTaskArtifactPathsFromApplyPatch(updateToolInput, cwd, 'comments-test')).toEqual([
			'/repo/.humanlayer/tasks/comments-test/poem.md',
		])
	})

	test('uses move destination for renamed artifact files', () => {
		const cwd = '/repo'
		const taskSlug = 'core-1025-task'
		const toolInput = {
			patch_text: `*** Begin Patch
*** Update File: .humanlayer/tasks/core-1025-task/old-plan.md
*** Move to: .humanlayer/tasks/core-1025-task/new-plan.md
@@
-old
+new
*** End Patch`,
		}

		expect(getTaskArtifactPathsFromApplyPatch(toolInput, cwd, taskSlug)).toEqual([
			'/repo/.humanlayer/tasks/core-1025-task/new-plan.md',
		])
	})

	test('excludes files in the task trash root', () => {
		const cwd = '/repo'
		const taskSlug = 'core-1025-task'
		const toolInput = {
			patch_text: `*** Begin Patch
*** Update File: .humanlayer/tasks/core-1025-task/.trash/plan.md
@@
-old
+new
*** End Patch`,
		}

		expect(getTaskArtifactPathsFromApplyPatch(toolInput, cwd, taskSlug)).toEqual([])
	})
})

describe('scanTaskArtifactDirectory', () => {
	test('skips the task trash root but keeps nested user-owned trash directories', async () => {
		const cwd = await createUniqueTempDir('artifact-scan-trash-test')
		const taskSlug = 'scan-task'
		const taskDir = join(cwd, '.humanlayer', 'tasks', taskSlug)
		try {
			await mkdir(join(taskDir, '.trash'), { recursive: true })
			await mkdir(join(taskDir, 'research', '.trash'), { recursive: true })
			await writeFile(join(taskDir, 'plan.md'), '# Plan')
			await writeFile(join(taskDir, '.trash', 'deleted.md'), '# Deleted')
			await writeFile(join(taskDir, 'research', '.trash', 'notes.md'), '# Notes')

			const paths = await scanTaskArtifactDirectory(cwd, taskSlug)

			expect(paths.sort()).toEqual(
				[join(taskDir, 'plan.md'), join(taskDir, 'research', '.trash', 'notes.md')].sort(),
			)
		} finally {
			await rm(cwd, { recursive: true, force: true })
		}
	})
})

describe('parseArtifactFrontmatter', () => {
	test('returns the frontmatter data', () => {
		expect(parseArtifactFrontmatter('---\ntype: plan\nstatus: draft\n---\n# Plan')).toEqual({
			type: 'plan',
			status: 'draft',
		})
	})

	test('returns {} for content without frontmatter or with broken YAML', () => {
		expect(parseArtifactFrontmatter('# Plan')).toEqual({})
		expect(parseArtifactFrontmatter('---\ntype: [unclosed\n---\n# Plan')).toEqual({})
	})

	test("does not keep the parsed document in gray-matter's process-wide cache", () => {
		const content = `---\ntype: research\n---\n# ${'large document '.repeat(1000)}`

		parseArtifactFrontmatter(content)

		// gray-matter's types leave out the process-wide cache it keeps on the function.
		const { cache } = matter as unknown as { cache: Record<string, unknown> }
		expect(Object.hasOwn(cache, content)).toBe(false)
	})
})

describe('findUnchangedTextRead', () => {
	const syncManagerWith = (contentHash: string) =>
		({
			upsertArtifact: async () => ({ artifactId: 'unused' }),
			uploadS3Artifact: async () => ({ artifactId: 'unused' }),
			getCollection: () => ({ toArray: [{ file_name: 'doc.md', content_hash: contentHash, id: 'artifact-1' }] }),
		}) as any

	test('skips the upsert for unchanged content', () => {
		const ledger = createArtifactSyncLedger()
		expect(findUnchangedTextRead(syncManagerWith('h1'), ledger, 'doc.md', 'h1', false)).toEqual({
			artifactId: 'artifact-1',
		})
		expect(findUnchangedTextRead(syncManagerWith('h1'), ledger, 'doc.md', 'h2', false)).toBeUndefined()
	})

	test('needs the design answer for this exact content before skipping a design doc', () => {
		const ledger = createArtifactSyncLedger()
		const manager = syncManagerWith('h1')
		expect(findUnchangedTextRead(manager, ledger, 'doc.md', 'h1', true)).toBeUndefined()

		rememberDesignQuestions(ledger, {
			artifactId: 'artifact-1',
			cloudUrl: undefined,
			fileName: 'doc.md',
			documentType: 'design-discussion',
			designQuestionsResolved: false,
			contentHash: 'h1',
		})
		expect(findUnchangedTextRead(manager, ledger, 'doc.md', 'h1', true)).toEqual({
			artifactId: 'artifact-1',
			designQuestionsResolved: false,
		})

		rememberDesignQuestions(ledger, {
			artifactId: 'artifact-1',
			cloudUrl: undefined,
			fileName: 'doc.md',
			documentType: 'design-discussion',
			designQuestionsResolved: true,
			contentHash: 'h0',
		})
		expect(findUnchangedTextRead(manager, ledger, 'doc.md', 'h1', true)).toBeUndefined()
	})
})
