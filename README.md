# dsh-ui-reload

A "reload the whole frontend" button in the DSH conversation session header, immediately left of the share button.

Clicking it reloads the entire page — the one operation that reliably picks up anything the frontend can be out of sync with: client plugin bundles rebuilt under the running page, plugin-list changes, stale CSS, and the shell's own code.

The button and **F5** are the same press. F5 is handled by the plugin itself (capture phase, `preventDefault`), because the application reserves F5 and refuses it as a command default. The command `ui-reload.reload` is still registered in the shortcut catalog without a default, so the same action can be bound to another key in the shortcuts settings. Both paths share one 1.2 s cooldown and never fire twice.

## A press lands on a servable graph

A press does not always reload. Two kinds of failure leave the app on "应用无法启动或已意外停止" with only a process restart as the way out:

- after a plugin bundle changes, `dsh-client-hmr` recomputes its revision from the bytes on disk, while the boot graph the page holds still names the previous one — the host no longer serves those addresses;
- more often: a build is writing a bundle file at the exact moment the page reloads. The file exists and answers 200, but it is half a file, so executing it throws and the boot audit reports "an entry did not activate".

So a press:

1. asks this plugin's own host half first;
2. the host half reads the boot graph and, for every row whose **revision changed**, locates its bundle file and compiles it with `node:vm` (compile only, never run). A missing, unreadable or unparsable file means not ready;
3. the browser half then sends one `HEAD` per bundle address in the graph, confirming the host still serves that revision;
4. it navigates only when both pass; otherwise it waits 600 ms and asks again, up to eight times (about 5 s).

When nothing passes it does not navigate: the current page stays, the button becomes pressable, its title says the plugin graph is not ready yet, the console gets a warning, and the host half records which plugin and which reason (`missing` / `unreadable` / `incomplete`). A failure costs an unresponsive press, not a dead app.

The page cannot answer this on its own: the desktop renderer is served a bootstrap document whose body carries no boot graph, so `fetch(location.href)` returns only that shell. That is exactly why the 0.2.1 pre-flight was inert — it never found a graph and silently fell back to a plain reload.

Confirming addresses uses `HEAD` because the aggregate bundle is tens of megabytes; compiling runs only for rows whose revision changed and skips files above 4 MB.

## Requirements

| | |
|---|---|
| DSH | `0.2.2-rc.1` (verified against it); `0.2.1-rc.2` also works |
| `@deepseek-ai/cordis` | `~4.0.5` |
| Mode | Web UI (`web` or `desktop` profile) — there is no CLI surface |

Earlier DSH releases are untested. The button mounts into the slot `conversation.session.header.utilities`; a release that renames or removes that slot leaves it unrendered.

## Install

```bash
dsh plugin --profile <your-profile> add github:minhaoli/dsh-ui-reload
```

The package declares `dsh.bundle.patch`, so the row is appended to `dsh.profile.bundles` and the loader mounts it on the next start. Reload the page once after installing — the client half is served as a separate module.

Manual install:

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: ui-reload
      name: 'dsh-ui-reload'
```

## Why a full reload and not HMR

DSH already ships `dsh-client-hmr`, which republishes a plugin the moment its bundle changes. This button exists for the residue that path cannot reach — a page whose shell or bootstrap predates a change, or state that only a real document load clears. Reloading the document is the only thing that covers all of it.

**What survives a click:** conversation, workspace and connection state — they live on the host.

**What does not:** anything held only in the page — scroll position, open panels, in-flight composer text, running client-side timers.

## How it works

The package has two halves and the bundle patch mounts both:

- `lib/index.js` — the host half. It exports an empty `apply()` and registers no route, service or watcher, because a plain page reload needs nothing from the host. It exists only so the bundle row has something to mount; dropping it would stop the package from being composed at all, taking the client button with it.
- `lib/client.js` — the browser half, injected through `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-slots"]`. It registers the button into `conversation.session.header.utilities` and F5 as the `ui-reload.reload` command; both call the same `pressReload()`. A click first verifies the target document's boot graph (previous section) and then enters it with `location.replace()`; when nothing is servable it stays on the current page instead of booting a document that cannot come up.

## Changelog

### 0.2.2

- F5 is registered as the keyboard command `ui-reload.reload`, sharing the same verify-then-reload press as the button and rebindable in the shortcuts settings

- readiness is answered by the plugin's own host half: it reads the boot graph and compiles the bundle file of every row whose revision changed (`node:vm`, compile only); missing, unreadable or unparsable counts as not ready
- the browser half asks the host first, then `HEAD`s every bundle address; it navigates only when both pass
- fixes the 0.2.1 dead path: the desktop renderer is served a bootstrap document without `__DSH_BOOT__`, so reading its own document always returned null and the pre-flight quietly degraded to a plain reload
- a refused press keeps the current page and says so in the button title; the host half records which plugin and why

### 0.2.1

- Verifies the target document's boot graph before reloading: when a bundle revision no longer matches the host, the press waits and retries instead of reloading into a page that cannot boot
- When no reading is servable it does not navigate; the press reports through the button title instead of reproducing "应用无法启动或已意外停止"
- Probes use `HEAD`, so verification never re-downloads the multi-megabyte aggregate bundle

## Companion plugins

- [`dsh-session-tree`](https://github.com/minhaoli/dsh-session-tree) — sidebar with tags, grouping and drag-to-move.
- [`dsh-session-manager`](https://github.com/minhaoli/dsh-session-manager) — agent tools and REST API for session housekeeping.
- [`dsh-session-search`](https://github.com/minhaoli/dsh-session-search) — in-conversation find bar.
- [`dsh-session-query-vector`](https://github.com/minhaoli/dsh-session-query-vector) — semantic session search backend.

## License

MIT — see [LICENSE](./LICENSE).
