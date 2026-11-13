# dsh-ui-reload

A "reload the whole frontend" button in the DSH conversation session header, immediately left of the share button.

Clicking it reloads what a page on its own cannot reach: first every host plugin whose files changed on disk, then the entire page. That covers client plugin bundles rebuilt under the running page, plugin-list changes, stale CSS and the shell's own code — and, unlike a plain reload, edits to `lib/index.js` or `host/*.js` of a plugin that is already running.

The button and **F5** are the same press. F5 is handled by the plugin itself (capture phase, `preventDefault`), because the application reserves F5 and refuses it as a command default. The command `ui-reload.reload` is still registered in the shortcut catalog without a default, so the same action can be bound to another key in the shortcuts settings. Both paths share one 1.2 s cooldown and never fire twice.

## A press lands on a servable graph

A press does not always reload. Two kinds of failure leave the app on "应用无法启动或已意外停止" with only a process restart as the way out:

- after a plugin bundle changes, `dsh-client-hmr` recomputes its revision from the bytes on disk, while the boot graph the page holds still names the previous one — the host no longer serves those addresses;
- more often: a build is writing a bundle file at the exact moment the page reloads. The file exists and answers 200, but it is half a file, so executing it throws and the boot audit reports "an entry did not activate".

So a press:

1. asks this plugin's own host half to replace every host plugin whose files changed on disk (next section);
2. the host half reads the boot graph and, for **every batch the document will actually load**, takes the bytes the host serves and compiles them with `node:vm` (compile only, never run). A batch that is not a complete script means not ready; when one fails, the plugins inside it are republished once (mtime moved, entry re-read), the graph is read again and its *new* batch addresses are compiled;
3. a bundle written a moment ago is not trusted either: the same answer carries how long ago the youngest checked file was written, and a press waits until that is at least 700 ms;
4. the browser half then sends one `HEAD` per batch address in the graph, confirming the host still serves that revision;
5. it navigates only when all of it passes; otherwise it waits 600 ms and asks again, up to eight times (about 5 s).

When nothing passes it does not navigate: the current page stays, the button becomes pressable, its title says the plugin graph is not ready yet, the console gets a warning, and the host half records which batch and which reason (`incomplete-as-served` / `served-unavailable` / `batch-too-large` / `no-batches`, named `batch:<phase>:<rev>`). A failure costs an unresponsive press, not a dead app.

The page cannot answer this on its own: the desktop renderer is served a bootstrap document whose body carries no boot graph, so `fetch(location.href)` returns only that shell. That is exactly why the 0.2.1 pre-flight was inert — it never found a graph and silently fell back to a plain reload.

### What the pre-flight compiles

The page does not load each plugin bundle. `dsh-client-modules` groups every bundle into a few **combo batches** and `bootInjections()` puts one `<script src>` (bootstrap) or `<link rel=preload>` (application) per batch into the document — the per-plugin address exists, but the document never requests it. A batch is built by concatenating its members and terminating each with `;\n`, so the script that runs is not any one member.

That matters because compiling each member alone does not predict the batch: two bundles that each compile can still collide once they share one script's top-level scope (`Identifier 'resumePage' has already been declared`). So 0.3.2 compiles `graph.batches[].url` — the same object the document fetches — and 0.3.1's per-row pass is kept only to name and republish the member of a batch that failed.

On a 106-entry profile that is three batches: 0.04 MB, 6.76 MB and **33.67 MB**. Compiling the largest costs about **340 ms** and roughly **150 MB of heap** while the parse is live; compiling the same bytes again is free because Node caches the compiled script. So the gate compiles each batch once per revision and remembers the verdict: a batch revision is a hash over the ordered `(id, rev)` list and the registry serves one body per published revision, so a revision that compiled once cannot come back with different bytes. Failures are never remembered — a torn body is exactly what must be recompiled after a republish.

The old 4 MB ceiling was the hole: the two big batches exceeded it and were waved through as "too large to verify", which is 90% of the bytes the page executes. The ceiling is now 64 MB, and a batch above it is **held** (`batch-too-large`) rather than passed — an unverified batch is not a promise.

Address confirmation in the browser half still uses `HEAD`, since the pre-flight has already read the bodies.

## Host plugins too

A document reload re-fetches every client bundle, but it cannot touch a plugin's host half: `lib/index.js` and `host/*.js` are modules the running process already occupies. So a press also asks the host half to do what the Plugin Manager does — compare every loaded module against the file it came from, evict the stale ones, stop the entries running them and restart those entries from the current files:

```js
await ctx.hmr.runExclusive(() => ctx.hmr.reconcileProfile([]))
```

Order matters: host plugins first, because a restarted plugin can move the client graph the document is about to load.

This needs `@deepseek-ai/dsh-hmr`, which `dsh-base` enables whenever the launcher supplies `profileContext` — the desktop app does, headless and SDK hosts do not. Without it the press still reloads the page and records `host=unsupported` in the log; nothing breaks.

