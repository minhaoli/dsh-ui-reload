/**
 * dsh-ui-reload — host half.
 *
 * Two jobs, both about things only this side can see.
 *
 * 1. Readiness. The browser half does not decide on its own whether a reload is safe: a build
 *    writes a bundle file while the page is being reloaded, and those bytes launch an app that
 *    reports "an entry did not activate" and stays dead until the process restarts. This side owns
 *    the files and the module registry, so it answers for them.
 * 2. A log line. The renderer has no filesystem, so anything the browser half needs to explain
 *    afterwards (why a press was held, whether its keyboard command registered) is written here.
 */
import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'

/** Cordis plugin name. */
export const name = 'ui-reload'

/** Readiness route the browser half calls before entering a new document. */
const ROUTE = '/dsh-ui-reload/ready'

/** Appends one line to this plugin's own log; the browser half has nowhere else to say it. */
const LOG_ROUTE = '/dsh-ui-reload/log'

/** Replaces every host plugin whose loaded files changed on disk; the page asks before it reloads. */
const PLUGINS_ROUTE = '/dsh-ui-reload/plugins'

/** Where both halves' notes land: one file, next to the profile, easy to find again. */
const LOG_PATH = () => join(homedir(), '.dsh', 'ui-reload.log')

/**
 * Bundles above this size are not compiled here. A bundle that large is a build output nobody
 * edits by hand, and compiling tens of megabytes on every press would cost more than it explains.
 */
const MAX_COMPILE_BYTES = 4 * 1024 * 1024

/** Whether these bytes are a complete script, without running a single statement of them. */
function isCompleteScript(body) {
	try {
		new Script(body, { filename: 'plugin-bundle' }) // ui-copy-ignore
		return true
	} catch {
		return false
	}
}

/** One line in the plugin log; a log that cannot be written must never change the answer. */
function writeLog(line) {
	try {
		appendFileSync(LOG_PATH(), `${new Date().toISOString()} ${line}\n`)
	} catch {
		/* nothing to do about it here */
	}
}

/** Answer one request with JSON; a body that cannot be sent must not reject the handler. */
function sendJson(res, status, payload) {
	try {
		const body = JSON.stringify(payload)
		res.writeHead(status, {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			'content-length': Buffer.byteLength(body),
		})
		res.end(body)
	} catch {
		try {
			res.end()
		} catch {
			/* the socket is already gone */
		}
	}
}

/** Read one small JSON body; anything unreadable answers null instead of hanging. */
function readBody(req) {
	return new Promise((resolve) => {
		let size = 0
		let done = false
		const finish = (value) => {
			if (done === true) return
			done = true
			resolve(value)
		}
		const parts = []
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > 1_000_000) {
				finish(null)
				return
			}
			parts.push(chunk)
		})
		req.on('end', () => {
			try {
				finish(JSON.parse(Buffer.concat(parts).toString('utf8')))
			} catch {
				finish(null)
			}
		})
		req.on('error', () => finish(null))
	})
}

/**
 * The bytes the host would actually serve for this bundle address.
 *
 * The registry caches the body it read when it published a revision, and a read that raced a
 * writer can hold a file that no longer matches the disk. The page loads those cached bytes, not
 * the file, so a check against the disk alone would pass a bundle the page cannot execute.
 * @returns the served body, or null when it cannot be read.
 */
async function servedBody(clientModules, url) {
	try {
		if (typeof clientModules.fetchBundle !== 'function') return null
		const response = await clientModules.fetchBundle({
			method: 'GET',
			url,
			headers: { get: () => undefined },
		})
		if (response === null || response === undefined) return null
		if (response.status !== undefined && response.status !== 200) return null
		const body = await response.text()
		return typeof body === 'string' ? body : null
	} catch {
		return null
	}
}

/**
 * Check one graph row: does its bundle exist, and are the bytes the host serves a complete script.
 * @returns {{ ok: boolean, why?: string }}
 */
async function checkRow(clientModules, row) {
	const id = typeof row?.id === 'string' ? row.id : ''
	const url = typeof row?.url === 'string' ? row.url : ''
	const bundlePath = id === '' ? undefined : clientModules.clientPath(id)
	if (typeof bundlePath !== 'string' || bundlePath === '') return { ok: true }
	let size = 0
	/** Age of the file on disk: a bundle written a moment ago may still be growing. */
	let ageMs = -1
	try {
		const stats = statSync(bundlePath)
		size = stats.size
		ageMs = Date.now() - stats.mtimeMs
	} catch {
		return { ok: false, why: 'missing', ageMs }
	}
	const body = url === '' ? null : await servedBody(clientModules, url)
	const source = body ?? (size > MAX_COMPILE_BYTES ? null : readFileSync(bundlePath, 'utf8'))
	if (source === null) return { ok: true, ageMs }
	if (source.length > MAX_COMPILE_BYTES) return { ok: true, ageMs }
	if (isCompleteScript(source) === false) {
		return { ok: false, why: body === null ? 'incomplete-on-disk' : 'incomplete-as-served', ageMs }
	}
	return { ok: true, ageMs }
}

