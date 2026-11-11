# dsh-ui-reload

给 DSH 会话头部加一个「重载整个前端」按钮，就在分享按钮左边。

点一下重载整个页面 —— 这是唯一能可靠地把前端各种不一致一次性抹掉的操作：运行中的页面底下被重新构建过的客户端插件 bundle、插件列表变更、过期 CSS，以及 shell 自身的代码。

## 重载前先确认目标页面能启动

插件 bundle 一改，`dsh-client-hmr` 就按磁盘上的字节重算这个 bundle 的 revision 并重新发布。页面手里的文档还带着旧 revision，那些 `plugins/??…&rev=<旧>` 在宿主侧已经取不到；启动器在单插件 bundle 和聚合 bundle 两条路上都失败后直接抛错，应用就停在「无法启动或已意外停止」。

所以按下按钮不再直接 reload：

1. 取一个带唯一 query 的文档地址，读出宿主真正会发回来的那份文档；
2. 从注入的 `globalThis["__DSH_BOOT__"]` 取出启动图，对其中的每个 bundle 地址发一次 `HEAD`；
3. 全部可取才导航过去；有一个取不到就等 600 ms 重读文档，最多 8 轮（约 5 秒）。

进不去时不导航：停在当前页面，按钮恢复可用，title 变成「插件还没准备好，稍后再按一次」。文档本身读不到（协议层异常）时退回原来的 reload 行为。

聚合 bundle 有几十 MB，所以校验用 `HEAD` —— 路由只回 immutable 头、不物化正文，不会为了探一次把整包拉下来。

## 适用版本

| | |
|---|---|
| DSH | `0.2.2-rc.1`（验证所用版本），`0.2.1-rc.2` 亦可用 |
| `@deepseek-ai/cordis` | `~4.0.5` |
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

DSH 自带 `dsh-client-hmr`，插件 bundle 一变就重新发布。这个按钮是给那条路覆盖不到的残余准备的 —— shell 或 bootstrap 早于某次改动的页面，或者只有真正重新加载文档才能清掉的状态。重载文档是唯一能全覆盖的手段。

**点一下之后还在的：** 对话、工作区、连接状态 —— 这些都在 host 上。

**不在的：** 只存在页面里的东西 —— 滚动位置、打开的浮层、还没发出去正在编辑的输入、客户端计时器。

## 实现说明

包里有前后两半，bundle patch 一次挂两边：

- `lib/index.js` —— host 侧。导出空的 `apply()`，不注册任何路由、服务或 watcher，因为整页重载不需要 host 提供什么。它存在的唯一理由是让 bundle 那一行有东西可挂；删掉它整个包就不会被组合，浏览器端的按钮也跟着消失。
- `lib/client.js` —— 浏览器侧，经 `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-slots"]` 注入。它把按钮注册进 `conversation.session.header.utilities`。点击后先校验目标文档的启动图（见上一节），通过则用 `location.replace()` 进入；进不去就停在当前页面，不把应用带进一个起不来的文档。

## 更新日志

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