The host returns how many files stayed pending, how many warnings the recomposition raised, and a `restartReason` when the change needs a real process restart (host dependencies moved). A `restartReason` means the page reloads but that part does not take effect until the app restarts.

One caveat: this route is part of the host half, so the first release that adds it needs one restart before it can reload anything else.

## Requirements

| | |
|---|---|
| DSH | `0.2.2-rc.1` (verified against it); `0.2.1-rc.2` also works |
| `@deepseek-ai/cordis` | `~4.0.5` |
| `@deepseek-ai/dsh-hmr` | enabled by `dsh-base` through `profileContext`; without it the press reloads only the page |
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

DSH already ships `dsh-client-hmr`, which republishes a plugin the moment its bundle changes. This button exists for the residue that path cannot reach — a page whose shell or bootstrap predates a change, or state that only a real document load clears. Reloading the document is the only thing that covers all of it on the client side; the host side is covered by the reconciliation described in the previous section.

**What survives a click:** conversation, workspace and connection state — they live on the host.

**What does not:** anything held only in the page — scroll position, open panels, in-flight composer text, running client-side timers.

## How it works

The package has two halves and the bundle patch mounts both:

- `lib/index.js` — the host half. It mounts three routes on the web server: the page log, the host plugin reload (through `ctx.hmr`) and the readiness check. The readiness route exists because the page has no filesystem, so it cannot answer for the files a new document would load.
- `lib/client.js` — the browser half, injected through `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-slots"]`. It registers the button into `conversation.session.header.utilities` and F5 as the `ui-reload.reload` command; both call the same `pressReload()`. A click first verifies the target document's boot graph (previous section) and then enters it with `location.replace()`; when nothing is servable it stays on the current page instead of booting a document that cannot come up.

### A revision is a file key, not the bytes

`dsh-client-modules` takes each client bundle once, when it publishes that entry: it reads the file into a buffer, and derives the address the page will use from that file's `mtime`, `ctime` and `size`. The revision describes a file, never a body — so a build writing the file during that read can leave the buffer holding half a script while the revision already matches the finished file.

Nothing repairs it afterwards. Asking `rebuilt(id)` recomputes the same key, concludes nothing changed and returns without re-reading; `dsh-client-hmr` polls that key every 500 ms, calls `rebuilt`, and then resets its own baseline to the live stat, so the change it just noticed is dropped. A process restart rebuilds the registry from disk, which is why restarting always works — and why a press had to stop trusting revisions.

So a press verifies the batch scripts the document would actually execute. When one is not a complete script, the host half walks the bundles inside it, moves the offending file's `mtime` to now — the timestamp only, the contents are never rewritten — asks the registry to republish that entry, then reads the graph again and compiles its new batch addresses. A batch that still fails is held back and logged as `batch:<phase>:<rev>`, so the page stays put instead of entering a document that cannot come up. Nothing falls back to reading the disk: a file that looks fine while the served bytes are unavailable is reported as exactly that and held, not passed.

## Changelog

### 0.3.2

- the pre-flight now compiles the **combo batches** the document actually loads (`graph.batches[].url`), not each plugin's own address: the per-plugin address is never requested by the document, and its bytes compiling says nothing about the concatenated script that runs
- a batch that does not compile holds the press with `batch:<phase>:<rev>`; the bundles inside it are republished first, and the graph is read again so the verdict is taken on the *new* addresses rather than the ones that just failed
- the 4 MB compile ceiling that silently passed the 6.76 MB and 33.67 MB batches is gone: the ceiling is 64 MB with the measured cost (about 340 ms and 150 MB of heap for the largest batch), and anything above it is held as `batch-too-large` instead of passed
- a clean batch revision is remembered, so the 340 ms parse is paid once per change rather than on every press; failures are never remembered
- per-row checking is kept, but only to name and republish the member of a failed batch, which also cuts a press from 106 compile-checks to 3
- a graph advertising no batches is held as `no-batches` rather than passed unverified

### 0.3.1

- a press verifies the bytes the host would serve for every row, every press; the skip for a row whose revision still matched the one this page booted with is gone, because that revision is exactly what could be wrong
- a bundle that does not compile as served is republished instead of only being refused: the file's `mtime` is moved (contents untouched), the registry re-reads it, and the new address is verified
- a bundle the host cannot serve is held and reported as `served-unavailable` instead of being silently compared against the file on disk
- the readiness answer carries what a press repaired (`repaired`), and the log records one `republished: <id> -> <rev>` line per entry

### 0.3.0

- a press now reloads host plugins first: the host half asks `ctx.hmr` to reconcile the profile, which evicts every loaded module whose file changed on disk and restarts its entry, so `lib/index.js` and `host/*.js` edits no longer need a process restart
- the readiness answer now carries `quietMs`, the age of the youngest checked bundle; a press waits until a changed bundle is at least 700 ms old, closing the window where the bytes that compiled are not the bytes that load
- the log records the host reload outcome (`done` / `unsupported` / `failed`, plus `pending` and `restartReason`) before the page reload
- `README`: the host half no longer described as an empty `apply()`
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