/**
 * Replace every host plugin whose loaded files changed on disk. This is the operation the Plugin
 * Manager performs: the registry compares each loaded module with the file it came from, evicts the
 * stale ones, stops the entries running them and restarts those entries from the current files. It
 * is what lets a change under `lib/index.js` or `host/*.js` take effect without restarting the app.
 * @param ctx - the host context, which carries the module registry as the `hmr` service.
 * @returns a report for the page; a failure is reported, never thrown.
 */
async function reloadHostPlugins(ctx) {
	const hmr = typeof ctx?.get === 'function' ? ctx.get('hmr') : undefined
	if (typeof hmr?.runExclusive !== 'function' || typeof hmr?.reconcileProfile !== 'function') {
		return { status: 'unsupported', detail: 'this host has no hmr service' }
	}
	const startedAt = Date.now()
	try {
		const result = await hmr.runExclusive(() => hmr.reconcileProfile([]))
		return {
			status: 'done',
			elapsedMs: Date.now() - startedAt,
			pending: Array.isArray(result?.pending) ? result.pending.length : 0,
			warnings: Array.isArray(result?.warnings) ? result.warnings.length : 0,
			restartReason: typeof result?.restartReason === 'string' ? result.restartReason : '',
		}
	} catch (error) {
		return { status: 'failed', detail: String(error?.message ?? error) }
	}
}

/**
 * Mount every route.
 * @param ctx - cordis context carrying the web server and the client module registry.
 */
export function apply(ctx) {
	ctx.inject(['webServer'], (inner) => {
		inner.effect(
			() =>
				inner.webServer.register({
					kind: 'exact',
					path: LOG_ROUTE,
					handler: async (req, res) => {
						try {
							if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') return sendJson(res, 405, { status: 'method' })
							const body = await readBody(req)
							const line = body !== null && typeof body === 'object' && typeof body.line === 'string' ? body.line.slice(0, 2000) : ''
							if (line !== '') writeLog(`[page] ${line}`)
							sendJson(res, 200, { status: 'done' })
						} catch (error) {
							sendJson(res, 500, { status: 'error', detail: String(error?.message ?? error) })
						}
					},
				}),
			'ui-reload: page log route',
		)
	})

	ctx.inject(['webServer'], (inner) => {
		inner.effect(
			() =>
				inner.webServer.register({
					kind: 'exact',
					path: PLUGINS_ROUTE,
					handler: async (req, res) => {
						try {
							if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') return sendJson(res, 405, { status: 'method' })
							const report = await reloadHostPlugins(ctx)
							writeLog(`host reload: ${report.status}${report.detail === undefined ? '' : ` (${report.detail})`}`)
							sendJson(res, 200, report)
						} catch (error) {
							sendJson(res, 500, { status: 'error', detail: String(error?.message ?? error) })
						}
					},
				}),
			'ui-reload: host plugin reload route',
		)
	})

	ctx.inject(['webServer', 'clientModules'], (inner) => {
		inner.effect(
			() =>
				inner.webServer.register({
					kind: 'exact',
					path: ROUTE,
					handler: async (req, res) => {
						try {
							if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
								return sendJson(res, 405, { status: 'method' })
							}
							const asked = await readBody(req)
							const known = asked !== null && typeof asked === 'object' && asked.known !== null && typeof asked.known === 'object' ? asked.known : {}
							const graph = inner.clientModules.graph()
							const rows = Array.isArray(graph?.entries) ? graph.entries : []
							const broken = []
							const urls = []
							let checked = 0
							let youngestMs = -1
							for (const row of rows) {
								if (typeof row?.url === 'string' && row.url !== '') urls.push(row.url)
								const id = typeof row?.id === 'string' ? row.id : ''
								// An unchanged revision was verified by the page that booted it.
								if (id !== '' && known[id] === row?.rev) continue
								checked += 1
								const verdict = await checkRow(inner.clientModules, row)
								if (typeof verdict.ageMs === 'number' && verdict.ageMs >= 0 && (youngestMs < 0 || verdict.ageMs < youngestMs)) youngestMs = verdict.ageMs
								if (verdict.ok !== true) broken.push({ id, why: verdict.why })
							}
							if (broken.length > 0) {
								const reason = broken.map((b) => `${b.id}:${b.why}`).join(', ')
								writeLog(`held: ${reason}`)
								inner.logger?.warn?.(`ui-reload: a reload was held back; unreadable plugin bundles: ${reason}`)
							}
							sendJson(res, 200, {
								status: 'done',
								rev: typeof graph?.rev === 'string' ? graph.rev : '',
								rows: rows.length,
								checked,
								broken,
								urls,
								quietMs: youngestMs,
							})
						} catch (error) {
							writeLog(`readiness failed: ${String(error?.message ?? error)}`)
							sendJson(res, 500, { status: 'error', detail: String(error?.message ?? error) })
						}
					},
				}),
			'ui-reload: readiness route',
		)
	})
}
