# 测试

## 离线验证

```sh
npm ci --ignore-scripts
npm test
npm run check:release
```

`npm test` 顺序执行 typecheck、lint、unit、integration、fault、security；不启动真实模型。集成测试会启动本机模拟服务、SDK worker 与 Unix socket，使用临时数据库；工作区因路径规则放在用户目录下的专用 `.opencode-bridge-*` 测试目录，用例清理自己创建的子目录。

`npm run test:soak` 为单独的长时测试，不属于默认套件。测试目录中的 fake key/token 是固定假值，不可用于任何服务。

`check:release` 检查源码发布目录、包身份、依赖锁文件、私有文件模式和若干高置信凭据模式。它不联网，不读取用户账号配置，也不能识别所有服务商 token 或替代人工审查。上传后建议再开启 GitHub Secret scanning / Push protection 和私密漏洞报告；这些是仓库设置，不由本地脚本自动开启。

## 真实模型验收

真实测试会消耗本人账号资源，默认关闭；本次发布整理不执行真实调用。普通 CI 只运行离线测试。

CodeBuddy / Qoder：

```sh
ZB_OC09_LIVE=1 npm run test:oc09-live -- \
  --backend qoder --executable /absolute/path/to/qodercli --model YOUR_MODEL_ID --smoke
```

需要已登录且版本兼容的官方 CLI。`--smoke` 提交一个任务；去掉它运行包含续聊、重连、重启、中断、取消、关闭的完整场景，脚本限制最多 7 个任务，完整正常路径提交 6 个。CodeBuddy 将 backend 换为 codebuddy 并使用对应路径及本人账号的模型 ID。模型是否收费由服务商决定。

OpenCode / MiniMax 的受限入口：

```sh
ZB_OC03_LIVE=1 npm run test:oc03-live -- \
  --opencode /absolute/path/to/opencode \
  --provider-config /absolute/private/minimax-provider.json \
  --out .local/live/opencode
```

该入口固定 MiniMax 供应商，最多 8 个用户轮次；供应商或模型错误会停止。通用 `npm run test:live` 始终拒绝，要求选择具体入口。

验收产生的日志、数据库、工件和配置只留本机，不上传到 Issue、GitHub Actions artifact 或 Release；报告问题只提供版本、错误码、复现步骤和脱敏摘要。
