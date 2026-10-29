# 使用说明

所有示例使用 `cli-mcp-bridge` 命令；未执行本机链接安装时，替换为 `node bin/cli-mcp-bridge.mjs`。

对独立实例，`start`、`restart`、`status`、`backends`、`models` 一并传入相同的 `--config` 和 `--data-dir`。`stop`、`mcp serve`、`operator` 通过 `--data-dir` 定位后台。

## 后端配置

首次可从对应的 `config/*.example.json` 复制并修改，或用 `config init` 生成。CodeBuddy 和 Qoder 初始配置还需登记 `workspaces`，见 README。

| 后端 | 初始认证 | 模型格式 |
|---|---|---|
| CodeBuddy | 官方 CLI 已登录，`--auth cli-login` | 官方账号可用的原生 ID |
| Qoder | 官方 CLI 已登录，或本人 PAT 文件 | 官方账号可用的原生 ID |
| OpenCode | 私有 provider 文件 | `providerID/modelID` |

CodeBuddy 仅支持 `cli-login`；`credential-file` 当前会明确拒绝。Qoder 的 PAT 文件格式为 `{"accessToken":"<your-token>"}`，保存在仓库之外并设为 0600，然后用 `--auth credential-file --auth-file /absolute/private/auth.json` 引用。桥接配置不直接保存 token。

在已有配置中添加后端：

```sh
cli-mcp-bridge backends configure codebuddy \
  --executable /absolute/path/to/codebuddy --auth cli-login --model YOUR_MODEL_ID \
  --config /absolute/private/config.json --data-dir /absolute/private/data
cli-mcp-bridge backends enable codebuddy \
  --config /absolute/private/config.json --data-dir /absolute/private/data
cli-mcp-bridge backends default codebuddy \
  --config /absolute/private/config.json --data-dir /absolute/private/data
```

`backends configure` 首次登记的项默认禁用；`config init --backend …` 创建的首个项则启用。配置变更保存后执行 `restart`，已有会话仍绑定原后端。

### OpenCode

以 `config/example.config.json` 为起点，设置 `backends.opencode.executable`、`providerConfigFile` 和 `modelProfiles`。私有 provider 文件使用 `{ "providers": { "供应商ID": { /* 对应 OpenCode provider 配置 */ } } }`，内容包括模型定义和该供应商所需的认证项；具体 provider 配置遵循已安装 OpenCode 的官方文档。

也可以使用已有 OpenCode JSON/JSONC 导入指定模型：

```sh
cli-mcp-bridge models add provider/model --from /absolute/private/opencode.jsonc \
  --config /absolute/private/config.json --provider-config /absolute/private/providers.json \
  --data-dir /absolute/private/data --default
```

只导入所选模型与供应商配置，不导入全局插件或 MCP。导入产生的私有文件和备份不得提交仓库。只使用自己已获授权的供应商账号或 API Key。

## 模型与目录

```sh
cli-mcp-bridge models list --backend qoder
cli-mcp-bridge models list --available --online --backend qoder
cli-mcp-bridge models add YOUR_MODEL_ID --backend qoder
cli-mcp-bridge models default YOUR_MODEL_ID --backend qoder
cli-mcp-bridge models remove OLD_MODEL_ID --backend qoder --replacement YOUR_MODEL_ID
```

以上默认使用兼容路径；独立实例需追加对应路径参数。省略 `--backend` 固定操作 OpenCode，不随当前默认后端改变。

允许列表是本地声明，不保证账号拥有该模型。`--online` 通过官方 SDK 查询当前账号模型目录，涉及网络认证但不发送推理 prompt；不自动修改允许列表。模型名称、定价、免费活动和可用性以本人账号当前显示及服务商规则为准。

## 启停与状态

```sh
cli-mcp-bridge start --config /absolute/private/config.json --data-dir /absolute/private/data
cli-mcp-bridge status --config /absolute/private/config.json --data-dir /absolute/private/data --json
cli-mcp-bridge restart --config /absolute/private/config.json --data-dir /absolute/private/data
cli-mcp-bridge stop --data-dir /absolute/private/data
```

任务、排队项或审批存在时，普通 stop/restart 拒绝停止；确定要中断时显式加 `--force`。`status` 不启动 SDK worker，不调用模型；`restartRequired` 表示磁盘配置与后台加载配置不同。

`BACKEND_PROTOCOL_MISMATCH` 通常需要检查 CLI 锁定版本；不要直接修改版本常量跳过兼容性核对。`STOP_UNCONFIRMED` 或 `unknown` 表示不能确认执行结果，需先核对本机进程和任务，不应重复提交同一操作。

## 审批

MCP 不提供审批管理工具。在本机终端列出并处理待批项：

```sh
cli-mcp-bridge operator approvals --data-dir /absolute/private/data --json
cli-mcp-bridge operator decide --data-dir /absolute/private/data \
  --approval-id APPROVAL_ID --decision allow_once \
  --payload-hash PAYLOAD_HASH --server-epoch SERVER_EPOCH --attempt-id ATTEMPT_ID
```

使用列表返回的实际值，审阅工具、路径和参数后决定；拒绝使用 `--decision deny`。review 禁用的工具不能通过审批放开。事实提问当前不支持输入，后端提出问题时该轮会有界停止。

## 默认路径与兼容

| 用途 | 省略参数时的兼容路径 |
|---|---|
| 桥接配置 | `~/.config/opencode-bridge/config.json` |
| OpenCode 私有 provider 文件 | `~/.config/opencode-bridge/minimax-provider.json` |
| 数据、会话和备份 | `~/Library/Application Support/OpenCodeBridge` |

旧的 `ocbridge`、`zbridge` 入口继续可用。新项目名没有自动搬迁这些文件。首次使用推荐采用 README 中的显式独立路径，避免误启停旧实例；macOS Unix socket 的路径长度有限，数据目录不宜过深。

配置 v2 只读兼容；`config migrate --config /absolute/private/config.json` 可显式迁移到 v3，修改前备份。v1 / ZCode 配置不兼容。配置备份和启动备份可能含凭据，请只保留在本机。

`--json` 输出便于程序读取。退出码：0 成功；1 运行错误；2 用法/配置错误；3 策略拒绝或忙碌；4 前置条件或状态不能确认；5 不支持。
