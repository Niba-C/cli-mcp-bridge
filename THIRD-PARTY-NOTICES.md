# 第三方依赖与许可声明

核对日期：2026-10-29。下表来自本发布候选的 package-lock.json，列出所有直接、传递、开发及平台可选依赖；不是仅列出本机安装成功的子集。

本仓库与源码压缩包不包含 node_modules、第三方 SDK 源码、CLI 二进制或模型。依赖由用户自行从官方 npm 源安装，许可和版权声明保留在对应安装包中。下表为依赖清单，不把第三方内容重新授权为 Apache-2.0。

## 直接运行依赖

| 包 | 版本 | 许可 |
|---|---|---|
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT |
| `@qoder-ai/qoder-agent-sdk` | 1.0.56 | SEE LICENSE IN LICENSE |
| `@tencent-ai/agent-sdk` | 0.3.291 | MIT |
| `zod` | 4.6.7 | MIT |

Qoder SDK 的 LICENSE 指向 [Qoder 服务条款](https://qoder.com/product-service)，并非标准开源许可；本项目 Apache-2.0 不授予该 SDK 的再分发或服务转授权。CodeBuddy SDK 的 package.json 声明 MIT。许可证原文保留副本见 docs/licenses/，其中 CodeBuddy 文本来自该 SDK 包内 cli/LICENSE.txt，来源范围按文件标注，不推导在线服务授权。

## 锁文件完整清单

| 包 / 安装位置 | 版本 | 包声明许可 | 范围 |
|---|---|---|---|
| `@agentclientprotocol/sdk` | 1.9.0 | Apache-2.0 | 运行 |
| `@hono/node-server` | 2.1.5 | MIT | 运行 |
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT | 运行 |
| `@oxlint/binding-android-arm-eabi` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@oxlint/binding-android-arm64` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@oxlint/binding-darwin-arm64` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@oxlint/binding-darwin-x64` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@oxlint/binding-freebsd-x64` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@oxlint/binding-linux-arm-gnueabihf` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@oxlint/binding-linux-arm-musleabihf` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@oxlint/binding-linux-arm64-gnu` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@oxlint/binding-linux-arm64-musl` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@oxlint/binding-linux-ppc64-gnu` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@oxlint/binding-linux-riscv64-gnu` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@oxlint/binding-linux-riscv64-musl` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@oxlint/binding-linux-s390x-gnu` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@oxlint/binding-linux-x64-gnu` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@oxlint/binding-linux-x64-musl` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@oxlint/binding-openharmony-arm64` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@oxlint/binding-win32-arm64-msvc` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@oxlint/binding-win32-ia32-msvc` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@oxlint/binding-win32-x64-msvc` | 1.89.0 | MIT | 开发 / 平台可选 |
| `@qoder-ai/qoder-agent-sdk` | 1.0.56 | SEE LICENSE IN LICENSE | 运行 |
| `@tencent-ai/agent-sdk` | 0.3.291 | MIT | 运行 |
| `@types/node` | 24.10.1 | MIT | 开发 |
| `accepts` | 2.0.0 | MIT | 运行 |
| `ajv` | 8.20.0 | MIT | 运行 |
| `ajv-formats` | 3.0.1 | MIT | 运行 |
| `body-parser` | 2.3.0 | MIT | 运行 |
| `body-parser/node_modules/content-type` | 2.1.0 | MIT | 运行 |
| `bytes` | 3.1.2 | MIT | 运行 |
| `call-bind-apply-helpers` | 1.0.2 | MIT | 运行 |
| `call-bound` | 1.0.4 | MIT | 运行 |
| `content-disposition` | 2.0.1 | MIT | 运行 |
| `content-type` | 1.0.5 | MIT | 运行 |
| `cookie` | 0.7.2 | MIT | 运行 |
| `cookie-signature` | 1.2.2 | MIT | 运行 |
| `cors` | 2.8.6 | MIT | 运行 |
| `cross-spawn` | 7.0.6 | MIT | 运行 |
| `debug` | 4.4.3 | MIT | 运行 |
| `depd` | 2.0.0 | MIT | 运行 |
| `dunder-proto` | 1.0.1 | MIT | 运行 |
| `ee-first` | 1.1.1 | MIT | 运行 |
| `encodeurl` | 2.0.0 | MIT | 运行 |
| `es-define-property` | 1.0.1 | MIT | 运行 |
| `es-errors` | 1.3.0 | MIT | 运行 |
| `es-object-atoms` | 1.1.2 | MIT | 运行 |
| `escape-html` | 1.0.3 | MIT | 运行 |
| `etag` | 1.8.1 | MIT | 运行 |
| `eventsource` | 3.0.7 | MIT | 运行 |
| `eventsource-parser` | 3.1.1 | MIT | 运行 |
| `express` | 5.3.0 | MIT | 运行 |
| `express-rate-limit` | 8.7.1 | MIT | 运行 |
| `express/node_modules/content-type` | 2.1.0 | MIT | 运行 |
| `fast-deep-equal` | 3.1.3 | MIT | 运行 |
| `fast-uri` | 3.1.9 | BSD-3-Clause | 运行 |
| `finalhandler` | 2.1.1 | MIT | 运行 |
| `forwarded` | 0.2.0 | MIT | 运行 |
| `fresh` | 2.0.0 | MIT | 运行 |
| `function-bind` | 1.1.2 | MIT | 运行 |
| `get-intrinsic` | 1.3.0 | MIT | 运行 |
| `get-proto` | 1.0.1 | MIT | 运行 |
| `gopd` | 1.2.0 | MIT | 运行 |
| `has-symbols` | 1.1.0 | MIT | 运行 |
| `hasown` | 2.0.4 | MIT | 运行 |
| `hono` | 4.13.13 | MIT | 运行 |
| `http-errors` | 2.0.1 | MIT | 运行 |
| `iconv-lite` | 0.7.3 | MIT | 运行 |
| `inherits` | 2.0.4 | ISC | 运行 |
| `ip-address` | 10.7.4 | MIT | 运行 |
| `ipaddr.js` | 1.9.1 | MIT | 运行 |
| `is-promise` | 4.0.0 | MIT | 运行 |
| `isexe` | 2.0.0 | ISC | 运行 |
| `jose` | 6.2.13 | MIT | 运行 |
| `json-schema-traverse` | 1.0.0 | MIT | 运行 |
| `json-schema-typed` | 8.0.2 | BSD-2-Clause | 运行 |
| `math-intrinsics` | 1.1.0 | MIT | 运行 |
| `media-typer` | 1.1.1 | MIT | 运行 |
| `merge-descriptors` | 2.0.0 | MIT | 运行 |
| `mime-db` | 1.54.0 | MIT | 运行 |
| `mime-types` | 3.0.2 | MIT | 运行 |
| `ms` | 2.1.3 | MIT | 运行 |
| `negotiator` | 1.1.0 | MIT | 运行 |
| `negotiator/node_modules/content-type` | 2.1.0 | MIT | 运行 |
| `object-assign` | 4.1.1 | MIT | 运行 |
| `object-inspect` | 1.13.4 | MIT | 运行 |
| `on-finished` | 2.4.1 | MIT | 运行 |
| `once` | 1.4.0 | ISC | 运行 |
| `oxlint` | 1.89.0 | MIT | 开发 |
| `parseurl` | 1.3.3 | MIT | 运行 |
| `path-key` | 3.1.1 | MIT | 运行 |
| `path-to-regexp` | 8.4.2 | MIT | 运行 |
| `pkce-challenge` | 5.0.1 | MIT | 运行 |
| `proxy-addr` | 2.0.8 | MIT | 运行 |
| `qs` | 6.16.1 | BSD-3-Clause | 运行 |
| `range-parser` | 1.3.0 | MIT | 运行 |
| `raw-body` | 3.0.2 | MIT | 运行 |
| `require-from-string` | 2.0.2 | MIT | 运行 |
| `router` | 2.2.0 | MIT | 运行 |
| `safer-buffer` | 2.1.2 | MIT | 运行 |
| `send` | 1.2.1 | MIT | 运行 |
| `serve-static` | 2.2.1 | MIT | 运行 |
| `setprototypeof` | 1.2.0 | ISC | 运行 |
| `shebang-command` | 2.0.0 | MIT | 运行 |
| `shebang-regex` | 3.0.0 | MIT | 运行 |
| `side-channel` | 1.1.1 | MIT | 运行 |
| `side-channel-list` | 1.0.1 | MIT | 运行 |
| `side-channel-map` | 1.0.1 | MIT | 运行 |
| `side-channel-weakmap` | 1.0.2 | MIT | 运行 |
| `statuses` | 2.0.2 | MIT | 运行 |
| `toidentifier` | 1.0.1 | MIT | 运行 |
| `type-is` | 2.1.0 | MIT | 运行 |
| `type-is/node_modules/content-type` | 2.1.0 | MIT | 运行 |
| `typescript` | 5.9.3 | Apache-2.0 | 开发 |
| `undici-types` | 7.16.0 | MIT | 开发 |
| `unpipe` | 1.0.0 | MIT | 运行 |
| `uuidv7` | 1.2.1 | Apache-2.0 | 运行 |
| `vary` | 1.1.2 | MIT | 运行 |
| `which` | 2.0.2 | ISC | 运行 |
| `wrappy` | 1.0.2 | ISC | 运行 |
| `zod` | 4.6.7 | MIT | 运行 |
| `zod-to-json-schema` | 3.25.2 | ISC | 运行 |

这些包声明中的 MIT、Apache-2.0、ISC、BSD 等许可仍分别适用。若将来把依赖代码或二进制打入安装包，需按实际包含内容补齐对应许可证、版权和 NOTICE；当前发布白名单不打包依赖。

## 外部 CLI 与服务

CodeBuddy、Qoder、OpenCode 由用户从官方渠道自行安装，CLI 本身没有包含在本发布内容中。版本与官方入口见 [兼容性](docs/COMPATIBILITY.md)，认证与服务条款见 [第三方服务](THIRD_PARTY_SERVICES.md)。

## 历史参考

开发阶段参考过以下公开项目的接口设计：coder-mcp-bridge、mcp-acp-bridge、mcp-agent-bridge、mcp-agents、acp-mcp-server、zcode-open-bridge 及 zcode-acp。历史源码镜像和旧 ZCode 路线不包含在本目录中，也不是当前运行依赖。未来复制实际代码时需逐文件核对许可与版权，不能以设计参考记录代替授权。
