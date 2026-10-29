/**
 * OC-02 测试夹具：内存/临时文件库、固定 ID、最小实体。
 *
 * 所有测试都使用临时目录或 `:memory:`；不启动 OpenCode、不发起网络请求。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../../src/contracts/common.ts";
import { newId } from "../../src/contracts/ids.ts";
import type { RunId, SessionId, WorkspaceId } from "../../src/contracts/ids.ts";
import type { WorkspaceProfile } from "../../src/contracts/index.ts";
import { BridgeStore, defaultIdFactory, type IdFactory, type SessionRecord } from "../../src/storage/index.ts";

export const T0 = "2026-01-01T00:00:00.000Z";
export const T1 = "2026-01-01T00:00:01.000Z";
export const T2 = "2026-01-01T00:00:02.000Z";
export const T3 = "2026-01-01T00:00:03.000Z";
export const T4 = "2026-01-01T00:00:04.000Z";
export const T5 = "2026-01-01T00:00:05.000Z";
export const DEADLINE = "2026-01-01T00:15:00.000Z";

export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export const PRINCIPAL_ID = newId("principal", uuid(1));
export const OTHER_PRINCIPAL_ID = newId("principal", uuid(2));
export const WORKSPACE_ID = newId("workspace", uuid(3));
export const SESSION_ID = newId("session", uuid(4));
export const SESSION_B_ID = newId("session", uuid(5));

export const PRINCIPAL: Principal = {
  principalId: PRINCIPAL_ID,
  allowedWorkspaces: [WORKSPACE_ID],
  role: "owner",
};

export const OTHER_PRINCIPAL: Principal = {
  principalId: OTHER_PRINCIPAL_ID,
  allowedWorkspaces: [WORKSPACE_ID],
  role: "owner",
};

/** 可预测的自增 ID，便于断言同一/不同实体。 */
export function sequentialIds(start = 100): IdFactory {
  let next = start;
  const value = (): string => uuid(next++);
  return {
    workspace: () => newId("workspace", value()),
    session: () => newId("session", value()),
    run: () => newId("run", value()),
    approval: () => newId("approval", value()),
    artifact: () => newId("artifact", value()),
    attempt: () => `att_${value()}`,
    manifest: () => `res_${value()}`,
  };
}

export function fixedIds(overrides: Partial<IdFactory> = {}): IdFactory {
  return { ...defaultIdFactory, ...sequentialIds(), ...overrides };
}

export interface TempDb {
  readonly dir: string;
  readonly path: string;
  cleanup(): void;
}

export function makeTempDb(prefix = "oc02-"): TempDb {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    path: join(dir, "bridge.sqlite"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface Fixture {
  readonly store: BridgeStore;
  readonly serviceEpoch: number;
  readonly serverEpoch: number;
  readonly workspaceId: WorkspaceId;
  readonly session: SessionRecord;
  readonly principal: Principal;
}

export interface BootstrapOptions {
  readonly at?: string;
  readonly ownerId?: Principal["principalId"];
  readonly sessionId?: SessionId;
  readonly profiles?: readonly WorkspaceProfile[];
  /** 传 null 表示保持未绑定（OC-03 由 adapter 先建后端会话再绑定）。 */
  readonly backendSessionId?: string | null;
}

/**
 * 建立 service → server → workspace → session →（可选）绑定。
 * session 的 workspace generation 与 workspace 当前 generation 一致。
 */
export function bootstrap(store: BridgeStore, options: BootstrapOptions = {}): Fixture {
  const at = options.at ?? T0;
  const service = store.beginService({ at });
  const server = store.beginServerInstance({ serviceEpoch: service.serviceEpoch, at });
  const workspace = store.createWorkspace({
    workspaceId: WORKSPACE_ID,
    name: "oc02-fixture",
    canonicalRoot: "/tmp/oc02-fixture",
    profiles: options.profiles ?? ["review", "edit"],
    at,
  });
  const session = store.createSession({
    sessionId: options.sessionId ?? SESSION_ID,
    ownerId: options.ownerId ?? PRINCIPAL.principalId,
    workspaceId: workspace.workspaceId,
    profile: "review",
    at,
  });
  const backendSessionId = options.backendSessionId === undefined ? "oc-backend-1" : options.backendSessionId;
  const bound =
    backendSessionId === null
      ? session
      : store.bindSessionBackend(session.sessionId, backendSessionId, server.serverEpoch, at);
  return {
    store,
    serviceEpoch: service.serviceEpoch,
    serverEpoch: server.serverEpoch,
    workspaceId: workspace.workspaceId,
    session: bound,
    principal: options.ownerId === undefined ? PRINCIPAL : { ...PRINCIPAL, principalId: options.ownerId },
  };
}

export interface AdmitOptions {
  readonly principal?: Principal;
  readonly sessionId?: SessionId;
  readonly toolName?: string;
  readonly clientRequestId?: string;
  readonly serviceEpoch?: number;
  readonly prompt?: string;
  readonly profile?: WorkspaceProfile;
  readonly deadlineAt?: string;
  /** OC-08：受理时解析的完整模型标识；默认固定 MiniMax（与历史实现一致）。 */
  readonly model?: string;
  /** OC-09：受理归属的后端；测试夹具默认 opencode。 */
  readonly backend?: "opencode" | "codebuddy" | "qoder";
}

export function admit(store: BridgeStore, fixture: Fixture, options: AdmitOptions = {}) {
  return store.admitRun({
    principal: options.principal ?? fixture.principal,
    sessionId: options.sessionId ?? fixture.session.sessionId,
    toolName: options.toolName ?? "agent_start",
    clientRequestId: options.clientRequestId ?? "req-1",
    serviceEpoch: options.serviceEpoch ?? fixture.serviceEpoch,
    prompt: options.prompt ?? "总结这个仓库的入口",
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    backend: options.backend ?? "opencode",
    deadlineAt: options.deadlineAt ?? DEADLINE,
    model: options.model ?? "minimax/MiniMax-M3.1-Flash",
  });
}

/** queued → starting → running → draining；用于完成/结果测试。 */
export function driveToDraining(store: BridgeStore, runId: RunId, at = T2): void {
  store.transitionRun(runId, "starting", { at });
  store.transitionRun(runId, "running", { at });
  store.transitionRun(runId, "draining", { at });
}
