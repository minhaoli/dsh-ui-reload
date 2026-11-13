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

		/** One document address this press has not entered yet: a new query makes the shell render it again. */
		function freshDocumentUrl() {
			const url = new URL(window.location.href);
			url.searchParams.set("dsh-ui-reload", Date.now().toString(36));
			return url.toString();
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
			const state = await readiness();
			note("press: readiness=" + state);
			if (state === "ready") {
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
				// A build can bump the graph again between the document being rendered and its scripts
				// being fetched, which is a race no single check closes. Two readings that agree mean the
				// graph stopped moving, so the document the press enters is still current when it loads.
				const rev = typeof verdict.rev === "string" ? verdict.rev : "";
				if (settledRev !== null && rev === settledRev) return "ready";
				settledRev = rev;
			}
			return answered ? "stuck" : "blind";
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
