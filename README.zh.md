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
2. host 半边读取启动图，对**页面真正会加载的每一个批次**取出宿主会供出的字节，用 `node:vm` 编译一次（只编译、不执行）；不是完整脚本就算没准备好。某个批次不过时，先把里面那些插件重发一次（动 mtime、请注册表重读），再重新读启动图、对**新**的批次地址再编译一遍；
3. 刚被写过的 bundle 一样不算数：同一次回答里带着「被检查的文件中最新那个是多少毫秒前写的」，没到 700 ms 就继续等；
4. 浏览器半边再对启动图上的每个批次地址发 `HEAD`，确认宿主还在供这一版；
5. 全部通过才导航；否则等 600 ms 重问，最多 8 轮（约 5 秒）。

始终不通过就不导航：停在当前页面，按钮恢复可用，title 变成「插件还没准备好，稍后再按一次」，控制台留一条 warn，host 侧同时记录是哪个批次、哪种原因（`incomplete-as-served` / `served-unavailable` / `batch-too-large` / `no-batches`，记成 `batch:<phase>:<rev>`）。一次失败最多是一次没反应，不会把应用弄死。

页面为什么自己答不了这个问题：桌面的渲染层加载的是自举页，正文里没有启动图，`fetch(location.href)` 只能拿到那段壳。0.2.1 的预检正是栽在这里——它永远读不到图，实际退化成了裸 reload。

### 预检编译的对象是什么

页面并不加载一个个插件 bundle。`dsh-client-modules` 把所有 bundle 分成几个 **combo 批次**，`bootInjections()` 给每个批次往文档里塞一个 `<script src>`（bootstrap）或 `<link rel=preload>`（application）——插件自己的地址确实存在，但文档从来不请求它。批次是把成员拼接起来、每个成员以 `;\n` 结尾构成的，所以真正执行的脚本不是其中任何单个成员。

这点很关键：逐成员编译预测不了批次。两个各自都能编译的 bundle，一旦共享同一个脚本的顶层作用域就会撞车（`Identifier 'resumePage' has already been declared`）。所以 0.3.2 编译 `graph.batches[].url`——文档实际取的那个对象——而 0.3.1 的逐行检查只保留下来做两件事：指出失败批次里是哪个成员、以及把它重发。

106 个条目的 profile 上是三个批次：0.04 MB、6.76 MB 和 **33.67 MB**。编译最大那个约 **340 ms**，解析期间占约 **150 MB** 堆；同样的字节再编译一次是免费的，因为 Node 缓存了已编译脚本。所以门禁按 revision 每个批次只编译一次并记住结论：批次 revision 是对有序 `(id, rev)` 列表的哈希，注册表对一个已发布 revision 只供一份正文，编译过一次的 revision 不会带着不同字节回来。失败从不记住——半截正文恰恰是重发后必须重编的那种。

旧的 4 MB 上限就是那个洞：两个大批次超过它，被当成「太大不验」直接放行，而那是页面要执行的 90% 的字节。上限现在提到 64 MB，超过的批次**hold**（`batch-too-large`）而不是放行——没验过的批次不算承诺。

浏览器半边的地址确认仍然用 `HEAD`，因为正文已经由预检读过了。

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

### revision 是文件键，不是字节

`dsh-client-modules` 每个条目只取一次客户端 bundle：把文件读进缓冲区，再用这个文件的 `mtime`、`ctime`、`size` 算出页面要用的地址。revision 描述的是文件，从来不是正文——构建如果正好在读的那一刻写文件，缓冲区里就是半截脚本，而 revision 已经指向写完后的文件。

之后没有任何机制能修它。再问 `rebuilt(id)`，算出来还是同一个键，判定没变、根本不重读；`dsh-client-hmr` 每 500 ms 轮询这个键，调完 `rebuilt` 就把自己的基线对齐到当前 stat，刚发现的那次变化就此丢掉。重启进程会从磁盘重建注册表，所以重启永远有效——这也是按钮不能再信 revision 的原因。

所以每次按下校验的是文档真正会执行的批次脚本。某个批次不是完整脚本时，host 半边把里面的 bundle 走一遍，把出问题的文件 `mtime` 改成现在（只动时间戳，绝不重写内容），请注册表重新发布该条目，再重新读启动图、对它**新**的批次地址再编译；仍然不过的批次按 `batch:<phase>:<rev>` 记下来并 hold，而不是放行。没有任何「拿磁盘顶上」的回退：磁盘看着完好、served 却取不到，就明确报 `served-unavailable` 并 hold。

## 更新日志

### 0.3.2

- 预检改为编译页面**实际加载的 combo 批次**（`graph.batches[].url`），不再是每个插件自己的地址：那个地址文档从不请求，它能编译也说明不了拼接后的脚本能不能跑
- 批次编译不过就以 `batch:<phase>:<rev>` hold 住这次按下；先把里面的 bundle 重发，再重新读启动图，对**新**的地址取结论，而不是沿用刚失败的那几个
- 那个「超过 4 MB 就不验」的上限删掉了——正是它放行了 6.76 MB 和 33.67 MB 两个批次。上限改为 64 MB 并实测了代价（最大批次约 340 ms、约 150 MB 堆），超过则 hold 成 `batch-too-large`，不再放行
- 干净的批次 revision 会被记住，340 ms 的解析每次变更只付一次，不必每次按下都付；失败从不记住
- 逐行检查保留，但只用来指出并重发失败批次里的成员；一次按下的编译检查也因此从 106 次降到 3 次
- 启动图里没有任何批次时报 `no-batches` 并 hold，不再未验即放行

### 0.3.1

- 每次按下都对每一行校验宿主会供出的字节；「revision 与本次页面启动时相同就跳过」的判断已删除，那个 revision 恰恰可能是错的
- served 的字节编译不过时不再只是拒绝，而是强制重发：把文件的 `mtime` 改到现在（不改内容）、请注册表重读、再校验新地址
- served 取不到的 bundle 明确报 `served-unavailable` 并 hold，不再静默改读磁盘
- 预检回答新增 `repaired`；日志里每个被重发的条目留一行 `republished: <id> -> <rev>`

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
