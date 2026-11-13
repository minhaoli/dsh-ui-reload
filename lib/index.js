/**
 * dsh-ui-reload — host half.
 *
 * Two jobs, both about things only this side can see.
 *
 * 1. Readiness. The browser half does not decide on its own whether a reload is safe: a build
 *    writes a bundle file while the page is being reloaded, and those bytes launch an app that
 *    reports "an entry did not activate" and stays dead until the process restarts. This side owns
 *    the files and the module registry, so it answers for them — by compiling the bytes the host
 *    would actually serve, and by republishing any entry whose cached generation does not compile.
 *
 *    The object it compiles is the **combo batch**, not the individual plugin bundle: the document
 *    never requests a plugin's own address, it requests the few batches the registry concatenates
 *    out of them. Two different resources, and only the second one is what can fail to parse.
 * 2. A log line. The renderer has no filesystem, so anything the browser half needs to explain
 *    afterwards (why a press was held, whether its keyboard command registered) is written here.
 */
import { appendFileSync, readFileSync, statSync, utimesSync } from 'node:fs'
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
 * Largest batch this side will compile.
 *
 * The page does not load each plugin bundle: it loads the combo batches the registry concatenates
 * out of them, and the biggest one measured on a 106-entry profile is 33.67 MB (48 entries).
 * Compiling that costs about 340 ms once and roughly 150 MB of heap while the parse is live, so it
 * is kept out of the per-press path by the revision memo below rather than by refusing to look.
 *
 * The previous 4 MB limit silently passed two of the three batches, which is the hole this version
 * closes: a batch that cannot be compiled is now held with `batch-too-large`, never waved through —
 * an unverified batch is not a promise.
 */
const MAX_COMPILE_BYTES = 64 * 1024 * 1024

/**
 * Batch revisions whose bytes have already compiled clean, oldest first.
 *
 * A batch revision is a hash over the ordered `(id, rev)` list the combo was built from, and the
 * registry serves one body per published revision — so a revision that compiled once cannot come
 * back carrying different bytes. Failures are never remembered: bytes that did not parse are
 * exactly the case that must be recompiled after a republish.
 *
 * This is deliberately not the per-row skip that 0.3.1 removed. That one trusted a row revision to
 * say something about a body the page would load from a *different* address; this one keys on the
 * address the page actually fetches.
 */
const compiledBatches = new Map()

/** How many clean batch revisions to remember; one press only ever needs the current graph's. */
const COMPILED_BATCHES_MAX = 8

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

/** Whether a bundle this size can be compiled here at all. */
function compilable(bytes) {
	return bytes <= MAX_COMPILE_BYTES
}

/**
 * Compile-check the bytes the host would actually deliver.
 *
 * A body that cannot be obtained is a failure, never an invitation to read the disk instead: the
 * page executes the registry's bytes, and a disk that looks fine says nothing about what it serves.
 * @returns { ok: boolean, why?: string }
 */
async function verifyServed(clientModules, url) {
	const body = url === '' ? null : await servedBody(clientModules, url)
	if (body === null) return { ok: false, why: 'served-unavailable' }
	if (compilable(body.length) === false) return { ok: true }
	return isCompleteScript(body) === true ? { ok: true } : { ok: false, why: 'incomplete-as-served' }
}

/** Remember one batch revision as having compiled clean, keeping the map most-recent-last. */
function rememberBatch(rev) {
	if (rev === '') return
	compiledBatches.delete(rev)
	compiledBatches.set(rev, true)
	while (compiledBatches.size > COMPILED_BATCHES_MAX) {
		const oldest = compiledBatches.keys().next()
		if (oldest.done === true) break
		compiledBatches.delete(oldest.value)
	}
}

/**
 * Compile-check one combo batch — the script the document actually parses when it boots.
 *
 * This is the object a press has to answer for, and it is not the same object as a plugin bundle.
 * The registry publishes each bundle at its own address, but the document never requests those:
 * `bootInjections` puts one `<script src>` (bootstrap) or `<link rel=preload>` (application) per
 * batch into the page, and a batch is built by concatenating its member bundles and terminating
 * each with `;\n`. Concatenation can fail where every member parses alone — a transformer that is
 * fine in one file and not in the stream — so a per-row check says nothing about what runs.
 * @param batch - one `graph.batches[]` entry (`phase`, `rev`, `url`, `entries`).
 * @returns { ok: boolean, phase: string, rev: string, entries: string[], why?: string, bytes?: number }
 */
