# dsh-ui-reload

给 DSH 会话头部加一个「重载整个前端」按钮，就在分享按钮左边。

点一下，先把磁盘上改过的宿主端插件重载掉，再重载整个页面。这样抹掉的不只是运行中的页面底下被重新构建过的客户端插件 bundle、插件列表变更、过期 CSS 和 shell 自身的代码，还包括已经在跑的那些插件的 `lib/index.js`、`host/*.js` 改动 —— 那是整页重载永远碰不到的一半。

按按钮和按 **F5** 是同一件事。F5 由插件自己监听（捕获阶段、`preventDefault`），因为宿主把 F5 列为保留键，不能作为命令默认键。命令 `ui-reload.reload` 仍然注册进应用的快捷键目录，但不带默认键——想在别的键上绑同一动作，去快捷键设置里给它指定即可。两条路径共用一个 1.2 秒冷却，不会重复触发。

## 重载前先确认目标页面能启动

按下去不一定能刷新成功，这是这个插件最要紧的地方。两类失败都会让应用停在「无法启动或已意外停止」，只有重启能出来：

- 插件 bundle 改过之后，`dsh-client-hmr` 会按磁盘字节重算 revision；页面手里的启动图还指着旧 revision，宿主不再提供那些地址。
- 更常见的一类：构建正在写 bundle 文件，页面恰好在这几毫秒里重载，拿到的是半截代码。文件存在、也返回 200，但执行到一半抛错，启动器报「一个条目没有激活」。

所以按下按钮后：

1. 先请 host 半边把磁盘上改过的宿主端插件重载掉（见下一节）；
2. host 半边读取启动图，对 **revision 变过**的条目找到它的 bundle 文件，用 `node:vm` 编译一次（只编译、不执行），确认字节是完整的脚本；缺文件、读不出、编译不过都算没准备好；
3. 刚被写过的 bundle 一样不算数：同一次回答里带着「被检查的文件中最新那个是多少毫秒前写的」，没到 700 ms 就继续等；
4. 浏览器半边再对启动图上的每个 bundle 地址发 `HEAD`，确认宿主还在供这一版；
5. 全部通过才导航；否则等 600 ms 重问，最多 8 轮（约 5 秒）。

始终不通过就不导航：停在当前页面，按钮恢复可用，title 变成「插件还没准备好，稍后再按一次」，控制台留一条 warn，host 侧同时记录是哪个插件、哪种原因（`missing` / `unreadable` / `incomplete`）。一次失败最多是一次没反应，不会把应用弄死。

页面为什么自己答不了这个问题：桌面的渲染层加载的是自举页，正文里没有启动图，`fetch(location.href)` 只能拿到那段壳。0.2.1 的预检正是栽在这里——它永远读不到图，实际退化成了裸 reload。

聚合 bundle 有几十 MB，所以地址确认用 `HEAD`（路由只回 immutable 头、不物化正文）；文件编译只针对 revision 变过的条目，且超过 4 MB 的跳过。

## 宿主端插件也一起重载

重载文档会把每个客户端 bundle 重新拉一遍，但碰不到插件的 host 半边：`lib/index.js`、`host/*.js` 是运行中的进程已经占住的模块。所以按下按钮时，host 半边还会做一遍插件管理器做的事 —— 把每个已加载模块跟它来自的文件比对，逐出变化的那些，停掉跑它们的条目，再用当前文件把条目重新起来：

```js
await ctx.hmr.runExclusive(() => ctx.hmr.reconcileProfile([]))
```

顺序有讲究：先宿主端，因为一个被重启的插件可能挪动文档马上要加载的客户端图。

这依赖 `@deepseek-ai/dsh-hmr`。只要启动器提供了 `profileContext`，`dsh-base` 就会启用它 —— 桌面端提供，headless 和 SDK 宿主不提供。没有它时按钮照样重载页面，日志里记 `host=unsupported`，不会坏。

host 那边会回报还有多少文件保持 pending、重组产生了几条 warning，以及需要真重启进程时给出 `restartReason`（宿主依赖变了）。有 `restartReason` 意味着页面会重载，但那部分要等应用重启才生效。

一个前提：这个路由本身属于 host 半边，所以第一次装上它的那个版本必须先重启一次，之后它才能重载别的东西。

## 适用版本

| | |
|---|---|
| DSH | `0.2.2-rc.1`（验证所用版本），`0.2.1-rc.2` 亦可用 |
| `@deepseek-ai/cordis` | `~4.0.5` |
| `@deepseek-ai/dsh-hmr` | 由 `dsh-base` 经 `profileContext` 启用；没有它时只重载页面 |
| 形态 | Web UI（`web` 或 `desktop` profile），没有 CLI 侧 |

