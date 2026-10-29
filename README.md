# CLI MCP Bridge

将本地 AI 编码 Agent 接入 MCP 客户端，使用你自己的账号。

Bridge local AI coding CLIs to MCP clients using your own accounts.

支持 **CodeBuddy、Qoder 和 OpenCode**。MCP 客户端可以提交代码审查任务、延续会话、查询进度、处理停止请求，并取回结果和工件。

本项目完全由 GPT 主导开发，可能存在各种问题，且不承诺后续更新。

本项目独立开发，与这些服务商无隶属关系。用户自行安装官方 CLI、登录自己的账号并承担相应费用；项目不提供账号、密钥或免费额度。第三方服务仍受各自条款约束，见 [第三方服务说明](THIRD_PARTY_SERVICES.md)。

## 当前范围

- 本机 stdio MCP + 后台 daemon，12 个 MCP 工具。
- 三个固定后端、按后端配置模型允许列表；同一会话固定后端，可选择允许的模型。
- SQLite 保存任务、回执和会话，支持断连后找回、重启后续接。
- 全局同时执行 1 个任务；提供排队、超时、中断、取消和审批。
- 当前开放 `review`；`edit`、上下文工件输入和自定义任务超时尚未开放。

当前验证平台为 **macOS、Node.js 24.18.0**。Windows 尚不支持；Linux 未做实际验收。后端 CLI 锁定版本及认证方式见 [兼容性](docs/COMPATIBILITY.md)。

## 从源码安装

目前提供源码安装，尚未发布 npm 包。取得仓库源码后，在项目目录运行：

```sh
node --version  # 要求 >=24.18.0 <25，验证基线为 24.18.0
npm ci --ignore-scripts
node bin/cli-mcp-bridge.mjs version
node bin/cli-mcp-bridge.mjs tools list --json
```

`--ignore-scripts` 避免依赖安装脚本下载额外运行时；本项目绑定用户已安装的官方 CLI。第三方包依赖由 npm 官方源安装，不随本仓库附带。还没有配置 CLI 时，上面两个查询也可运行。

下文在项目目录使用 `node bin/cli-mcp-bridge.mjs`。可选执行 `npm link --ignore-scripts` 安装本机命令，之后使用 `cli-mcp-bridge`；`ocbridge`、`zbridge` 为兼容别名。

## 首次配置：以 Qoder 为例

1. 自行安装兼容版本的 [Qoder CLI](https://docs.qoder.com/cli/quick-start)，运行 `qodercli` 完成官方登录，并查看本人账号当前可用的原生模型 ID。
2. 创建独立配置。下面的 CLI 路径、模型 ID 和工作区路径需要换成你自己的值：

```sh
mkdir -p "$HOME/.config/cli-mcp-bridge"
node bin/cli-mcp-bridge.mjs config init \
  --backend qoder --executable /absolute/path/to/qodercli \
  --auth cli-login --model YOUR_MODEL_ID \
  --out "$HOME/.config/cli-mcp-bridge/config.json"
```

生成的配置尚未登记工作区。编辑 `config.json`，将 `workspaces` 改为：

```json
[
  {
    "id": "my-project",
    "name": "My project",
    "root": "/absolute/path/to/your/project",
    "profiles": ["review"]
  }
]
```

工作区必须是明确的项目目录，不能使用根目录、整个用户目录或系统临时目录。配置样例也可从 [config/qoder.example.json](config/qoder.example.json) 复制；不要把编辑后的私有配置提交到仓库。

3. 校验并启动。这里使用独立的数据目录，避免操作旧版本后台：

```sh
node bin/cli-mcp-bridge.mjs config validate \
  --config "$HOME/.config/cli-mcp-bridge/config.json"
node bin/cli-mcp-bridge.mjs start \
  --config "$HOME/.config/cli-mcp-bridge/config.json" \
  --data-dir "$HOME/.local/share/cli-mcp-bridge"
node bin/cli-mcp-bridge.mjs status \
  --config "$HOME/.config/cli-mcp-bridge/config.json" \
  --data-dir "$HOME/.local/share/cli-mcp-bridge" --json
```

启动后台不代表模型可用；第一次提交任务才会发起模型请求。配置其他后端、在线模型目录和审批，见 [使用说明](docs/USAGE.md)。

## 接入 MCP 客户端

在客户端的 stdio MCP 配置中添加以下条目，将三个绝对路径替换为本机实际值。配置键名按客户端要求调整。

```json
{
  "mcpServers": {
    "cli-mcp-bridge": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/cli-mcp-bridge/bin/cli-mcp-bridge.mjs",
        "mcp", "serve",
        "--data-dir", "/absolute/path/to/your/bridge-data"
      ]
    }
  }
}
```

`--data-dir` 必须与后台启动时一致；该入口连接已运行的后台。支持标准 stdio MCP 的客户端可使用，具体客户端界面接入需自行验证。工具调用流程见 [MCP 工具](docs/MCP.md)。

## 数据与权限

工作区会复制到后台管理的副本中；模型输入、读取的代码及输出会按后端功能发送给服务商。任务结果、事件、会话和备份保存在本机数据目录中，备份可能包含凭据。只选择你有权交给服务商处理的代码。

审批在本机 `operator` 命令中处理。当前普通通道和审批通道仍属于同一个操作系统用户，不能用于隔离互不信任的用户；本项目也不是多租户托管服务。`review` 的工具限制不等于完整操作系统沙箱。

已有用户可继续使用旧命令和默认路径；新命令若省略路径参数，也沿用旧默认值。具体位置见 [使用说明](docs/USAGE.md#默认路径与兼容)。

## 开发与验证

```sh
npm test
npm run check:release
```

`npm test` 使用模拟后端，不调用真实模型；SDK 的真实验收单独显式开启。见 [测试说明](docs/TESTING.md) 和 [发布验证记录](docs/VALIDATION.md)。

## 许可证

本项目自有代码采用 [Apache-2.0](LICENSE)。第三方 SDK、CLI 和在线服务保留各自许可与使用条款，见 [依赖声明](THIRD-PARTY-NOTICES.md)。参与贡献前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)。