async function verifyBatch(clientModules, batch) {
	const phase = typeof batch?.phase === 'string' ? batch.phase : ''
	const rev = typeof batch?.rev === 'string' ? batch.rev : ''
	const url = typeof batch?.url === 'string' ? batch.url : ''
	const entries = Array.isArray(batch?.entries) ? batch.entries : []
	const label = { phase, rev, entries }
	if (rev !== '' && compiledBatches.has(rev) === true) {
		rememberBatch(rev)
		return { ok: true, ...label }
	}
	const body = url === '' ? null : await servedBody(clientModules, url)
	if (body === null) return { ok: false, ...label, why: 'served-unavailable' }
	const bytes = Buffer.byteLength(body)
	if (compilable(bytes) === false) return { ok: false, ...label, why: 'batch-too-large', bytes }
	if (isCompleteScript(body) === false) return { ok: false, ...label, why: 'incomplete-as-served', bytes }
	rememberBatch(rev)
	return { ok: true, ...label, bytes }
}

/** Compile-check every batch the document would load, in graph order. */
async function verifyBatches(clientModules, batches) {
	const verdicts = []
	for (const batch of batches) verdicts.push(await verifyBatch(clientModules, batch))
	return verdicts
}

/**
 * Compile-check the file on disk, to name the failure the served bytes just showed.
 *
 * A readable, complete script here next to unservable bytes is the interesting case: the cache is
 * serving something the file no longer is. This verdict never turns a served failure into a pass.
 * @returns { ok: boolean, why?: string }
 */
function verifyDisk(bundlePath) {
	let source
	try {
		source = readFileSync(bundlePath, 'utf8')
	} catch {
		return { ok: false, why: 'unreadable-on-disk' }
	}
	if (compilable(source.length) === false) return { ok: true }
	return isCompleteScript(source) === true ? { ok: true } : { ok: false, why: 'incomplete-on-disk' }
}

/** The bundle address the host advertises for one id right now, or '' when the id is unknown. */
function servedUrlFor(clientModules, id) {
	try {
		const rows = clientModules.graph()?.entries
		if (Array.isArray(rows) === false) return ''
		const row = rows.find((entry) => entry?.id === id)
		return typeof row?.url === 'string' ? row.url : ''
	} catch {
		return ''
	}
}

/**
 * Force the registry to read one bundle again, because a cached generation has no other way out.
 *
 * The registry keys a revision on mtime, ctime and size and will not re-read while that key still
 * matches, so a body captured mid-write stays frozen while its revision already describes the
 * finished file: the watch calls in, sees nothing to do, and the page keeps loading torn bytes.
 * Moving the mtime changes that key and nothing else — the bytes are never rewritten — and the
 * re-publication that follows re-reads the file and gives the entry a new address.
 * @returns { ok: boolean, rev: string, why?: string }
 */
async function republish(clientModules, id, bundlePath) {
	if (typeof clientModules?.rebuilt !== 'function') return { ok: false, rev: '', why: 'unrepairable' }
	let rev = ''
	try {
		const now = new Date()
		utimesSync(bundlePath, now, now) // ui-copy-ignore: the timestamp, never the contents
		rev = clientModules.rebuilt(id)
	} catch (error) {
		writeLog(`republish failed: ${id}: ${String(error?.message ?? error)}`)
		return { ok: false, rev: '', why: 'republish-failed' }
	}
	if (typeof rev !== 'string' || rev === '') return { ok: false, rev: '', why: 'republish-failed' }
	const verdict = await verifyServed(clientModules, servedUrlFor(clientModules, id))
	return verdict.ok === true ? { ok: true, rev } : { ok: false, rev, why: verdict.why }
}

/**
 * Check one graph row, to name and fix the broken member of a failed batch.
 *
 * This is no longer the gate — a batch is (see `verifyBatch`), because that is what the page
 * parses. A row is checked when its batch already failed, both to find which plugin is responsible
 * and to republish it so the combo can be rebuilt from clean bytes.
 * @returns {{ ok: boolean, why?: string, ageMs: number, republished?: string }}
 */