更早的 DSH 版本未验证。按钮挂在 `conversation.session.header.utilities` 这个插槽上；某个版本改名或删掉这个插槽，按钮就不会渲染。

## 安装

```bash
dsh plugin --profile <你的 profile> add github:minhaoli/dsh-ui-reload
```

包里声明了 `dsh.bundle.patch`，所以这一行会被写进 `dsh.profile.bundles`，下次启动即挂载。装完刷新一次页面 —— 浏览器端是单独一个模块。

手工安装：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: ui-reload
      name: 'dsh-ui-reload'
```

## 为什么要整页重载，而不是 HMR

DSH 自带 `dsh-client-hmr`，插件 bundle 一变就重新发布。这个按钮是给那条路覆盖不到的残余准备的 —— shell 或 bootstrap 早于某次改动的页面，或者只有真正重新加载文档才能清掉的状态。客户端这一半只有重载文档能全覆盖；宿主端那一半由上一节的 profile 重组覆盖。

**点一下之后还在的：** 对话、工作区、连接状态 —— 这些都在 host 上。

**不在的：** 只存在页面里的东西 —— 滚动位置、打开的浮层、还没发出去正在编辑的输入、客户端计时器。

## 实现说明

包里有前后两半，bundle patch 一次挂两边：

- `lib/index.js` —— host 侧。在 web 服务器上挂三个路由：页面日志、宿主端插件重载（走 `ctx.hmr`）、以及重载前检查。检查之所以必须在 host 侧，是因为页面没有文件系统，答不了「新文档要加载的那些文件现在能不能跑」。
- `lib/client.js` —— 浏览器侧，经 `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-slots"]` 注入。它把按钮注册进 `conversation.session.header.utilities`，并把 F5 注册成 `ui-reload.reload` 命令；两者调用同一个 `pressReload()`。点击后先校验目标文档的启动图（见上一节），通过则用 `location.replace()` 进入；进不去就停在当前页面，不把应用带进一个起不来的文档。

## 更新日志

### 0.3.0

- 按下按钮先重载宿主端插件：host 半边请 `ctx.hmr` 做一次 profile 重组，逐出所有磁盘上改过的已加载模块并重启对应条目，`lib/index.js`、`host/*.js` 的改动不再需要重启进程
- 预检回答里新增 `quietMs`（被检查的 bundle 中最新的那个是多少毫秒前写的）；变化过的 bundle 没到 700 ms 就不放行，堵掉「编译的是这一版、加载的是下一版」那个窗口
- 日志在页面重载前记录宿主端重载结果（`done` / `unsupported` / `failed`，以及 `pending`、`restartReason`）
- `README`：删掉「host 侧导出空的 `apply()`」那段过时说明
### 0.2.2

- 新增 F5：注册为键盘命令 `ui-reload.reload`，与按钮共用一套「先确认再重载」的逻辑，可在快捷键设置里重绑

- 预检改由插件自己的 host 半边回答：读启动图，对 revision 变过的条目编译其 bundle 文件（`node:vm`，只编译不执行），缺文件 / 读不出 / 编译不过都算未就绪
- 页面侧先问 host，再对每个 bundle 地址 `HEAD`；两者都通过才导航
- 修复 0.2.1 的失效路径：桌面渲染层是自举页、正文没有 `__DSH_BOOT__`，页面读文档的预检永远返回 null，实际退化成了裸 reload
- 失败时保持当前页面并在 title 上提示，host 侧记录具体插件与原因

### 0.2.1

- 重载前校验目标文档的启动图：bundle revision 与宿主不一致时等待重试，不再直接 reload 进一个起不来的页面
- 校验始终不通过时不导航，改为在按钮 title 上提示，避免「应用无法启动或已意外停止」
- 校验用 `HEAD`，不重新拉取几十 MB 的聚合 bundle

## 配套插件

- [`dsh-session-tree`](https://github.com/minhaoli/dsh-session-tree) —— 带标签、分组、拖拽移动的侧栏。
- [`dsh-session-manager`](https://github.com/minhaoli/dsh-session-manager) —— 会话维护的 agent 工具与 REST API。
- [`dsh-session-search`](https://github.com/minhaoli/dsh-session-search) —— 对话内查找栏。
- [`dsh-session-query-vector`](https://github.com/minhaoli/dsh-session-query-vector) —— 会话语义搜索后端。

## 许可

MIT —— 见 [LICENSE](./LICENSE)。
