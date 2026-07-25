---
title: "MCP Tools：从函数调用到可维护的工具服务"
date: 2026-07-25
layout: post
description: "从测试工程实践出发，梳理 MCP Tools、Function Calling、三种传输方式和主流 Agent 配置。"
category: "AI Agent"
tags: ["MCP", "AI Agent", "Function Calling", "Codex", "工程实践"]
featured: true
cover_style: "mcp"
---

> **作者**：Ivy Zhang

如果只是让模型调用一个函数，Function Calling 已经够用。真正麻烦的是工具数量上来以后：每个模型的 schema 格式不同，参数校验散落在业务代码里，工具改名以后要同时改 prompt、路由和测试，出了问题还不容易判断到底是模型选错了工具，还是服务端执行失败。

MCP（Model Context Protocol）解决的不是“模型会不会调用函数”这个问题，而是把工具发现、参数约束、传输和服务生命周期放到一个约定里。对测试工程师来说，它更像一个可观测、可替换的工具接入层：测试结果、构建状态、日志和代码扫描能力可以独立部署，也可以被不同的 Agent 复用。

本文从 Function Calling 开始，逐步写出一个包含 Tool、Resource 和 Prompt 的 MCP Server，再比较 STDIO、Streamable HTTP 和旧版 SSE transport 的适用范围。

## 一、为什么需要 MCP

### 1. Function Calling 能做什么

Function Calling 的基本流程很直接：应用把工具定义发给模型，模型返回一个工具调用请求，应用执行本地函数，再把结果发回模型。

下面的例子模拟一个测试平台查询接口。模型负责判断“应该查哪个测试运行”，应用负责真正访问平台 API。这个边界很重要：模型不应该直接拥有数据库连接，也不应该绕过权限检查。

<details>
<summary>展开 Function Calling 示例：查询测试运行结果</summary>

```python
from openai import OpenAI

client = OpenAI()


def query_test_run(run_id: str) -> dict:
    """实际项目中，这里通常会调用测试平台 API。"""
    runs = {
        "run-2026-0725": {
            "status": "failed",
            "failed": 3,
            "passed": 127,
            "flaky": 2,
        }
    }
    return runs.get(run_id, {"status": "not_found"})


tools = [
    {
        "type": "function",
        "function": {
            "name": "query_test_run",
            "description": "查询一次自动化测试运行的汇总结果",
            "parameters": {
                "type": "object",
                "properties": {
                    "run_id": {
                        "type": "string",
                        "description": "测试运行 ID，例如 run-2026-0725",
                    }
                },
                "required": ["run_id"],
                "additionalProperties": False,
            },
        },
    }
]

messages = [
    {
        "role": "user",
        "content": "请告诉我 run-2026-0725 是否通过，并说明失败数量。",
    }
]

first = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=messages,
    tools=tools,
    tool_choice="auto",
)

assistant_message = first.choices[0].message
messages.append(assistant_message)

for tool_call in assistant_message.tool_calls or []:
    if tool_call.function.name != "query_test_run":
        continue

    import json

    arguments = json.loads(tool_call.function.arguments)
    result = query_test_run(**arguments)
    messages.append(
        {
            "role": "tool",
            "tool_call_id": tool_call.id,
            "content": json.dumps(result, ensure_ascii=False),
        }
    )

second = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=messages,
    tools=tools,
)

print(second.choices[0].message.content)
```

</details>

这个方案的优点是接入成本低、调用链清楚，适合一个应用自己维护少量工具。缺点也很明显：工具 schema 和执行逻辑都在应用里；换模型供应商时，调用格式和错误处理通常需要重新适配；多个项目要复用同一个工具时，容易复制出几份略有差异的实现。

### 2. MCP 解决的是接入和复用

MCP 将调用方拆成 Host、Client 和 Server：

1. **Host** 是 Cursor、Codex 或自建 Agent 应用，负责用户交互和模型调用。
2. **Client** 负责与某一个 MCP Server 建立会话、发现能力并转发请求。
3. **Server** 暴露工具和数据，不需要了解上层使用的是哪家模型。

这种拆分让测试平台可以把“查询测试结果”“读取构建日志”“触发回归任务”作为独立能力提供出去。调用方只需要处理 MCP 协议，不必为每个 Agent 单独写一套适配层。

MCP 目前常见的三类能力是：

- **Tools**：有副作用或需要明确执行的动作，例如触发构建、创建缺陷、查询测试结果。
- **Resources**：按 URI 读取的数据，例如日志快照、仓库状态或测试报告。
- **Prompts**：可复用的提示模板，例如“按严重程度审查失败用例”。

## 二、一个包含三类能力的 MCP Server

下面的例子使用 MCP Python SDK 的 `FastMCP`。它包含一个网页抓取 Tool、一个日志 Resource 和一个代码审查 Prompt。示例重点是接口边界，生产环境还需要补充认证、超时、审计日志和访问控制。

<details>
<summary>展开 MCP Server 示例：Tool、Resource 和 Prompt</summary>

