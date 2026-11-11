import './instrument'
import 'zod/compile'
import { Server } from 'node:http'

import { serve } from '@hono/node-server'
import * as Sentry from '@sentry/node'

import { appRuntime } from './effects/app-runtime'

const PORT = Number(process.env.RIPTIDE_API_PORT ?? process.env.PORT) || 8700

async function main(): Promise<void> {
	try {
		await appRuntime.context()
	} catch (error) {
		Sentry.captureException(error, { tags: { error_type: 'riptide_api_runtime_startup' } })
		await appRuntime.dispose()
		throw error
	}

	const { app } = await import('./app')
	// HUMANLAYER_BIND_HOST=127.0.0.1 keeps a local stack off the network; unset listens on every interface.
	const server = serve({ fetch: app.fetch, port: PORT, hostname: process.env.HUMANLAYER_BIND_HOST || undefined })
	if (!(server instanceof Server)) {
		await appRuntime.dispose()
		throw new Error(`Expected http.Server but got ${server.constructor.name}`)
	}
	server.keepAliveTimeout = 0

	let shuttingDown = false
	const shutdown = async () => {
		if (shuttingDown) return
		shuttingDown = true
		let failed = false
		await new Promise<void>((resolve) => {
			server.close((error) => {
				if (error) {
					failed = true
					console.error(error)
				}
				resolve()
			})
		})
		await appRuntime.dispose()
		if (failed) process.exitCode = 1
	}

	process.on('SIGTERM', () => void shutdown())
	process.on('SIGINT', () => void shutdown())
}

void main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
