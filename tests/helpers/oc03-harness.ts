/**
 * OC-03 离线夹具：让真实 adapter 对着「模拟 OpenCode 服务子进程」跑。
 *
 * adapter 走的是与生产完全相同的路径：`spawn` 子进程 → 从自身 stdout 读地址 →
 * 独占进程组 → 临时 Basic 认证。区别只有 `testCommand` 指向模拟服务而不是
 * `/opt/homebrew/bin/opencode`，因此不会启动真实后端、不会调用模型。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ApprovalAnswer,
  BackendApprovalRequest,
  BackendEvent,
  BackendEventSink,
  BackendSessionRef,
} from "../../src/contracts/backend.ts";
import type { IsoTimestamp, Principal } from "../../src/contracts/common.ts";
import { OpenCodeHttpAdapter } from "../../src/backend/opencode/adapter.ts";
import type { ProcessTableRead } from "../../src/backend/opencode/worker.ts";
import { OpenCodeRunCoordinator } from "../../src/backend/opencode/coordinator.ts";
import { BridgeStore } from "../../src/storage/index.ts";
import { SESSION_ID, PRINCIPAL, admit, bootstrap, type Fixture } from "./storage-fixture.ts";

export const FAKE_SERVER = fileURLToPath(new URL("../fixtures/oc03-fake-opencode.ts", import.meta.url));
export const FAKE_SESSION_ID = "ses_fake0000000000000000000001";

export interface RequestRecord {
  readonly at: number;
  readonly route?: string;
  readonly body?: unknown;
  readonly event?: string;
  readonly reply?: string | null;
  readonly [key: string]: unknown;
}

export interface RecordingSink extends BackendEventSink {
  readonly events: BackendEvent[];
  readonly approvals: BackendEvent[];
  readonly texts: string[];
  readonly tools: string[];
}

export function recordingSink(answer: () => ApprovalAnswer = () => ({ decision: "allow_once", actor: "operator" })): RecordingSink {
  const events: BackendEvent[] = [];
  const approvals: BackendEvent[] = [];
  const texts: string[] = [];
  const tools: string[] = [];
  return {
    events,
    approvals,
    texts,
    tools,
    emit(event) {
      events.push(event);
      if (event.type === "approval_requested") approvals.push(event);
      if (event.type === "progress") texts.push(event.text);
      if (event.type === "tool") tools.push(`${event.tool.toolName}:${event.tool.phase}`);
    },
    async requestApproval() {
      return answer();
    },
    async requestInput() {
      return "unsupported";
    },
  };
}

export interface FixtureDirs {
  readonly root: string;
  readonly workspace: string;
  readonly runDir: string;
  readonly logPath: string;
  cleanup(): void;
}

export function makeDirs(scenario: string): FixtureDirs {
  const root = mkdtempSync(join(tmpdir(), `oc03-${scenario}-`));
  const workspace = join(root, "workspace");
  const runDir = join(root, "run");
  const logPath = join(root, "requests.jsonl");
  mkdirSync(workspace, { recursive: true });
  return {
    root,
    workspace,
    runDir,
    logPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function readRequests(logPath: string): RequestRecord[] {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RequestRecord);
  } catch {
    return [];
  }
}

export interface AdapterHarness {
  /** `skipSession: true` 时为 null（用于验证启动阶段拒绝）。 */
  readonly adapter: OpenCodeHttpAdapter;
  readonly session: BackendSessionRef | null;
  readonly dirs: FixtureDirs;
  readonly sink: RecordingSink;
  readonly logPath: string;
  requests(): RequestRecord[];
  /** 打开一个空的标记文件，避免子进程写不进去。 */
  marker(name: string): string;
  close(): Promise<void>;
}

