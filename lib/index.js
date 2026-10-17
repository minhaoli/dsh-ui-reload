/**
 * Host half of dsh-ui-reload.
 *
 * The button this package contributes is a plain page reload, so the browser
 * needs nothing from the host and this half registers no route, no service and
 * no watcher. It exists because a profile bundle is a single plugin row that
 * mounts both halves: `dsh.bundle.patch` names this module, and dropping it
 * would stop the package from being composed at all — taking the client button
 * with it.
 */

/** Cordis plugin name. */
export const name = "ui-reload";

/**
 * Mount nothing. Kept as a no-op rather than an absent export so the loader's
 * expectations for a plugin entry hold.
 */
export function apply() {}
