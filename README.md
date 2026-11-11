# dsh-ui-reload

A "reload the whole frontend" button in the DSH conversation session header, immediately left of the share button.

Clicking it reloads the entire page — the one operation that reliably picks up anything the frontend can be out of sync with: client plugin bundles rebuilt under the running page, plugin-list changes, stale CSS, and the shell's own code.

## A press lands on a servable graph

The moment a plugin bundle changes, `dsh-client-hmr` recomputes that bundle's revision from the bytes on disk and republishes it. The document the page is holding still names the previous revision, those `plugins/??…&rev=<old>` addresses stop resolving, and the loader — after failing both the per-plugin bundle and the aggregate one — throws. The app then sits on "应用无法启动或已意外停止" until the process restarts.

So a press no longer calls `reload()` directly:

1. it takes a document address with a fresh query and reads back the document the host would actually serve;
2. it reads the boot graph out of the injected `globalThis["__DSH_BOOT__"]` and sends one `HEAD` per bundle address in it;
3. it navigates only when every address resolves; otherwise it waits 600 ms, reads the document again, and retries — up to 8 readings (about 5 s).

When no reading is servable the press does not navigate: the current page stays, the button becomes pressable again, and its title says the plugin graph is not ready yet. When the document itself cannot be read (a protocol-level failure), it falls back to the old reload.

The probes are `HEAD` requests because the aggregate bundle is tens of megabytes and the route answers a HEAD from immutable headers without materialising the body.

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
- `lib/client.js` — the browser half, injected through `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-slots"]`. It registers the button into `conversation.session.header.utilities`. A click first verifies the target document's boot graph (previous section) and then enters it with `location.replace()`; when nothing is servable it stays on the current page instead of booting a document that cannot come up.

## Changelog

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