export interface AdapterHarnessOptions {
  readonly scenario: string;
  readonly sink?: RecordingSink;
  readonly policyProfile?: "review" | "edit";
  readonly pollIntervalMs?: number;
  readonly permissionPollMs?: number;
  readonly stopGraceMs?: number;
  readonly stopSettleMs?: number;
  readonly approvalTimeoutMs?: number;
  readonly confirmTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly announceHost?: string;
  readonly serverEpoch?: number;
  /** 覆盖 minimax 供应商的配置对象（旧格式单供应商形状）。 */
  readonly providerConfig?: unknown;
  readonly logPathSuffix?: string;
  /** 只创建 adapter，不建会话：用于验证「启动/配置阶段就拒绝」。 */
  readonly skipSession?: boolean;
  /** 覆盖 createSession 的模型（不在允许列表的值用来证明启动前被拒）。 */
  readonly model?: { readonly providerID: string; readonly modelID: string };
  /** 模拟进程表不可读：验证「不能确认」的保守分支。 */
  readonly testProcessTable?: () => ProcessTableRead;
}

const TEST_PROVIDER_CONFIG = { options: { apiKey: "fake-test-key-not-real", baseURL: "http://127.0.0.1:1/v1" }, models: { "MiniMax-M3.1-Flash": { name: "MiniMax M3.1 Flash" } } };
const DEFAULT_MODEL = { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } as const;

export async function createAdapterHarness(options: AdapterHarnessOptions): Promise<AdapterHarness> {
  const dirs = makeDirs(options.scenario);
  const logPath = options.logPathSuffix === undefined ? dirs.logPath : `${dirs.logPath}.${options.logPathSuffix}`;
  writeFileSync(logPath, "");
  writeFileSync(join(dirs.workspace, "seed.txt"), "seed\n");
  const sink = options.sink ?? recordingSink();
  const args = [FAKE_SERVER, "--log", logPath, "--scenario", options.scenario];
  if (options.announceHost !== undefined) args.push("--announce-host", options.announceHost);
  const adapter = new OpenCodeHttpAdapter({
    executable: "/nonexistent/opencode-should-not-be-used",
    workspaceRoot: dirs.workspace,
    runDir: dirs.runDir,
    providerConfigs: { minimax: options.providerConfig ?? TEST_PROVIDER_CONFIG },
    modelProfiles: { default: { ...DEFAULT_MODEL } },
    policyProfile: options.policyProfile ?? "review",
    serverEpoch: options.serverEpoch ?? 1,
    pollIntervalMs: options.pollIntervalMs ?? 20,
    permissionPollMs: options.permissionPollMs ?? 20,
    stopGraceMs: options.stopGraceMs ?? 800,
    stopSettleMs: options.stopSettleMs ?? 400,
    approvalTimeoutMs: options.approvalTimeoutMs ?? 5_000,
    confirmTimeoutMs: options.confirmTimeoutMs ?? 2_000,
    startupTimeoutMs: options.startupTimeoutMs ?? 10_000,
    testCommand: { executable: process.execPath, args },
    ...(options.testProcessTable === undefined ? {} : { testProcessTable: options.testProcessTable }),
  });
  const session = options.skipSession === true
    ? null
    : await adapter.createSession({
        workspaceRoot: dirs.workspace,
        profile: options.policyProfile ?? "review",
        policyProfile: options.policyProfile ?? "review",
        model: options.model ?? { ...DEFAULT_MODEL },
        runDir: dirs.runDir,
      });
  return {
    adapter,
    session,
    dirs,
    sink,
    logPath,
    requests: () => readRequests(logPath),
    marker: (name: string) => join(dirs.workspace, name),
    close: async () => {
      try {
        await adapter.close();
      } catch {
        // 测试清理阶段忽略 close 的未确认错误；对应断言在用例内单独做。
      }
      dirs.cleanup();
    },
  };
}

export interface StoreHarnessOptions extends AdapterHarnessOptions {
  readonly prompt?: string;
  readonly deadlineMs?: number;
  readonly onApproval?: (request: BackendApprovalRequest) => Promise<ApprovalAnswer> | ApprovalAnswer;
  /** 用文件库而不是内存库：用于「另一个连接能看到实时证据」与崩溃窗口测试。 */
  readonly useFileDb?: boolean;
}

export interface StoreHarness {
  readonly store: BridgeStore;
  readonly fixture: Fixture;
  readonly adapter: OpenCodeHttpAdapter;
  readonly coordinator: OpenCodeRunCoordinator;
  readonly session: BackendSessionRef;
  readonly dirs: FixtureDirs;
  readonly logPath: string;
  /** 文件库路径；内存库时为 null。 */
  readonly dbPath: string | null;
  readonly principal: Principal;
  readonly prompt: string;
  readonly deadlineAt: IsoTimestamp;
  readonly warnings: string[];
  requests(): RequestRecord[];
  close(): Promise<void>;
}

