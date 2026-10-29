# 兼容性与验证范围

发布准备日期：2026-10-29；当前源码候选版本：0.1.0。后端版本来自迁移前已核对的安装基线，未在本轮升级。

| 后端 | 官方 CLI | SDK | 当前认证 |
|---|---|---|---|
| CodeBuddy | 2.173.0 | `@tencent-ai/agent-sdk` 0.3.291 | CLI 已登录 |
| Qoder | 1.1.78 | `@qoder-ai/qoder-agent-sdk` 1.0.56 | CLI 已登录 / 本人 PAT 文件 |
| OpenCode | 1.18.32 | HTTP/SSE 适配层，无 OpenCode SDK 依赖 | 用户私有 provider 配置 |

宿主运行时验证基线：macOS、Node.js 24.18.0。依赖版本由 `package-lock.json` 固定。Windows 的进程管理及 IPC 不适用，Linux 尚未验收，因此当前不声明跨平台支持。

CodeBuddy SDK 的 CLI 路径绑定使用指向已安装二进制的 `.exe` 符号链接，以适配锁定 SDK 的直接执行分支；不修改官方二进制，也不跳过登录或配额校验。该兼容手段需要随 SDK 版本重新核对。

Qoder 通过官方 `qodercliAuth()` / PAT 与 query/daemon 接口接入。设置和会话目录独立；CLI 本机登录由 SDK 复用。运行时显式绑定用户安装的 CLI，不下载替代版本。

## OpenCode

适配目标是 OpenCode 1.18.32 的 HTTP/SSE 接口，基于该版本 `/doc` 返回的 OpenAPI 1.0.0 形状实现。上游入口见 [官方 Server 文档](https://opencode.ai/docs/server/)。原始采集文件属于本地开发记录，没有包含在发布仓库中；可用自己的兼容 CLI 重新采集 `/doc` 核对。

## 历史实测与本轮验证

迁移前在 2026-10-29，CodeBuddy 和 Qoder 已使用本人账号完成真实 MCP 生命周期验收；OpenCode 路线也有较早的 MiniMax 受限实测记录。这些记录只说明当时指定安装、账号和模型下的结果，原始日志与数据库没有公开，也不能替代新用户的账号验证。

本次干净副本的实际验证结果单独记在 [VALIDATION.md](VALIDATION.md)。离线用例使用 fake SDK 和模拟服务，验证协议、审批、停止、恢复和数据边界；通过不代表任意账号或模型在线可用。

MCP 外部契约版本 2；配置 schema 版本 3；SQLite migration 版本 5。工具和字段以 `agent_capabilities` / `tools/list` 返回值为准。