```python
import logging
from datetime import datetime

import httpx
from bs4 import BeautifulSoup
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("test-engineering-tools")
logging.basicConfig(level=logging.INFO)


@mcp.tool()
async def fetch_page(url: str, selector: str = "article") -> str:
    """抓取网页正文，返回最多 5,000 个字符。"""
    async with httpx.AsyncClient(timeout=8.0) as client:
        response = await client.get(
            url,
            headers={"User-Agent": "test-engineering-mcp/1.0"},
        )
        response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    for element in soup(["script", "style", "iframe", "nav"]):
        element.decompose()

    target = soup.select_one(selector) or soup.body
    if target is None:
        return "没有找到可读内容。"

    text = " ".join(target.get_text().split())
    return text[:5000]


@mcp.resource("resource://logs/{level}")
def read_logs(level: str) -> str:
    """返回一个按级别过滤的日志快照。"""
    now = datetime.now().isoformat(timespec="seconds")
    return f"[{now}] level={level} message=test pipeline is healthy"


@mcp.prompt()
def review_failed_test(language: str = "python") -> str:
    """生成失败用例的审查提示。"""
    return (
        f"请以测试工程师视角审查以下 {language} 失败用例，"
        "优先判断是否为产品缺陷、测试数据问题或环境问题。"
    )


if __name__ == "__main__":
    mcp.run(transport="stdio")
```

</details>

这里有几个容易被忽略的工程问题：Tool 的返回值应该限制大小，避免一次把整份日志塞进上下文；外部 HTTP 调用必须设置超时；写给人的日志要走 `stderr`，不能污染 STDIO 的协议输出；有副作用的 Tool 还应当设计幂等键和二次确认。

## 三、传输方式和使用场景

当前 MCP 规范定义的标准传输是 **STDIO** 和 **Streamable HTTP**。SSE 来自早期的 HTTP+SSE transport，仍可用于兼容旧客户端。三者传输的都是 UTF-8 编码的 JSON-RPC 消息，不是任意二进制流。

### 1. STDIO：本地父子进程通信

Host 启动 Server 子进程，通过 `stdin` 写入换行分隔的 JSON-RPC 消息，Server 通过 `stdout` 返回协议消息。没有网络监听，适合本地 IDE 和桌面 Agent。

下面这个工具扫描项目里的 TODO，调用过程和普通本地脚本一样，权限自然继承当前用户。

<details>
<summary>展开 STDIO Server 示例</summary>

```python
from pathlib import Path

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("local-test-tools")


@mcp.tool()
def find_todos(root: str = ".", limit: int = 20) -> list[dict]:
    """查找 Python 文件中的 TODO。"""
    matches = []
    for path in Path(root).rglob("*.py"):
        for line_number, line in enumerate(path.read_text().splitlines(), 1):
            if "TODO" not in line:
                continue
            matches.append(
                {"file": str(path), "line": line_number, "text": line.strip()}
            )
            if len(matches) >= limit:
                return matches
    return matches


if __name__ == "__main__":
    mcp.run(transport="stdio")
```

</details>

STDIO 的代价是只能在能启动该进程的环境里使用。配置 IDE 时应填写 Python 和脚本的绝对路径；普通日志写到 `stderr`，否则会把协议流打坏。

### 2. Streamable HTTP：远程智能体和服务网关

Streamable HTTP 是当前的远程传输方式。一个 MCP endpoint 同时支持 `POST` 和 `GET`：客户端用 `POST` 发送 JSON-RPC 消息，Server 可以直接返回 JSON，也可以按需返回 SSE 流；客户端还可以用 `GET` 接收 Server 推送的事件。

下面把 CI 构建查询做成一个远程服务。示例绑定在本机，部署到服务器时应放在 TLS、认证、Origin 校验、限流和审计之后。

<details>
<summary>展开 Streamable HTTP Server 示例</summary>

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP(
    "ci-build-service",
    host="127.0.0.1",
    port=8000,
)

BUILDS = {
    "build-101": {"status": "passed", "duration_seconds": 83},
    "build-102": {"status": "running", "duration_seconds": None},
}


@mcp.tool()
def get_build(build_id: str) -> dict:
    """查询 CI 构建状态。"""
    return BUILDS.get(build_id, {"status": "not_found"})


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
```

</details>

默认 endpoint 是 `http://127.0.0.1:8000/mcp`。它不是一条永不关闭的 WebSocket 连接，而是普通 HTTP 请求与可选事件流的组合。对云端 Agent、远程沙盒和企业内部工具网关来说，这种方式比本地 STDIO 更容易部署和治理。

### 3. SSE：旧 HTTP+SSE transport 的兼容层

早期 MCP transport 使用一个 SSE endpoint 接收 Server 消息，再使用另一个 HTTP endpoint 向 Server 发消息。SSE 本身是 server-to-client 的单向推送，client-to-server 方向依靠额外的 HTTP 请求完成。

