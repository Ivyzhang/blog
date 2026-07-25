---
title: "MCP Tools：给模型一把靠谱的工具箱"
date: 2026-07-25
tags: ["MCP", "AI Agent", "Function Calling", "Codex", "工程实践"]
status: "published"
summary: "从工程实践角度介绍 MCP tools 的概念、协议、传输方式、配置方法和使用场景。"
---

# MCP Tools：给模型一把靠谱的工具箱

> 让模型干活，最怕的不是它不会，而是它会得太散。MCP 的价值，就是把工具接入这件事从“各家各写一套私房菜”变成“至少厨房有统一插座”。

如果你最近在看 AI agent、桌面助手、代码助手，十有八九会碰到 MCP 这个词。第一次听的人通常会有三种反应：

1. “这是不是某种高级缓存？”
2. “这是不是 function calling 的新马甲？”
3. “我只想让模型帮我查个数据库，为什么先得学协议栈？”

其实 MCP 很朴素：它想解决的是 **模型怎么稳定、可复用、可发现地连接外部工具**。

---

## 什么是 MCP

MCP，全称 **Model Context Protocol**。你可以把它理解成：

> 一种让 agent 通过统一协议去发现工具、读取资源、调用能力的标准接口。

它通常把系统拆成三层：

- **Host**：真正承载交互的应用，比如 Codex、Claude Desktop、Cursor、你的自研 agent。
- **Client**：Host 里负责连接 MCP server 的那一层。
- **Server**：对外暴露工具、资源、提示模板的服务。

MCP 里最常见的三个对象是：

- **tools**：可调用动作，比如“查仓库”“建 issue”“跑 SQL”。
- **resources**：可读取内容，比如文件、文档、数据库记录、仓库摘要。
- **prompts**：可复用的提示模板，比如“帮我总结这个 PR”。

一句话总结：

> function calling 负责“叫模型去用工具”，MCP 负责“让工具这件事长得像一个生态”。

---

## 它为什么会出现

早期大家都在做 function calling。每个产品都能让模型调用工具，但问题很快来了：

- A 产品的工具定义长这样；
- B 产品的参数校验长那样；
- C 产品的结果格式完全不同；
- D 产品连鉴权都自己发明了一套半成品。

于是开发者的工作变成：

> 给每个 agent 平台各写一遍工具接入，再各修一遍参数坑。

这很像你去五家医院挂同一种号，结果每家都要求你填不同的表格、走不同的门、说不同的话。医学上叫“流程管理”，工程上叫“折腾人”。

MCP 想做的事，就是把这层接入协议标准化：

- 工具如何声明；
- 工具如何被发现；
- 工具如何传参；
- 工具如何返回结果；
- 资源怎么读；
- 提示怎么复用；
- 本地和远程怎么连。

一旦标准统一，Host 就不必为每个工具供应商单独适配，Tool provider 也不必为每个 Host 重写一份接口。

---

## 一个稍复杂一点的 MCP 例子

下面这个例子展示一个“仓库助手” server，它提供三个能力：

- 列仓库；
- 查某个仓库的 open PR；
- 读取仓库摘要资源。

### MCP server 示例

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("repo-helper")

REPOS = {
    "ivy/covivy": {
        "description": "Self-hosted coverage service",
        "open_prs": [
            {"number": 12, "title": "Improve patch coverage", "author": "ivy"},
            {"number": 15, "title": "Add PR dashboard", "author": "ivy"},
        ],
    },
    "ivy/demo": {
        "description": "Sandbox repo",
        "open_prs": [],
    },
}


@mcp.tool()
def list_repositories(prefix: str = "") -> list[str]:
    return [name for name in REPOS if name.startswith(prefix)]


@mcp.tool()
def list_open_prs(repo: str, limit: int = 10) -> list[dict]:
    data = REPOS.get(repo)
    if not data:
        return []
    return data["open_prs"][:limit]


@mcp.resource("repo://{repo}")
def repo_summary(repo: str) -> dict:
    return REPOS.get(repo, {"description": "unknown repo", "open_prs": []})


if __name__ == "__main__":
    mcp.run()
```

这个例子里，模型不是“猜”仓库里有什么，而是通过协议显式发现：

- 有哪些 tool；
- tool 要什么参数；
- 返回什么结构；
- 还能直接读 `repo://ivy/covivy` 这样的资源。

这比把所有能力塞进一个巨大 prompt 里稳得多。大 prompt 的问题是：看起来像万能胶，实际经常把自己粘得一团糟。

---

## 传输方式有哪些

MCP 的核心不在“工具长什么样”，而在“工具怎么接进来”。

常见传输方式有两类：

### 1. stdio

这是本地开发最常见的方式。

Host 启动一个子进程，双方通过标准输入输出交换消息。

优点：

- 简单；
- 适合本地调试；
- 不需要暴露网络端口；
- 对桌面 agent 很友好。

缺点：

- 适合单机；
- 不适合天然共享给多个客户端；
- 进程生命周期要管好。

### 2. HTTP / streamable HTTP

这是远程部署更常用的方式。

Host 通过 HTTP 与 MCP server 通信，server 可以在远端运行，也更适合团队共享。

优点：

- 易部署；
- 易做鉴权；
- 适合企业内部服务；
- 多客户端复用更自然。

缺点：

- 要考虑网络、超时、鉴权、重试；
- 比 stdio 多一层基础设施；
- 远端服务慢一点时，模型会比产品经理还要不耐烦。

