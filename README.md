# dsh-ui-reload

A "reload the whole frontend" button in the DSH conversation session header, immediately left of the share button.

Clicking it reloads the entire page — the one operation that reliably picks up anything the frontend can be out of sync with: client plugin bundles rebuilt under the running page, plugin-list changes, stale CSS, and the shell's own code.

## Requirements

| | |
|---|---|
| DSH | `0.2.1-rc.2` (developed and tested against it) |
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
- `lib/client.js` — the browser half, injected through `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-slots"]`. It registers the button into `conversation.session.header.utilities` and calls `window.location.reload()` on click, after a 400 ms acknowledgement so the click registers visually before the load takes over.

## Companion plugins

- [`dsh-session-tree`](https://github.com/minhaoli/dsh-session-tree) — sidebar with tags, grouping and drag-to-move.
- [`dsh-session-manager`](https://github.com/minhaoli/dsh-session-manager) — agent tools and REST API for session housekeeping.
- [`dsh-session-search`](https://github.com/minhaoli/dsh-session-search) — in-conversation find bar.
- [`dsh-session-query-vector`](https://github.com/minhaoli/dsh-session-query-vector) — semantic session search backend.

## License

MIT — see [LICENSE](./LICENSE).
