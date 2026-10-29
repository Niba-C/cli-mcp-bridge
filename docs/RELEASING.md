# 源码发布

本目录用于发布独立源码仓库。没有复制开发仓库的历史、node_modules、账号配置、原始证据或第三方源码归档。

## 本地检查

```sh
npm ci --ignore-scripts
npm test
npm run check:release
npm pack --dry-run --ignore-scripts
```

`package.json.files` 是安装包文件白名单；GitHub 则以实际提交文件为准，两者分别审阅。发布前检查 `git status --short`，不要使用 `git add -f` 纳入私有文件。

创建 GitHub 空仓库后，用本人确认的远端地址添加 remote、提交并推送；上传前启用 GitHub 可用的 Secret scanning / Push protection 和私密漏洞报告。不要把 token 放进 remote URL。CI 工作流不会执行真实模型测试或上传原始日志。

当前 `private: true` 防止误发 npm，不影响 Apache-2.0 或 GitHub 源码公开。npm 名称尚未确认占用；如果以后发布 npm，先确认名称或使用本人 scope，再移除 private 并核对打包文件。不要在 GitHub 发布说明中提供尚不存在的 npm 安装命令。

源码压缩包只从已审查的文件清单生成，排除 `.git`、`node_modules`、`.local`、`.tmp` 和运行配置。不把依赖 SDK/CLI/模型文件打入 Release。

## 版本与条款

发布变更时同步 package.json、lockfile 根信息、src/contracts/version.ts、CHANGELOG.md；只有外部字段语义变化才递增 contractVersion。依赖升级需重新核对 SDK 许可及 CLI 兼容性。公开第三方服务说明记录核对日期；按实际账号、地区和部署方式复核条款。

本项目支持本机个人使用的官方集成方式。云端托管、多人共享个人账号或额度不属于当前发布范围，相关授权不能由本项目开源许可证替代。
