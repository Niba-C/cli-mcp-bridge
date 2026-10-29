# MCP 工具

后台运行后，客户端先查询能力和工作区，再提交任务。所有查询工具都不发起新的模型推理任务。

| 工具 | 用途 |
|---|---|
| `agent_capabilities` | 当前契约、serviceEpoch、后端、模型允许列表和限制 |
| `workspace_list` | 已登记且允许访问的工作区 |
| `agent_start` | 创建任务或继续原会话，返回稳定 runId |
| `agent_get` | 当前状态、sessionId 和 revision |
| `agent_wait` | 有界等待任务变化或终结 |
| `agent_events` | 分页读取事件 |
| `agent_result` | 分页读取结果、观测与验证记录 |
| `agent_interrupt` | 中断当前执行，保留会话 |
| `agent_cancel` | 取消任务 |
| `agent_sessions` | 列出会话 |
| `agent_close` | 关闭空闲会话，保留历史 |
| `artifact_read` | 按 artifactId 读取结果工件 |

## 提交与续接

```json
{
  "workspaceId": "<workspace_list 返回的 ID>",
  "prompt": "只读检查当前项目，列出发现的问题。",
  "clientRequestId": "review-example-001",
  "serviceEpoch": 1,
  "profile": "review",
  "backend": "qoder",
  "model": "<该后端允许列表中的原生模型 ID>"
}
```

`serviceEpoch` 必须取自本次 `agent_capabilities`。OpenCode 的 `model` 使用 `providerID/modelID`；CodeBuddy/Qoder 使用原生模型 ID。新会话省略 backend/model 使用配置默认；续接时传原 sessionId、省略 backend 继承绑定、省略 model 继承最近选择。跨后端续接会拒绝。

同一 `clientRequestId` 和相同参数重试返回原任务；改变参数会冲突。同一会话忙碌时拒绝追加。断连后查询原 runId，不自动重建任务。

## 等待与分页

```json
{
  "runs": [{"runId": "<runId>", "afterRevision": 1}],
  "returnWhen": "any_change",
  "timeoutMs": 20000
}
```

等待超时只结束等待，不取消任务。最多同时等待 8 个 run，单次最多 25 秒。

结果和工件单页最多 16000 个 Unicode 码点；用 `page.nextOffset` 翻页。事件用 `afterSeq` 翻页，单页最多 100 条。`agent_result.section` 可选 `agentReported`、`observed`、`verification`；省略时返回组合文本。

模型自述与实际观测、验证记录分开返回。`selectedModel` 是选择值，`observedModel` 来自后端消息，缺少证据时为 null。工件标注 `truncated`；`artifactStatus` 说明缺失和截断。文件变化工件是 hash 的 A/M/D 清单，不是逐行补丁。

## 停止与关闭

`agent_interrupt` / `agent_cancel` 要求 runId、clientRequestId、当前 run 的 expectedRevision 和 serviceEpoch；`agent_close` 使用 sessionId 及当前 session revision。停止未确认时按结果中的状态处理，不把超时或连接中断当作已取消。

当前明确拒绝 `profile="edit"`、非空 `contextArtifactIds` 和非默认任务 `timeoutMs`。调用方不能传路径、命令、环境变量或凭据；这些内容只由本机配置决定。完整 strict schema 以客户端 `tools/list` 为准。
