# dsh-ui-reload

给 DSH 会话头部加一个「重载整个前端」按钮，就在分享按钮左边。

点一下重载整个页面 —— 这是唯一能可靠地把前端各种不一致一次性抹掉的操作：运行中的页面底下被重新构建过的客户端插件 bundle、插件列表变更、过期 CSS，以及 shell 自身的代码。

## 适用版本

| | |
|---|---|
| DSH | `0.2.1-rc.2`（开发与验证所用版本） |
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
- `lib/client.js` —— 浏览器侧，经 `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-slots"]` 注入。它把按钮注册进 `conversation.session.header.utilities`，点击后先给 400 ms 的点击反馈，再调 `window.location.reload()`。

## 配套插件

- [`dsh-session-tree`](https://github.com/minhaoli/dsh-session-tree) —— 带标签、分组、拖拽移动的侧栏。
- [`dsh-session-manager`](https://github.com/minhaoli/dsh-session-manager) —— 会话维护的 agent 工具与 REST API。
- [`dsh-session-search`](https://github.com/minhaoli/dsh-session-search) —— 对话内查找栏。
- [`dsh-session-query-vector`](https://github.com/minhaoli/dsh-session-query-vector) —— 会话语义搜索后端。

## 许可

MIT —— 见 [LICENSE](./LICENSE)。