async function checkRow(clientModules, row) {
	const id = typeof row?.id === 'string' ? row.id : ''
	const url = typeof row?.url === 'string' ? row.url : ''
	let bundlePath
	try {
		bundlePath = id === '' ? undefined : clientModules.clientPath(id)
	} catch {
		return { ok: false, why: 'unknown-id', ageMs: -1 }
	}
	if (typeof bundlePath !== 'string' || bundlePath === '') return { ok: true, ageMs: -1 }
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
	if (compilable(size) === false) return { ok: true, ageMs }

	const served = await verifyServed(clientModules, url)
	if (served.ok === true) return { ok: true, ageMs }

	const repaired = await republish(clientModules, id, bundlePath)
	if (repaired.ok === true) return { ok: true, ageMs, republished: repaired.rev }

	const disk = verifyDisk(bundlePath)
	if (served.why === 'served-unavailable') {
		// The file may be perfect; what cannot be confirmed is what the page would be handed.
		return { ok: false, why: disk.ok === true ? 'served-unavailable' : disk.why, ageMs, republished: repaired.rev }
	}
	return { ok: false, why: disk.ok === true ? served.why : disk.why, ageMs, republished: repaired.rev }
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
							await readBody(req) // drained; a page's own revision map no longer exempts a batch
							let graph = inner.clientModules.graph()
							const rows = Array.isArray(graph?.entries) ? graph.entries : []
							let batches = Array.isArray(graph?.batches) ? graph.batches : []
							const repaired = []

							// The quiet window: how long ago the youngest bundle behind this graph was
							// written. Stat only — the bytes are read below, and a file written a moment
							// ago may still be growing.
							let youngestMs = -1
							for (const row of rows) {
								const id = typeof row?.id === 'string' ? row.id : ''
								if (id === '') continue
								try {
									const ageMs = Date.now() - statSync(inner.clientModules.clientPath(id)).mtimeMs
									if (youngestMs < 0 || ageMs < youngestMs) youngestMs = ageMs
								} catch {
									/* a row whose file is gone is reported by the batch that carries it */
								}
							}

							// The gate: every batch the document will execute, as the host serves it.
							let verdicts = await verifyBatches(inner.clientModules, batches)

							if (verdicts.some((verdict) => verdict.ok !== true)) {
								// Republish the broken members so the combo can be rebuilt from clean files.
								for (const batch of verdicts) {
									if (batch.ok === true) continue
									for (const id of batch.entries) {
										const row = rows.find((entry) => entry?.id === id)
										if (row === undefined) continue
										const verdict = await checkRow(inner.clientModules, row)
										if (typeof verdict.republished === 'string' && verdict.republished !== '') {
											repaired.push({ id, rev: verdict.republished })
											writeLog(`republished: ${id} -> ${verdict.republished}`)
										}
									}
								}
								// A republished entry recomposes the combo, so the old batch address no
								// longer describes what the document would load: re-read the graph and
								// take the verdict again from the batches it now advertises.
								try {
									graph = inner.clientModules.graph()
								} catch {
									/* the graph did not move; the addresses just checked still stand */
								}
								batches = Array.isArray(graph?.batches) ? graph.batches : batches
								verdicts = await verifyBatches(inner.clientModules, batches)
							}

							const broken = []
							for (const verdict of verdicts) {
								if (verdict.ok === true) continue
								broken.push({ id: `batch:${verdict.phase}:${verdict.rev}`, why: verdict.why })
							}
							// A graph that advertises no batches is not one this half can answer for: the
							// document would still load a script, so refuse instead of passing it unlooked at.
							if (batches.length === 0) broken.push({ id: 'batch:none', why: 'no-batches' })
							if (broken.length > 0) {
								const reason = broken.map((b) => `${b.id}:${b.why}`).join(', ')
								writeLog(`held: ${reason}`)
								inner.logger?.warn?.(`ui-reload: a reload was held back; a batch does not compile: ${reason}`)
							}
							// The addresses the document fetches, so the browser half's HEAD gate confirms
							// the same objects this half just compiled.
							const urls = batches.map((batch) => (typeof batch?.url === 'string' ? batch.url : '')).filter((url) => url !== '')
							sendJson(res, 200, {
								status: 'done',
								rev: typeof graph?.rev === 'string' ? graph.rev : '',
								rows: rows.length,
								batches: batches.length,
								checked: verdicts.length,
								broken,
								repaired,
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
