# 第三方服务

核对日期：2026-10-29。本项目提供本机 MCP 协议适配代码，不提供第三方账号、密钥、订阅或 Credits，也不运行共享额度服务。用户使用自己的合法账号；输入代码、任务内容和输出按对应 SDK/CLI 的机制与服务商交互。

| 服务 | 本项目入口 | 官方文档及条款 |
|---|---|---|
| CodeBuddy | 官方 Agent SDK + 本机 CLI，复用已登录账号 | [SDK](https://www.codebuddy.cn/docs/cli/sdk)、[中国版协议](https://www.codebuddy.cn/agreement/)、[国际版协议](https://www.codebuddy.ai/document/term) |
| Qoder | 官方 Agent SDK + 本机 CLI，本机登录或本人 PAT | [SDK](https://docs.qoder.com/cli/sdk/overview)、[认证](https://docs.qoder.com/cli/sdk/authentication)、[SDK 许可指向的服务条款](https://qoder.com/product-service)、[使用规则](https://docs.qoder.com/qoder/model-selector) |
| OpenCode | 用户安装的官方 CLI，本机 HTTP/SSE 服务 | [Server](https://opencode.ai/docs/server/)、[上游项目](https://github.com/anomalyco/opencode)；实际模型服务还受所选供应商条款约束 |

CodeBuddy 的账号许可和合理使用规则、Qoder 的个人账号/免费权益及转供限制，独立于本项目开源许可证。自动化集成不代表可以共享个人账号、向他人提供个人额度、绕过限额或自动制造促销活动。API/SDK 正常调用也不构成获取活跃奖励的保证。

免费活动、模型可用性和定价可能变化。这里不承诺任何模型永久免费；按用户账号当前展示、适用地区及服务商规则使用。部署给其他人调用或改成共享服务前，需要另行确认服务商授权，不能从 Apache-2.0 推导第三方服务授权。

Qoder SDK 自身采用服务条款许可；CodeBuddy SDK 的本机包声明 MIT。它们都由用户从官方渠道安装；本项目许可证不重新授权这些包或在线服务。发布包不包含 SDK 副本、CLI 二进制或模型文件。

本文件说明服务关系和当前支持范围，不给 Apache-2.0 添加商用、用途或用户身份限制，也不授予第三方商标或服务使用权。
