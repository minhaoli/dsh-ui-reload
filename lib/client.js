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

			useEffect(() => {
				ensureKeyframes();
			}, []);

			const onClick = useCallback((event) => {
				event.stopPropagation();
				setBusy(true);
				// Let the pressed state paint before the document is replaced;
				// reloading synchronously can leave the click looking ignored.
				setTimeout(() => {
					window.location.reload();
				}, MESSAGE_MS);
			}, []);

			const title = "刷新整个前端（重新加载页面）";

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
