/**
 * dsh-ui-reload — a "reload the whole frontend" button.
 *
 * Contributes one button to the conversation session header, immediately left
 * of the share button (`conversation.session.header.utilities`, whose own
 * entry orders at -10). Clicking it reloads the entire page, which is the one
 * operation that reliably picks up anything the frontend can be out of sync
 * with: client plugin bundles rebuilt under the running page, plugin list
 * changes, stale CSS, and the shell's own code.
 *
 * This is deliberately a plain page reload rather than a per-plugin HMR sweep.
 * DSH already ships `dsh-client-hmr`, which republishes a plugin the moment its
 * bundle changes; the button exists for the residue that path cannot reach —
 * a page whose shell or bootstrap predates a change, or state that only a real
 * load clears. Reloading the document is the only thing that covers all of it.
 *
 * Effects the user should expect: conversation, workspace and connection state
 * live on the host, so they survive; anything held only in the page (scroll
 * position, open panels, in-flight composer text, running client-side timers)
 * does not.
 */
window.__ModuleLoader__.load({
	id: "dsh-ui-reload",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const { createElement, useCallback, useEffect, useState } = require("react");

		/** Cordis plugin name. */
		const name = "ui-reload";

		/** Required service: the slot registry the button registers into. */
		const inject = ["slots", "shortcuts"];

		/** How long the click acknowledgement stays visible before the load takes over. */
		const MESSAGE_MS = 400;
		/** How long one readiness check waits before the graph is read again. */
		const SETTLE_MS = 600;
		/** How many readiness checks one press may take before it stops instead of booting a failure. */
		const ATTEMPTS = 8;
		/** A bundle this young may still be growing, so its compiled bytes are not the ones that will load. */
		const QUIET_MS = 700;
		/** How long one host plugin reload may take before the press stops waiting for it. */
		const HOST_RELOAD_TIMEOUT_MS = 20000;
		/** How many of one round's addresses may be asked at once: a round asks a handful, one at a time is slow. */
		const HEAD_CONCURRENCY = 8;
		/** How long one address may take to answer before it counts as not served. */
		const HEAD_TIMEOUT_MS = 5000;
		/** How many times one press may ask the host for fresh addresses before it gives up instead of entering a page that cannot start. */
		const GATE_ROUNDS = 8;
		/** How long a round that found a missing address waits before the host is asked again. */
		const GATE_RETRY_MS = 600;

		/** One document address this press has not entered yet: a new query makes the shell render it again. */
		function freshDocumentUrl() {
			const url = new URL(window.location.href);
			url.searchParams.set("dsh-ui-reload", Date.now().toString(36));
			return url.toString();
		}

		/**
		 * Whether the running host still serves this exact bundle revision.
		 * @param timeoutMs - how long to wait before counting an address that never answers as not
		 * served. Omitted by the readiness check, which must not turn a slow host into a refusal.
		 */
		async function serves(url, timeoutMs) {
			try {
				const response = await fetch(url, {
					method: "HEAD",
					cache: "no-store",
					credentials: "same-origin",
					signal: timeoutMs > 0 && typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined,
				});
				// 405 says the route took the request and only refuses HEAD, not that the revision is gone.
				if (response.status === 405) return true;
				return response.ok;
			} catch {
				return false;
			}
		}

		/**
		 * One line for this plugin's own log. The renderer has no filesystem, so the line goes to
		 * the host half, which appends it where a later reader can find it once the console is gone.
		 */
		function note(line) {
			try {
				void fetch("/dsh-ui-reload/log", {
					method: "POST", // ui-copy-ignore
					cache: "no-store",
					credentials: "same-origin",
					headers: { "content-type": "application/json" }, // ui-copy-ignore
					body: JSON.stringify({ line: String(line) }),
				}).catch(() => {});
			} catch {
				/* a note that cannot be sent costs nothing */
			}
		}


		/**
		 * Ask the host half to replace every host plugin whose files changed on disk. A plugin's own code
		 * lives beside its client bundle, and only the host can replace a module it already occupies, so a
		 * document reload can never reach it.
		 * @returns the host's report, or a local one when the host could not be asked at all.
		 */
		async function reloadHostPlugins() {
			try {
				const response = await fetch("/dsh-ui-reload/plugins", {
					method: "POST", // ui-copy-ignore
					cache: "no-store",
					credentials: "same-origin",
					headers: { "content-type": "application/json" }, // ui-copy-ignore
					body: "{}",
					signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(HOST_RELOAD_TIMEOUT_MS) : undefined,
				});
				if (response?.ok !== true) return { status: "unavailable", detail: "http " + String(response?.status ?? "?") };
				const data = await response.json();
				return data !== null && typeof data === "object" ? data : { status: "unavailable", detail: "empty answer" };
			} catch (error) {
				return { status: "unavailable", detail: String(error?.message ?? error) };
			}
		}
		/** One press at a time: the registered command and the raw key must not both fire. */
		let lastPressAt = 0;

		/** Run one press, unless the previous one started inside the cooldown. */
		function pressOnce(source) {
			const now = Date.now();
			if (now - lastPressAt < 1200) return;
			lastPressAt = now;
			note("press from " + source);
			void pressReload(() => {});
		}

		/** The keyboard command id, also the id the settings list shows. */
		const SHORTCUT_ID = "ui-reload.reload";

		/**
		 * The press itself, wherever it came from: the header button or the keyboard command.
		 * @param notify - receives "busy" when the press starts and "stuck" when it stops without
		 * entering a new document.
		 */
		async function pressReload(notify) {
			notify("busy");
			// Host plugins first: their own code never reaches the page, and a restarted plugin can move
			// the client graph the document is about to load. Then the document itself, which is what
			// picks up the client bundles.
			const host = await reloadHostPlugins();
			note(
				"press: host=" +
					host.status +
					(host.detail === undefined ? "" : " " + host.detail) +
					(host.restartReason ? " restart=" + host.restartReason : "") +
					(typeof host.pending === "number" && host.pending > 0 ? " pending=" + host.pending : ""),
			);
			const state = await readiness();
			note("press: readiness=" + state);
			if (state === "ready") {
				// The host's answer covers the graph it reads; the document covers the addresses it
				// names. Entering a document whose batches are gone is the one way to land on
				// "an entry did not activate" with no way back except restarting the process, so a
				// document that cannot start is not entered at all.
				const gate = await docGate();
				note("press: doc gate=" + gate.verdict);
				if (gate.verdict === "missing") {
					notify("stuck");
					console.warn(
						"dsh-ui-reload: the next document asks for an address this host does not serve (" +
							gate.address +
							"); staying on this page.",
					);
					return;
				}
				window.location.replace(freshDocumentUrl());
				return;
			}
			// No answer from this plugin's host half is not evidence about the graph: keep the
			// acknowledgement-then-reload behaviour rather than leaving the press doing nothing.
			if (state === "blind") {
				setTimeout(() => {
					window.location.reload();
				}, MESSAGE_MS);
				return;
			}
			notify("stuck");
			console.warn("dsh-ui-reload: plugin bundles are not ready yet; press again shortly.");
		}

/** Revisions the running page booted from, so the host side can skip rows it already proved. */
		function bootedRevisions() {
			const known = {};
			const entries = window.__DSH_BOOT__?.entries;
			if (!Array.isArray(entries)) return known;
			for (const entry of entries) {
				if (typeof entry?.id === "string" && typeof entry?.rev === "string") known[entry.id] = entry.rev;
			}
			return known;
		}

		/**
		 * Ask this plugin's host half whether the bundles a new document would load are readable
		 * right now. The page cannot answer that itself: a build writes a bundle file while the page
		 * is being reloaded, and those bytes launch an app that reports "an entry did not activate"
		 * and stays dead until the process restarts.
		 * @returns the host's verdict, or null when the host half is not answering.
		 */
		async function askHostReadiness() {
			try {
				const response = await fetch("/dsh-ui-reload/ready", {
					method: "POST", // ui-copy-ignore
					cache: "no-store",
					credentials: "same-origin",
					headers: { "content-type": "application/json" }, // ui-copy-ignore
					body: JSON.stringify({ known: bootedRevisions() }),
				});
				if (response?.ok !== true) return null;
				const data = await response.json();
				return data !== null && typeof data === "object" ? data : null;
			} catch {
				return null;
			}
		}

		/**
		 * Whether this press may enter a new document.
		 * @returns "ready" when every bundle the next document needs answers, "blind" when the host
		 * half could not be asked at all, or "stuck" when it kept refusing.
		 */
		async function readiness() {
			let answered = false;
			let settledRev = null;
			for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
				if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
				const verdict = await askHostReadiness();
				if (verdict === null) continue;
				answered = true;
				const broken = Array.isArray(verdict.broken) ? verdict.broken : [];
				if (broken.length > 0) continue;
				const urls = Array.isArray(verdict.urls) ? verdict.urls.filter((url) => typeof url === "string" && url !== "") : [];
				const served = await Promise.all(urls.map((url) => serves(url)));
				if (!served.every((ok) => ok === true)) {
					settledRev = null;
					continue;
				}
				// A bundle written a moment ago may still be growing: the bytes that compiled here are not
				// necessarily the bytes that will launch the next document.
				const quiet = typeof verdict.quietMs === "number" ? verdict.quietMs : -1;
				if (quiet >= 0 && quiet < QUIET_MS) {
					settledRev = null;
					continue;
				}
				// A build can bump the graph again between the document being rendered and its scripts
				// being fetched, which is a race no single check closes. Two readings that agree mean the
				// graph stopped moving, so the document the press enters is still current when it loads.
				const rev = typeof verdict.rev === "string" ? verdict.rev : "";
				if (settledRev !== null && rev === settledRev) return "ready";
				settledRev = rev;
			}
			return answered ? "stuck" : "blind";
		}

		/**
		 * The boot graph a document injects about itself, cut out of its own text.
		 *
		 * The document carries one global injection whose value is `JSON.stringify(graph)`, and a
		 * graph nests entries, batches and per-entry metadata several levels deep, so no regular
		 * expression can find where its value ends. The close is found by counting braces, with
		 * strings skipped so a brace inside a title or an address does not move the count.
		 * @returns the parsed graph, or null when this document carries none.
		 */
		function readBootGraph(text) {
			const marker = text.indexOf("__DSH_BOOT__");
			if (marker < 0) return null;
			const start = text.indexOf("{", marker);
			if (start < 0) return null;
			let depth = 0;
			let quoted = false;
			let escaped = false;
			for (let at = start; at < text.length; at += 1) {
				const ch = text[at];
				if (quoted) {
					if (escaped) escaped = false;
					else if (ch === "\\") escaped = true;
					else if (ch === '"') quoted = false;
					continue;
				}
				if (ch === '"') {
					quoted = true;
					continue;
				}
				if (ch === "{") {
					depth += 1;
					continue;
				}
				if (ch !== "}") continue;
				depth -= 1;
				if (depth > 0) continue;
				try {
					return JSON.parse(text.slice(start, at + 1));
				} catch {
					return null;
				}
			}
			return null;
		}

		/**
		 * Every address the document's boot graph asks it to load.
		 *
		 * `entries` are the per-plugin modules and `batches` are the concatenated scripts the page
		 * actually executes — three of them here, the largest measured at 35 MB — so asking only
		 * about the module addresses would pass a page whose batch is already gone. The addresses
		 * are relative to the document that names them, so they resolve against the address that
		 * was read, not against the page this press was pressed on.
		 * @returns the addresses without repeats; `label` is the relative form the log shows.
		 */
		function graphAddresses(graph, base) {
			const found = new Map();
			const collect = (list) => {
				if (!Array.isArray(list)) return;
				for (const item of list) {
					const url = item?.url;
					if (typeof url !== "string" || url === "") continue;
					let href;
					try {
						href = new URL(url, base).href;
					} catch {
						continue; // an address that will not resolve is not one that can be asked about
					}
					if (!found.has(href)) found.set(href, { href, label: url });
				}
			};
			collect(graph?.entries);
			collect(graph?.batches);
			return [...found.values()];
		}

		/**
		 * Which of these addresses did not answer.
		 *
		 * The first group that fails ends the round: while the host is rebuilding, asking the
		 * remaining addresses again on every round only adds load to the thing that is already
		 * struggling, and the first address is the one worth naming.
		 * @returns the failing addresses of that group, empty when every address answered.
		 */
		async function unanswered(addresses) {
			for (let at = 0; at < addresses.length; at += HEAD_CONCURRENCY) {
				const group = addresses.slice(at, at + HEAD_CONCURRENCY);
				const served = await Promise.all(group.map((address) => serves(address.href, HEAD_TIMEOUT_MS)));
				const failed = group.filter((_, index) => served[index] !== true);
				if (failed.length > 0) return failed;
			}
			return [];
		}

		/** One address, short enough to stay on one log line. */
		function brief(text) {
			return text.length > 80 ? text.slice(0, 79) + "…" : text;
		}

		/**
		 * Whether the document the press is about to enter can actually start.
		 *
		 * The host half proves the graph has settled, but it proves that about the graph the host
		 * reads, not about the addresses this document names: a revision that turns over between
		 * the two leaves the document pointing at files that are no longer served, and a page that
		 * enters it reports "an entry did not activate" and never starts. So the document is read
		 * back for the graph it injects, every address in that graph is asked for, and the press
		 * stays where it is until they all answer.
		 * @returns {{verdict: "ok" | "missing" | "unreadable", address?: string}} — "unreadable"
		 * means this document could not be read at all, and the press keeps its old behaviour.
		 */
		async function docGate() {
			let last = "";
			for (let round = 1; round <= GATE_ROUNDS; round += 1) {
				if (round > 1) await new Promise((resolve) => setTimeout(resolve, GATE_RETRY_MS));
				const address = freshDocumentUrl();
				let text;
				try {
					const response = await fetch(address, { cache: "no-store", credentials: "same-origin" });
					if (response?.ok !== true) return { verdict: "unreadable" };
					text = await response.text();
				} catch {
					return { verdict: "unreadable" };
				}
				if (typeof text !== "string" || text === "") return { verdict: "unreadable" };
				const graph = readBootGraph(text);
				if (graph === null) return { verdict: "unreadable" };
				const addresses = graphAddresses(graph, address);
				if (addresses.length === 0) return { verdict: "unreadable" };
				const failed = await unanswered(addresses);
				if (failed.length === 0) {
					note("doc gate: ok urls=" + addresses.length + " after=" + (round - 1));
					return { verdict: "ok" };
				}
				last = failed[0].label;
				note(
					"doc gate: round=" +
						round +
						" urls=" +
						addresses.length +
						" missing=" +
						failed.length +
						" first=" +
						brief(last),
				);
			}
			return { verdict: "missing", address: brief(last) };
		}

		/** Inject the keyframes once; a style tag beats threading a CSS file through the bundle. */
		function ensureKeyframes() {
			if (typeof document === "undefined") return;
			if (document.getElementById("dsh-ui-reload-keyframes") !== null) return;
			const style = document.createElement("style");
			style.id = "dsh-ui-reload-keyframes";
			style.textContent = "@keyframes dsh-ui-reload-spin{to{transform:rotate(360deg)}}";
			document.head.appendChild(style);
		}

		/** Inline glyph: a circular arrow, drawn so the button needs no icon dependency. */
		function ReloadGlyph({ size = 16, spinning = false }) {
			return createElement(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					"aria-hidden": "true",
					style: spinning ? { animation: "dsh-ui-reload-spin 0.9s linear infinite" } : undefined,
				},
				createElement("path", {
					d: "M13.5 8a5.5 5.5 0 1 1-1.61-3.89",
					stroke: "currentColor",
					strokeWidth: 1.5,
					strokeLinecap: "round",
				}),
				createElement("path", {
					d: "M13.5 1.5v3.2h-3.2",
					stroke: "currentColor",
					strokeWidth: 1.5,
					strokeLinecap: "round",
					strokeLinejoin: "round",
				}),
			);
		}

		/** The header button. */
		function ReloadButton() {
			const [busy, setBusy] = useState(false);
			const [stuck, setStuck] = useState(false);

			useEffect(() => {
				ensureKeyframes();
			}, []);

			const onClick = useCallback((event) => {
				event.stopPropagation();
				setStuck(false);
				void pressReload((state) => {
					if (state === "busy") {
						setBusy(true);
						return;
					}
					setBusy(false);
					setStuck(true);
				});
			}, []);

			const title = stuck ? "插件还没准备好，稍后再按一次" : "刷新整个前端（重新加载页面）";

			return createElement(
				"button",
				{
					type: "button",
					"data-dsh-ui-reload": "",
					"aria-label": "刷新整个前端",
					title,
					disabled: busy,
					onClick,
					style: {
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						width: "28px",
						height: "28px",
						padding: 0,
						border: "none",
						borderRadius: "6px",
						background: "transparent",
						color: "inherit",
						cursor: busy ? "progress" : "pointer",
						opacity: busy ? 0.6 : 1,
					},
				},
				createElement(ReloadGlyph, { spinning: busy }),
			);
		}

		/**
		 * Client plugin body.
		 *
		 * @param ctx - the client cordis context (slots).
		 */
		function apply(ctx) {
			ctx.slots.inject("conversation.session.header.utilities", () => {
				const disposeRegistration = ctx.slots.register(
					{
						name: "conversation.session.header.utilities",
						id: "ui-reload",
						// Share registers at -10; a smaller order places this button to its left.
						order: -20,
					},
					ReloadButton,
				);
				return () => disposeRegistration();
			});

			// F5 reaches the same press as the button. The application owns the keyboard: a bound
			// command is routed, rebindable and listed in the shortcuts settings, which a raw key
			// listener is none of.
			note("client loaded; shortcuts=" + typeof ctx.shortcuts + " effect=" + typeof ctx.effect);
			const registerCommand = () => {
				const dispose = ctx.shortcuts.register({
					id: SHORTCUT_ID,
					label: () => "刷新整个前端",
					aliases: ["reload frontend", "refresh interface"],
					// F5 is reserved by the application, so it cannot be a command default. The command ships
					// unbound: it is listed and rebindable in the shortcuts settings, while the raw key handler
					// installed below is what actually answers F5. An empty object is required: the registry
					// reads it per platform and a missing one throws.
					defaults: {},
					regions: ["page", "editable"],
					modals: [],
					resolve: () => ({
						status: "handled",
						run: () => pressOnce("command"),
					}),
				});
				return () => {
					if (typeof dispose === "function") dispose();
				};
			};
			try {
				if (typeof ctx.effect === "function") ctx.effect(registerCommand, "ui-reload: reload command");
				else registerCommand();
			} catch (error) {
				note("command registration failed: " + String(error?.message ?? error));
				console.warn("dsh-ui-reload: the keyboard command could not be registered", error);
			}

			// The registered command goes through the application's keyboard routing. F5 is also a
			// plain browser key, and a shell that routes it elsewhere would leave the press dead, so
			// the same press listens for it directly. The cooldown keeps the two from firing twice.
			const onKey = (event) => {
				if (event.key !== "F5" && event.code !== "F5") return;
				if (event.ctrlKey === true || event.metaKey === true || event.altKey === true || event.shiftKey === true) return;
				event.preventDefault();
				pressOnce("f5");
			};
			try {
				window.addEventListener("keydown", onKey, { capture: true });
				note("raw F5 listener installed");
			} catch (error) {
				note("raw F5 listener failed: " + String(error?.message ?? error));
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	},
});
