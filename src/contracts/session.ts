/**
 * 产品会话 DTO 与后端绑定规则（技术规格 §2）。
 *
 * 三种 session 标识必须分开：
 * - sessionId            产品逻辑会话（ses_<uuid>）
 * - mcpTransportSessionId 传输会话，只属于一次 MCP 连接，不进业务库语义
 * - backendSessionId     OpenCode 返回的会话 ID，与产品 session 分开存
 *
 * 这里不保留 ZCode 时期的「懒占位」假设：OpenCode 的 POST /session 立即返回
 * 真实会话 ID，产品会话在绑定前就是未绑定（backendSessionId=null），
 * 不存在「先给一个占位 ID、首次 prompt 才物化」的状态。
 *
 * 每条后端绑定必须同时带 serverEpoch：同一条 OpenCode session ID 在不同服务
 * 启动之间不保证语义相同，缺少代际就无法判断审批和在途状态是否还有效。
 */
import type { SessionId, WorkspaceId } from "./ids.ts";
import type { IsoTimestamp } from "./common.ts";
import type { WorkspaceProfile } from "./workspace.ts";
import type { BackendId } from "./version.ts";

export const SESSION_STATES = ["idle", "busy", "unavailable", "closed"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** 恢复验证独立于「是否已绑定后端」；未验证的恢复不得对外宣传。 */
export const RECOVERY_VERIFICATIONS = ["unverified", "verified", "unavailable"] as const;
export type RecoveryVerification = (typeof RECOVERY_VERIFICATIONS)[number];

/** 没有证据时的恢复等级；默认值只有一个来源，避免各处自行写 "verified"。 */
export const UNVERIFIED_RECOVERY: RecoveryVerification = "unverified";

export interface Session {
  readonly sessionId: SessionId;
  readonly ownerId: string;
  readonly workspaceId: WorkspaceId;
  /** 创建会话时的 workspace generation 快照。 */
  readonly workspaceGeneration: number;
  readonly profile: WorkspaceProfile;
  /**
   * OC-09：会话固定归属的后端；创建后不可变更（新请求显式跨 CLI 返回
   * backend_session_mismatch）。migration v5 之前的行确定标记 opencode。
   */
  readonly backendId: BackendId;
  /** 未绑定时为 null；存在时必须与 serverEpoch 成对出现。 */
  readonly backendSessionId: string | null;
  /** 创建该后端会话的服务代际；未绑定时为 null。 */
  readonly serverEpoch: number | null;
  readonly recoveryVerification: RecoveryVerification;
  readonly state: SessionState;
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface SessionSummary {
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly profile: WorkspaceProfile;
  /** OC-09：会话的后端归属。 */
  readonly backendId: BackendId;
  readonly state: SessionState;
  readonly recoveryVerification: RecoveryVerification;
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface BackendSessionBinding {
  readonly backendSessionId: string;
  readonly serverEpoch: number;
}

export type BindBackendSessionResult =
  | { readonly ok: true; readonly binding: BackendSessionBinding | null }
  | { readonly ok: false; readonly reason: string };

/**
 * 校验并构造后端会话绑定。
 *
 * 允许「两个都为 null」（产品会话尚未在后端建立），但拒绝只出现其中一个：
 * 单独保存 backendSessionId 会让重启后的归属判断失去依据，单独保存 serverEpoch
 * 则无从定位会话。这里也不做任何「看起来像 ses_ 就当同一条」的推断。
 */
export function bindBackendSession(
  backendSessionId: string | null,
  serverEpoch: number | null,
): BindBackendSessionResult {
  if (backendSessionId === null && serverEpoch === null) return { ok: true, binding: null };
  if (backendSessionId === null) return { ok: false, reason: "serverEpoch 存在但 backendSessionId 为空" };
  if (serverEpoch === null) return { ok: false, reason: "backendSessionId 存在但缺少 serverEpoch" };
  if (backendSessionId.trim().length === 0) return { ok: false, reason: "backendSessionId 不能是空白字符串" };
  if (!Number.isInteger(serverEpoch) || serverEpoch < 1) {
    return { ok: false, reason: "serverEpoch 必须是 ≥1 的整数" };
  }
  return { ok: true, binding: { backendSessionId, serverEpoch } };
}

/**
 * 恢复能力只能由证据升级。没有证据引用时一律 unverified；
 * "unavailable" 表示后端明确不支持恢复，不能由这个函数推导。
 */
export function recoveryVerificationFrom(evidenceRef: string | null | undefined): RecoveryVerification {
  return evidenceRef !== null && evidenceRef !== undefined && evidenceRef.trim().length > 0
    ? "verified"
    : UNVERIFIED_RECOVERY;
}
