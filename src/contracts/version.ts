/**
 * 对外契约版本。任何 DTO / 工具 schema / 错误码语义变化都必须改这里，
 * 并同步 docs/技术规格.md 与 docs/adr/0006-OpenCode路线.md。
 *
 * "2" 是 MCP 工具结果里 `contractVersion` 字段唯一允许的取值（技术规格 §9）。
 * v2（OC-09）：agent_start 增加可选 backend；能力/回执/查询输出增加
 * defaultBackend、backends[] 与 backendId 归属字段；配置 schemaVersion=3、
 * SQLite migration v5 同期生效。宿主需重载 MCP 取得新 schema。
 * 注意：内部后端 DTO 与配置 schema 的迁移不自动改变外部 wire contract；
 * `CONFIG_SCHEMA_VERSION` 单独版本化，两者不联动。
 */
export const CONTRACT_VERSION = "2" as const;
export type ContractVersion = typeof CONTRACT_VERSION;

/** 产品自身的标识，与契约版本无关；当前尚未发布。 */
export const PRODUCT_NAME = "cli-mcp-bridge";
export const PRODUCT_DISPLAY_NAME = "CLI MCP Bridge";
export const PRODUCT_VERSION = "0.1.0";

/** 兼容命令名：工作区目录、可执行入口和旧脚本仍可用 `zbridge`。 */
export const CLI_NAME = "cli-mcp-bridge";

/** 配置文件的 schemaVersion。不兼容变更必须递增并拒绝旧文件启动。 */
export const CONFIG_SCHEMA_VERSION = 3;

/**
 * OC-09 固定的三个产品后端 ID。每种最多登记一个实例，不开放别名。
 * 旧数据（migration v5 之前）一律归属 opencode。
 */
export const BACKEND_IDS = ["opencode", "codebuddy", "qoder"] as const;
export type BackendId = (typeof BACKEND_IDS)[number];

export function isBackendId(value: unknown): value is BackendId {
  return typeof value === "string" && (BACKEND_IDS as readonly string[]).includes(value);
}

/** 受控 adapter 标识；每个后端 ID 只对应一个 adapter，不做插件框架。 */
export const OPENCODE_ADAPTER_ID = "opencode-http";
export const CODEBUDDY_ADAPTER_ID = "codebuddy-sdk";
export const QODER_ADAPTER_ID = "qoder-sdk";

export const ADAPTER_BY_BACKEND: Readonly<Record<BackendId, string>> = {
  opencode: OPENCODE_ADAPTER_ID,
  codebuddy: CODEBUDDY_ADAPTER_ID,
  qoder: QODER_ADAPTER_ID,
};

/**
 * 与兼容性基线一致的 OpenCode 版本。升级须重跑兼容探针后同时改这里与样例配置。
 * v3 配置里 opencode.pinnedVersion 仍锁定该值。
 */
export const OPENCODE_PINNED_VERSION = "1.18.32";

/**
 * OC-09-00（2026-10-25）锁定的 SDK/CLI 组合：
 * - @tencent-ai/agent-sdk 0.3.291 + 本机 codebuddy 2.173.0（homebrew 原生二进制，
 *   经受控 .exe 绑定触发 SDK directExecute；SDK 包内自带 CLI 是 2.176.0，不可用）；
 * - @qoder-ai/qoder-agent-sdk 1.0.56（qoderCliVersion=1.1.78）+ 本机 qodercli 1.1.78。
 * 版本范围与验证边界见 docs/COMPATIBILITY.md。
 */
export const CODEBUDDY_PINNED_CLI_VERSION = "2.173.0";
export const QODER_PINNED_CLI_VERSION = "1.1.78";
export const CODEBUDDY_SDK_VERSION = "0.3.291";
export const QODER_SDK_VERSION = "1.0.56";

/** 本骨架冻结时锁定的运行时基线（docs/compatibility/基线.md §1）。 */
export const NODE_BASELINE = "24.18.0";