如果内部还有旧版 MCP Client，可以暂时保留这个 transport。新服务优先使用 Streamable HTTP。

<details>
<summary>展开旧版 SSE Server 示例</summary>

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP(
    "legacy-ticket-service",
    host="127.0.0.1",
    port=8000,
)


@mcp.tool()
def get_ticket(ticket_id: str) -> dict:
    """读取旧测试管理系统中的缺陷单。"""
    return {
        "id": ticket_id,
        "status": "open",
        "owner": "qa-platform",
    }


if __name__ == "__main__":
    mcp.run(transport="sse")
```

</details>

SSE 适合迁移期和旧系统集成，不建议把它作为新 MCP 服务的默认选项。协议细节可参考 [MCP 官方 Transports 规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。

可以用一句话记住三者：**STDIO 解决本地进程通信，Streamable HTTP 解决当前远程服务，SSE 负责兼容旧客户端。**

## 四、MCP 和传统 Function Calling 的差异

两者不是互斥关系。MCP Server 最终仍然需要被 Agent 或模型调用；很多 Agent 内部会把 MCP Tools 转换成模型能理解的函数定义。区别在于工具的发现、生命周期和传输边界由谁负责。

| 对比维度 | 传统 Function Calling | MCP |
| :--- | :--- | :--- |
| 工具定义 | 通常由应用在请求中直接传入 | Server 暴露，Client 可发现 |
| 复用方式 | 需要自行抽成 SDK 或服务 | 一个 Server 可供多个兼容 Client 使用 |
| 模型适配 | 应用处理不同厂商的 tool schema | Client 负责协议适配，模型仍由 Host 管理 |
| 数据范围 | 主要描述可调用函数 | Tools、Resources、Prompts 三类能力 |
| 部署方式 | 常与 Agent 进程绑定 | 可以是本地进程，也可以是远程服务 |
| 复杂度 | 单个应用、少量工具时更低 | 工具多、团队复用或需要独立治理时更合适 |

Function Calling 的优点是简单、可控、调试路径短。MCP 的优点是把工具从单个 Agent 中拆出来，便于权限管理、版本发布和跨客户端复用。MCP 也不是自动获得安全性：Server 仍然要自己做鉴权、输入校验、超时、幂等和审计。

## 五、在主流 Agent 和 AI 编辑器里配置

### 1. Cursor、Windsurf 或 Codex：配置 STDIO

本地编辑器通常直接启动 MCP Server。配置时使用绝对路径，并确保运行环境里已经安装依赖。

<details>
<summary>展开本地 Agent 配置示例</summary>

```json
{
  "mcpServers": {
    "local-test-tools": {
      "command": "/Users/yourname/.venvs/mcp/bin/python",
      "args": ["/Users/yourname/projects/mcp/server_stdio.py"]
    }
  }
}
```

</details>

不同编辑器的配置文件位置和字段名称可能不同，最终以客户端当前版本的设置页面为准。验证时先观察 Server 是否成功启动，再确认工具列表能否被发现，最后用一个只读工具做调用测试。

### 2. 远程 Agent：配置 Streamable HTTP

远程部署时把 Server 运行在服务端地址，并把 endpoint 交给 Agent 的 MCP Client。不要把开发机临时暴露到公网作为长期方案；本地联调可以使用 ngrok，但生产环境应使用正式域名、TLS 和鉴权。

<details>
<summary>展开 HTTP 模式启动示例</summary>

```bash
export MCP_TRANSPORT=http
python server.py

# 仅用于本地联调
ngrok http 8000
```

</details>

远程 Client 使用类似下面的 endpoint：

<details>
<summary>展开远程 endpoint 配置示例</summary>

```json
{
  "mcpServers": {
    "ci-build-service": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN}"
      }
    }
  }
}
```

</details>

## 六、测试工程师最容易踩到的坑

1. **协议输出和业务日志混在一起**：STDIO 模式下，stdout 只留给 JSON-RPC；诊断日志写 stderr。
2. **工具没有超时**：网络请求、查询构建状态和读取日志都应设置超时，并返回可识别的错误类型。
3. **返回内容过大**：日志和测试报告先截断、分页或提供 Resource URI，不要一次性把整份报告放进上下文。
4. **副作用没有幂等设计**：触发回归、创建缺陷、重跑构建前，应支持幂等键和确认策略。
5. **只测模型不测工具链**：至少覆盖 schema 校验、权限失败、超时、空结果、重复调用和服务重启后的重新连接。
6. **把 MCP 当成安全边界**：MCP 只定义通信和能力发现，真正的认证、授权、敏感数据脱敏和审计仍由服务端负责。

在测试平台里，比较实用的落地顺序是：先用 STDIO 接一个只读查询工具，确认工具描述和返回结果稳定；再迁移到 Streamable HTTP，补齐鉴权、限流和观测；最后根据旧客户端情况决定是否保留 SSE 兼容层。这样每一步都有明确的回滚点，也方便定位问题到底发生在模型、Client、传输层还是业务服务。