### 3. SSE

有些实现历史上用过 SSE 风格的流式通信。今天更主流的趋势是朝 streamable HTTP 发展。

工程上你可以把它理解成：

- **stdio** 更像“本地管道”；
- **HTTP** 更像“远程服务”；
- **SSE** 是流式体验演进过程中的历史分支。

---

## 和 function calling 的区别

很多人会问：MCP 不就是 function calling 吗？

答案是：**像，但不一样。**

### function calling 更像“单次调用约定”

模型输出一个结构化调用，比如：

```json
{
  "name": "search_docs",
  "arguments": {
    "query": "patch coverage"
  }
}
```

Host 负责接住，然后真的去执行函数，再把结果喂回模型。

它的优点是：

- 简洁；
- 直接；
- 模型和工具之间耦合较低；
- 很适合单个应用内部的工具调用。

它的缺点是：

- 工具描述通常是应用内私有的；
- 发现、复用、权限、资源读取都要自己补；
- 每个 Host 可能各写一套适配；
- 一旦工具多起来，管理会逐渐像抽屉里的一团数据线。

### MCP 更像“工具生态协议”

MCP 不只是让模型“能调用函数”，而是定义了一整套协作方式：

- 工具发现；
- 资源读取；
- 提示模板；
- 远程连接；
- 统一鉴权与传输；
- 多 host 复用。

它的优点是：

- 工具可复用；
- Host 可标准化接入；
- 支持资源和 prompt，不只是一堆函数；
- 更适合桌面助手、企业内部工具、跨产品生态。

它的缺点是：

- 复杂度更高；
- 要多维护一个 server；
- 调试路径更长；
- 不是每个场景都值得上协议层。

### 怎么选

我自己的判断很简单：

- **单个应用内部、工具很少**：function calling 足够；
- **工具要被多个 agent/产品复用**：MCP 更合适；
- **你想让工具既可调用、又可发现、还能读资源**：MCP 的价值会明显起来。

---

## MCP 适合哪些场景

MCP 不是为了“看起来很标准”而生的。它最适合这些场景：

### 1. 本地开发助手

比如让模型访问：

- 当前工作区文件；
- Git 状态；
- 本地终端；
- 浏览器；
- IDE 或桌面工具。

stdio 非常适合这种场景。

### 2. 企业内部知识和系统

比如：

- Confluence / Notion 文档；
- Jira issue；
- 内部 API；
- 代码仓库；
- 数据库查询；
- 权限受控的运维工具。

HTTP MCP 很适合做成统一服务。

### 3. 多 agent 平台

当你不想让每个 agent 都重新实现“找文档、查工单、看 PR”这套逻辑时，MCP 让这些能力可复用。

### 4. 可审计、可治理的工具接入

企业最喜欢的一句话是“我们要统一治理”。MCP 刚好能把工具能力、权限、日志和连接方式收拢到一层协议里。

---

## 主流 agent 里怎么配置

不同产品的 UI 和配置文件名字不完全一样，但思路基本一致：

> 声明 server 名称、启动方式、环境变量、鉴权信息。

### Codex

Codex CLI 里最直接的方式是：

```bash
codex mcp add github --url https://example.com/mcp
codex mcp list
```

如果是本地 stdio server：

```bash
codex mcp add repo-helper -- python /path/to/server.py
```

这是我最喜欢的方式之一。理由很简单：不绕，能看，能改，适合工程师。

### Claude Desktop 类产品

这类桌面 agent 通常会有一个 JSON 配置块，常见形态类似：

```json
{
  "mcpServers": {
    "repo-helper": {
      "command": "python",
      "args": ["/path/to/server.py"],
      "env": {
        "API_KEY": "xxx"
      }
    }
  }
}
```

### Cursor / Continue / 其他 IDE agent

大体也是同一类思路：

- 找到 MCP 配置入口；
- 填 server 名称；
- 填 command 或 URL；
- 加环境变量；
- 重启 IDE 或刷新配置。

你可以把它理解成“给编辑器装一个外接工具架”。形式不同，味道差不多。

### 自研 agent

如果你自己写 agent，一般会在启动时注册多个 MCP server：

```python
servers = [
    {"name": "docs", "url": "https://docs.internal/mcp"},
    {"name": "repo", "command": "python", "args": ["repo_server.py"]},
]
```

然后由 client 层统一发现 tools / resources / prompts。关键不是语法，而是把“接入”变成可配置，而不是写死在代码里。

---

## 一个工程化建议

如果你要真的上 MCP，不要一上来就把十几个系统全接进去。那不是自动化，那是把未来的故障工单提前订阅了。

建议顺序是：

1. 先接一个最有价值的工具，比如 docs search 或 repo query；
2. 再接一个资源读取能力；
3. 再接权限控制和日志；
4. 最后才考虑跨团队复用。

最好的 MCP 项目，通常不是“工具最多”的项目，而是“最先把一个高频痛点打穿”的项目。

---

## 结语

MCP 的真正意义，不是给模型加了一个花哨的新接口，而是把“工具连接”从一次性脚本，升级成了可复用的协议层。

如果 function calling 像是给模型装了手电筒，那么 MCP 更像是给它配了一个插满模块的工作台：

- 能看见工具；
- 能读资源；
- 能复用配置；
- 能跨产品工作；
- 也更适合长期维护。

当然，协议不会自动让模型变聪明。它只是让聪明更容易落地，让混乱更少一点。

这就已经很值钱了。