/**
 * store + adapter + coordinator 的组合夹具。
 *
 * 关键顺序与生产一致：先 `beginServerInstance` 拿代际，再由 adapter 建会话，
 * 然后 `bindSessionBackend`，最后 `admitRun`。
 */
export async function createStoreHarness(options: StoreHarnessOptions): Promise<StoreHarness> {
  const dirs = makeDirs(options.scenario);
  writeFileSync(join(dirs.workspace, "seed.txt"), "seed\n");
  const logPath = options.logPathSuffix === undefined ? dirs.logPath : `${dirs.logPath}.${options.logPathSuffix}`;
  writeFileSync(logPath, "");
  const dbPath = options.useFileDb === true ? join(dirs.root, "bridge.sqlite") : null;
  const store = dbPath === null ? BridgeStore.openMemory() : BridgeStore.open(dbPath);
  const fixture = bootstrap(store, { profiles: ["review", "edit"], backendSessionId: null });
  const args = [FAKE_SERVER, "--log", logPath, "--scenario", options.scenario];
  if (options.announceHost !== undefined) args.push("--announce-host", options.announceHost);
  const adapter = new OpenCodeHttpAdapter({
    executable: "/nonexistent/opencode-should-not-be-used",
    workspaceRoot: dirs.workspace,
    runDir: dirs.runDir,
    providerConfigs: { minimax: options.providerConfig ?? TEST_PROVIDER_CONFIG },
    modelProfiles: { default: { ...DEFAULT_MODEL } },
    policyProfile: options.policyProfile ?? "review",
    serverEpoch: fixture.serverEpoch,
    pollIntervalMs: options.pollIntervalMs ?? 20,
    permissionPollMs: options.permissionPollMs ?? 20,
    stopGraceMs: options.stopGraceMs ?? 800,
    stopSettleMs: options.stopSettleMs ?? 400,
    approvalTimeoutMs: options.approvalTimeoutMs ?? 5_000,
    confirmTimeoutMs: options.confirmTimeoutMs ?? 2_000,
    startupTimeoutMs: options.startupTimeoutMs ?? 10_000,
    testCommand: { executable: process.execPath, args },
    ...(options.testProcessTable === undefined ? {} : { testProcessTable: options.testProcessTable }),
  });
  const session = await adapter.createSession({
    workspaceRoot: dirs.workspace,
    profile: options.policyProfile ?? "review",
    policyProfile: options.policyProfile ?? "review",
    model: { ...DEFAULT_MODEL },
    runDir: dirs.runDir,
  });
  store.bindSessionBackend(SESSION_ID, session.backendSessionId, session.serverEpoch);
  const warnings: string[] = [];
  const coordinator = new OpenCodeRunCoordinator(store, adapter, {
    onWarning: (message: string) => warnings.push(message),
    ...(options.onApproval === undefined ? {} : { onApproval: options.onApproval }),
  });
  const prompt = options.prompt ?? "只回复 READY";
  const deadlineAt = new Date(Date.now() + (options.deadlineMs ?? 10_000)).toISOString();
  return {
    store,
    fixture,
    adapter,
    coordinator,
    session,
    dirs,
    logPath,
    dbPath,
    principal: PRINCIPAL,
    prompt,
    deadlineAt,
    warnings,
    requests: () => readRequests(logPath),
    close: async () => {
      try {
        await adapter.close();
      } catch {
        // 忽略：用例内已断言 close 的失败语义。
      }
      store.close();
      dirs.cleanup();
    },
  };
}

/** 仅用于在 store 夹具里受理 run（保证 deadlineAt 与 coordinator 一致）。 */
export function admitForRun(
  harness: StoreHarness,
  input: { readonly clientRequestId: string; readonly prompt?: string; readonly deadlineAt?: IsoTimestamp },
) {
  return admit(harness.store, harness.fixture, {
    clientRequestId: input.clientRequestId,
    prompt: input.prompt ?? harness.prompt,
    deadlineAt: input.deadlineAt ?? harness.deadlineAt,
  });
}
