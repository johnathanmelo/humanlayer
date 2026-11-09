import { stat } from 'node:fs/promises'

/**
 * Per-session memory of which on-disk artifact state has already reached the
 * cloud, shared by every PostToolUse sync hook of that session. A fingerprint
 * is mtime plus size, cheap enough to check after every tool call.
 */
export interface ArtifactSyncLedger {
	record(fileName: string, fingerprint: string): void
	isCurrent(fileName: string, fingerprint: string): boolean
	/**
	 * Remember the design-question answer the cloud gave for this exact content of a file. The
	 * cloud only computes it during an upsert, and only for design sessions, so the memory must
	 * stay per session.
	 */
	recordDesignQuestions(fileName: string, contentHash: string, designQuestionsResolved: boolean | undefined): void
	/** The remembered answer for exactly this content, or undefined when the cloud has not given one. */
	designQuestionsFor(
		fileName: string,
		contentHash: string,
	): { designQuestionsResolved: boolean | undefined } | undefined
}

export function createArtifactSyncLedger(): ArtifactSyncLedger {
	const fingerprints = new Map<string, string>()
	const designQuestions = new Map<string, { contentHash: string; designQuestionsResolved: boolean | undefined }>()
	return {
		record: (fileName, fingerprint) => {
			fingerprints.set(fileName, fingerprint)
		},
		isCurrent: (fileName, fingerprint) => fingerprints.get(fileName) === fingerprint,
		recordDesignQuestions: (fileName, contentHash, designQuestionsResolved) => {
			designQuestions.set(fileName, { contentHash, designQuestionsResolved })
		},
		designQuestionsFor: (fileName, contentHash) => {
			const remembered = designQuestions.get(fileName)
			if (remembered?.contentHash !== contentHash) return undefined
			return { designQuestionsResolved: remembered.designQuestionsResolved }
		},
	}
}

export async function readFileFingerprint(filePath: string): Promise<string> {
	const fileStat = await stat(filePath)
	return `${fileStat.mtimeMs}:${fileStat.size}`
}

export async function recordSyncedFile(ledger: ArtifactSyncLedger, fileName: string, filePath: string): Promise<void> {
	const fingerprint = await readFileFingerprint(filePath).catch(() => null)
	if (fingerprint) ledger.record(fileName, fingerprint)
}
