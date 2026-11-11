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
		const inject = ["slots"];

		/** How long the click acknowledgement stays visible before the load takes over. */
		const MESSAGE_MS = 400;
		/** How long one document reading waits before the graph is read again. */
		const SETTLE_MS = 600;
		/** How many document readings one press may take before it stops instead of booting a failure. */
		const ATTEMPTS = 8;

		/** One document address this press has not entered yet: a new query makes the shell render it again. */
		function freshDocumentUrl() {
			const url = new URL(window.location.href);
			url.searchParams.set("dsh-ui-reload", Date.now().toString(36));
			return url.toString();
		}

		/**
		 * The boot graph a served document carries, read out of the injected global row.
		 * The value is JSON with `<` escaped, so the script element cannot end inside it.
		 * @param html - the served document body.
		 * @returns the graph, or null when the document carries none.
		 */
		function readBootGraph(html) {
			const marker = html.indexOf('globalThis["__DSH_BOOT__"]');
			if (marker < 0) return null;
			const start = html.indexOf("{", marker);
			if (start < 0) return null;
			let depth = 0;
			let inString = false;
			let escaped = false;
			for (let i = start; i < html.length; i += 1) {
				const ch = html[i];
				if (inString) {
					if (escaped) escaped = false;
					else if (ch === "\\") escaped = true;
					else if (ch === '"') inString = false;
					continue;
				}
				if (ch === '"') inString = true;
				else if (ch === "{") depth += 1;
				else if (ch === "}") {
					depth -= 1;
					if (depth === 0) {
						try {
							return JSON.parse(html.slice(start, i + 1));
						} catch {
							return null;
						}
					}
				}
			}
			return null;
		}

		/** Every script address the boot graph would load. */
		function bundleSources(graph) {
			const out = new Set();
			for (const batch of Array.isArray(graph?.batches) ? graph.batches : []) {
				if (typeof batch?.url === "string" && batch.url !== "") out.add(batch.url);
			}
			for (const entry of Array.isArray(graph?.entries) ? graph.entries : []) {
				if (typeof entry?.url === "string" && entry.url !== "") out.add(entry.url);
			}
			return [...out];
		}

		/** Whether the running host still serves this exact bundle revision. */
		async function serves(url) {
			try {
				const response = await fetch(url, { method: "HEAD", cache: "no-store", credentials: "same-origin" });
				// 405 says the route took the request and only refuses HEAD, not that the revision is gone.
				if (response.status === 405) return true;
				return response.ok;
			} catch {
				return false;
			}
		}

		/**
		 * The address to enter, already proven to boot.
		 *
		 * A plugin's bundle revision changes the moment its file does, and HMR republishes that
		 * revision while the page keeps the document it booted from. Reloading into the previous
		 * document therefore asks for bundle addresses the host no longer serves: the boot aborts
		 * and the shell reports a failure it cannot leave on its own. Reading the document first
		 * and waiting while any of its addresses still refuses turns the press into one that lands
		 * on a servable graph instead.
		 * @returns {target: string} when a reading is servable, {blind: true} when the document
		 * itself could not be read, or {stuck: true} when readings kept naming missing bundles.
		 */
		async function servableDocument() {
			let readAny = false;
			for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
				if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
				const target = freshDocumentUrl();
				let html = null;
				try {
					const response = await fetch(target, { cache: "no-store", credentials: "same-origin" });
					if (response.ok) html = await response.text();
				} catch {
					html = null;
				}
				const graph = html === null ? null : readBootGraph(html);
				if (graph === null) continue;
				readAny = true;
				let missing = 0;
				for (const url of bundleSources(graph)) {
					if (!(await serves(url))) missing += 1;
				}
				if (missing === 0) return { target };
			}
			return readAny ? { stuck: true } : { blind: true };
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
				setBusy(true);
				setStuck(false);
				void servableDocument().then((plan) => {
					if (plan.target !== undefined) {
						window.location.replace(plan.target);
						return;
					}
					// A document that cannot be read at all is not evidence about the graph: keep the old
					// acknowledgement-then-reload behaviour rather than leaving the press doing nothing.
					if (plan.blind === true) {
						setTimeout(() => {
							window.location.reload();
						}, MESSAGE_MS);
						return;
					}
					setBusy(false);
					setStuck(true);
					console.warn('dsh-ui-reload: plugin bundles are not servable yet; press again shortly.');
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
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	},
});
