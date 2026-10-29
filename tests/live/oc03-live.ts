/**
 * OC-03 受限真机入口（**默认拒绝**，不在 `npm test` 里）。
 *
 * 它调用的是产品 adapter + coordinator + BridgeStore，而不是另写一套探针：
 * 因此验证的是「产品代码能不能跑真实后端」，不是「HTTP 能不能通」。
 *
 * 只允许 MiniMax：供应商配置由主执行者在运行时用 `--provider-config` 指向一个
 * 只含 `minimax` 的 JSON 文件（该文件不进入证据，也不打印）。本脚本从不读取
 * 用户全局配置，也不接受通过参数传入 URL 或密钥。
 *
 * 用法（由主执行者执行）：
 *   ZB_OC03_LIVE=1 node tests/live/oc03-live.ts \
 *     --provider-config /abs/path/minimax-provider.json \
 *     [--opencode /opt/homebrew/bin/opencode] [--out .local/live/opencode/<stamp>]
 *
 * 预算：最多 8 个用户轮次；单轮等待 ≤120s；整体 ≤20min。任一供应商/模型错误立即停止。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OpenCodeHttpAdapter } from "../../src/backend/opencode/adapter.ts";
import { OpenCodeRunCoordinator } from "../../src/backend/opencode/coordinator.ts";
import {
  LEGACY_MODEL_ID,
  LEGACY_PROVIDER_ID,
  collectSecretValues,
  redactSecrets,
} from "../../src/backend/opencode/profile.ts";
import type { ApprovalAnswer, BackendApprovalRequest } from "../../src/contracts/backend.ts";
import { OPENCODE_PINNED_VERSION } from "../../src/contracts/version.ts";
import { BridgeStore } from "../../src/storage/index.ts";
import { newId } from "../../src/contracts/ids.ts";

const REFUSED = 3;
const PRECONDITION = 4;

const MAX_USER_TURNS = 8;
const TURN_TIMEOUT_MS = 120_000;
const TOTAL_TIMEOUT_MS = 20 * 60_000;

function refuse(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(REFUSED);
}

if (process.env["ZB_OC03_LIVE"] !== "1") {
  refuse(
    [
      "拒绝执行：真实后端调用默认关闭。",
      "本入口会启动真实 opencode serve 并调用 MiniMax（需要主执行者提供的受控供应商配置）。",
      `如确需执行，请设置 ZB_OC03_LIVE=1，并传入 --provider-config（只含 ${LEGACY_PROVIDER_ID} 的 JSON 文件）。`,
      "普通测试请用 npm test：它完全离线，不启动 OpenCode、不调用模型。",
      "",
    ].join("\n"),
  );
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

function preconditionFail(message: string): never {
  process.stderr.write(`前置条件不满足：${message}\n`);
  process.exit(PRECONDITION);
}

const providerConfigPath = arg("provider-config");
if (providerConfigPath === null) preconditionFail("缺少 --provider-config（不得用 URL 或密钥代替）");
const resolvedProviderPath = resolve(providerConfigPath);
if (!isAbsolute(resolvedProviderPath) || !existsSync(resolvedProviderPath)) {
  preconditionFail("--provider-config 必须是存在的绝对路径");
}

const opencodePath = arg("opencode") ?? "/opt/homebrew/bin/opencode";
if (!existsSync(opencodePath) || !statSync(opencodePath).isFile()) {
  preconditionFail(`OpenCode 可执行文件不存在：${opencodePath}`);
}

/** 只接受 `{ "minimax": {...} }`；出现别的供应商就直接拒绝。 */
function readProviderConfig(): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedProviderPath, "utf8"));
  } catch {
    preconditionFail("--provider-config 不是合法 JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    preconditionFail("--provider-config 必须是对象");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== LEGACY_PROVIDER_ID) {
    preconditionFail(`--provider-config 只能包含一个供应商 ${LEGACY_PROVIDER_ID}`);
  }
  const provider = record[LEGACY_PROVIDER_ID];
  if (provider === null || typeof provider !== "object" || Array.isArray(provider)) {
    preconditionFail("provider 必须是对象");
  }
  const models = (provider as Record<string, unknown>)["models"];
  if (models === null || typeof models !== "object" || !Object.hasOwn(models, LEGACY_MODEL_ID)) {
    preconditionFail(`provider.models 必须包含 ${LEGACY_MODEL_ID}`);
  }
  return provider;
}

const providerConfig = readProviderConfig();
const secrets = collectSecretValues(providerConfig);
const providerFileHash = createHash("sha256").update(readFileSync(resolvedProviderPath)).digest("hex");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(arg("out") ?? join("evidence", "oc03", "2026-10-23", `live-${stamp}`));
mkdirSync(outDir, { recursive: true });

const runtimeRoot = mkdtempSync(join(tmpdir(), "oc03-live-"));
const workspace = join(runtimeRoot, "workspace");
const runDir = join(runtimeRoot, "run");
const dbPath = join(runtimeRoot, "bridge.sqlite");
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "README.md"), "disposable OC-03 live workspace\n");

/** 证据里的一切字符串都先脱敏；provider 配置本身永不写入。 */
function redact(text: string): string {
  return redactSecrets(text, secrets);
}

function write(name: string, value: unknown): void {
  writeFileSync(join(outDir, name), `${redact(JSON.stringify(value, null, 2))}\n`);
}

interface TurnRecord {
  readonly name: string;
  readonly promptDigest: string;
  readonly state: string;
  readonly stopCause: string | null;
  readonly requestOutcome: string;
  readonly messageConfirmed: boolean;
  readonly firstTextMs: number | null;
  readonly progressChars: number;
  readonly tools: readonly string[];
  readonly error: unknown;
  readonly agentReported: string | null;
  readonly approvals: readonly { tool: string; decision: string; argumentsDigest: string }[];
  readonly elapsedMs: number;
  readonly notes: readonly string[];
}

const turns: TurnRecord[] = [];
const notes: string[] = [];
let stopping = false;

function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

const store = BridgeStore.open(dbPath);
const service = store.beginService();
const server = store.beginServerInstance({ serviceEpoch: service.serviceEpoch, runDir });
const workspaceRecord = store.createWorkspace({
  name: "oc03-live",
  canonicalRoot: workspace,
  profiles: ["review", "edit"],
});
const ownerId = newId("principal", "00000000-0000-4000-8000-0000000000aa");
const session = store.createSession({
  ownerId,
  workspaceId: workspaceRecord.workspaceId,
  profile: "edit",
});
const principal = {
  principalId: ownerId,
  allowedWorkspaces: [workspaceRecord.workspaceId],
  role: "owner" as const,
};

const adapter = new OpenCodeHttpAdapter({
  executable: opencodePath,
  workspaceRoot: workspace,
  runDir,
  providerConfigs: { [LEGACY_PROVIDER_ID]: providerConfig },
  modelProfiles: { default: { providerID: LEGACY_PROVIDER_ID, modelID: LEGACY_MODEL_ID } },
  policyProfile: "edit",
  pinnedVersion: OPENCODE_PINNED_VERSION,
  serverEpoch: server.serverEpoch,
  startupTimeoutMs: 60_000,
  requestTimeoutMs: 20_000,
  pollIntervalMs: 300,
  permissionPollMs: 500,
  approvalTimeoutMs: 120_000,
  stopGraceMs: 10_000,
  stopSettleMs: 8_000,
  confirmTimeoutMs: 30_000,
  log: (line) => notes.push(`worker: ${redact(line)}`),
});

/** 每个场景各自设定审批策略；未匹配一律拒绝。 */
interface ApprovalPlan {
  readonly allow: (request: BackendApprovalRequest) => boolean;
  readonly answer: "allow_once" | "deny";
}
let approvalPlan: ApprovalPlan = { allow: () => false, answer: "deny" };
let approvalLog: { tool: string; decision: string; argumentsDigest: string }[] = [];

const coordinator = new OpenCodeRunCoordinator(store, adapter, {
  onApproval: (request) => {
    const decision = approvalPlan.allow(request) ? approvalPlan.answer : "deny";
    approvalLog.push({ tool: request.toolName, decision, argumentsDigest: digest(request.argumentsText) });
    const answer: ApprovalAnswer =
      decision === "allow_once"
        ? { decision: "allow_once", actor: "operator" }
        : { decision: "deny", actor: "operator" };
    return answer;
  },
  onWarning: (message) => notes.push(`coordinator: ${redact(message)}`),
});

let turnCount = 0;

/** 提交一轮并等它收敛；超出预算立即失败。 */
async function turn(
  name: string,
  prompt: string,
  options: { readonly during?: (runId: string) => Promise<void> } = {},
): Promise<TurnRecord> {
  if (stopping) throw new Error("已因供应商/模型错误停止后续调用");
  turnCount += 1;
  if (turnCount > MAX_USER_TURNS) throw new Error(`超过用户轮次预算 ${MAX_USER_TURNS}`);

  const admitted = store.admitRun({
    principal,
    sessionId: session.sessionId,
    toolName: "agent_start",
    clientRequestId: `oc03-live-${turnCount}-${name}`,
    serviceEpoch: service.serviceEpoch,
    prompt,
    model: "minimax/MiniMax-M3.1-Flash",
    backend: "opencode",
    deadlineAt: new Date(Date.now() + TURN_TIMEOUT_MS).toISOString(),
  });

  approvalLog = [];
  const started = Date.now();
  const running = coordinator.run({
    runId: admitted.run.runId,
    prompt,
    model: { backendId: "opencode", modelRef: `${LEGACY_PROVIDER_ID}/${LEGACY_MODEL_ID}`, opencode: { providerID: LEGACY_PROVIDER_ID, modelID: LEGACY_MODEL_ID } },
    deadlineAt: store.runs.require(admitted.run.runId).deadlineAt,
  });
  const recordPromise = running.then(async (result) => {
    // 只有 completed 才有结果清单；cancelled/unknown/failed 直接读会抛，脚本不能因此挂掉。
    let agentReported: string | null = null;
    if (result.state === "completed") {
      try {
        const manifest = store.getResultManifest(admitted.run.runId);
        agentReported = manifest.agentReported.join("\n").slice(0, 2_000) || null;
      } catch (error) {
        notes.push(`manifest_unavailable: ${error instanceof Error ? error.message : "unknown"}`);
      }
    }
    const record: TurnRecord = {
      name,
      promptDigest: digest(prompt),
      state: result.state,
      stopCause: result.stopCause,
      requestOutcome: result.requestOutcome,
      messageConfirmed: result.messageConfirmed,
      firstTextMs: null,
      progressChars: 0,
      tools: [],
      error: result.error,
      agentReported,
      approvals: [...approvalLog],
      elapsedMs: Date.now() - started,
      notes: result.warnings.slice(0, 10),
    };
    turns.push(record);
    return record;
  });

  if (options.during !== undefined) {
    // 等待到「真的有一轮在跑」再执行 stop/crash 之类的外部动作。
    await waitFor(() => store.runs.require(admitted.run.runId).state !== "queued", "run 离开 queued", 30_000);
    await options.during(admitted.run.runId);
  }

  const record = await recordPromise;
  if (record.state === "failed" || record.state === "unknown") {
    // 供应商/模型错误：立即停止后续调用，不再消耗额度。
    stopping = true;
    notes.push(`stopped_after_${name}: ${String((record.error as { code?: string } | null)?.code ?? "unknown")}`);
  }
  return record;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
    await delay(100);
  }
}

const watchdog = setTimeout(() => {
  notes.push("total_timeout");
  stopping = true;
}, TOTAL_TIMEOUT_MS);
watchdog.unref();

let exitCode = 0;
const results: { name: string; status: "pass" | "fail" | "observed"; detail: string }[] = [];

function check(name: string, condition: boolean, detail: string): void {
  results.push({ name, status: condition ? "pass" : "fail", detail });
  if (!condition) exitCode = 1;
}

try {
  const ref = await adapter.createSession({
    workspaceRoot: workspace,
    profile: "edit",
    policyProfile: "edit",
    model: { providerID: LEGACY_PROVIDER_ID, modelID: LEGACY_MODEL_ID },
    runDir,
  });
  store.bindSessionBackend(session.sessionId, ref.backendSessionId, ref.serverEpoch);
  const probe = await adapter.probe();
  write("capabilities.json", probe);

  // 1) 文本流 + 2) 同会话记忆（合并覆盖：一轮写入口令，一轮回忆）
  const token = `OC03-${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 10)}`;
  const first = await turn("memory-1", `请记住本会话口令 ${token}。不要使用任何工具，只回复 READY。`);
  check("memory-1/text", first.state === "completed", `state=${first.state}`);
  check("memory-1/answer", (first.agentReported ?? "").includes("READY"), "首轮应回复 READY");

  const second = await turn("memory-2", "刚才我让你记住的口令是什么？不要使用工具，只输出口令。");
  check("memory-2/recall", (second.agentReported ?? "").includes(token), "同会话应能回忆口令");

  // 3) 审批放行（只允许一次性目录里的 approved.txt）
  approvalPlan = {
    answer: "allow_once",
    allow: (request) => request.requestKind === "tool_permission" && request.argumentsText.includes("approved.txt"),
  };
  const approvedPath = join(workspace, "approved.txt");
  const allowTurn = await turn(
    "approval-allow",
    "请使用文件编辑工具在当前工作目录新建 approved.txt，内容严格为 APPROVED 加一个换行；不要使用 shell。完成后只回复 DONE。",
  );
  check("approval-allow/created", existsSync(approvedPath), "放行后应生成文件");
  check("approval-allow/asked", allowTurn.approvals.length > 0, "应出现一次本地审批");

  // 4) 审批拒绝（同一一次性目录）
  approvalPlan = { answer: "deny", allow: () => true };
  const deniedPath = join(workspace, "denied.txt");
  const denyTurn = await turn(
    "approval-deny",
    "请使用文件编辑工具在当前工作目录新建 denied.txt，内容为 DENIED；若权限被拒绝请立即停止，不要换工具，只回复 REJECTED。",
  );
  check("approval-deny/absent", !existsSync(deniedPath), "拒绝后不能生成文件");
  check("approval-deny/not-cancelled", denyTurn.state !== "cancelled", "工具拒绝不等于用户取消");

  // 5) 运行中取消：脚本先写 started，再等 12s 写 late
  writeFileSync(join(workspace, "cancel-work.sh"), '#!/bin/sh\nprintf "started\\n" >> cancel-started.txt\nsleep 12\nprintf "late\\n" >> cancel-late.txt\n');
  approvalPlan = {
    answer: "allow_once",
    allow: (request) => request.toolName === "bash" && request.argumentsText.includes("cancel-work.sh"),
  };
  const cancelRun = store.admitRun({
    principal,
    sessionId: session.sessionId,
    toolName: "agent_start",
    clientRequestId: "oc03-live-cancel",
    serviceEpoch: service.serviceEpoch,
    prompt: "只调用一次 shell 工具执行 sh ./cancel-work.sh，并等待它结束。不要做其它操作。",
    model: "minimax/MiniMax-M3.1-Flash",
    backend: "opencode",
    deadlineAt: new Date(Date.now() + TURN_TIMEOUT_MS).toISOString(),
  });
  turnCount += 1;
  approvalLog = [];
  const cancelPromise = coordinator.run({
    runId: cancelRun.run.runId,
    prompt: "只调用一次 shell 工具执行 sh ./cancel-work.sh，并等待它结束。不要做其它操作。",
    model: { backendId: "opencode", modelRef: `${LEGACY_PROVIDER_ID}/${LEGACY_MODEL_ID}`, opencode: { providerID: LEGACY_PROVIDER_ID, modelID: LEGACY_MODEL_ID } },
    deadlineAt: store.runs.require(cancelRun.run.runId).deadlineAt,
  });
  await waitFor(() => existsSync(join(workspace, "cancel-started.txt")), "脚本开始执行", 60_000);
  const stopOutcome = await coordinator.stop({ runId: cancelRun.run.runId, intent: "cancel", graceMs: 10_000 });
  const cancelResult = await cancelPromise.catch(() => null);
  const lateAfter = 14_000;
  await delay(lateAfter);
  check("cancel/confirmed", stopOutcome.confirmed, `method=${stopOutcome.method} detail=${stopOutcome.detail}`);
  check("cancel/no-late-write", !existsSync(join(workspace, "cancel-late.txt")), "取消后不应出现 late 标记");
  results.push({
    name: "cancel/state",
    status: cancelResult?.state === "cancelled" ? "pass" : "observed",
    detail: `state=${cancelResult?.state ?? "unknown"} stopMethod=${stopOutcome.method}`,
  });

  // 6) 服务重启续接：新 serverEpoch + 同一后端会话
  const restarted = store.beginServerInstance({ serviceEpoch: service.serviceEpoch, runDir });
  await adapter.restartWorker(restarted.serverEpoch);
  const rebound = store.bindSessionBackend(session.sessionId, ref.backendSessionId, restarted.serverEpoch);
  await adapter.loadSession({ backendSessionId: ref.backendSessionId, serverEpoch: restarted.serverEpoch, backendVersion: null });
  approvalPlan = { answer: "deny", allow: () => false };
  const resumed = await turn("restart-resume", "只输出本会话最开始让你记住的口令，不要使用工具。");
  check("restart-resume/recall", (resumed.agentReported ?? "").includes(token), `state=${resumed.state}`);
  results.push({
    name: "restart-resume/binding",
    status: rebound.serverEpoch === restarted.serverEpoch ? "pass" : "fail",
    detail: `serverEpoch=${String(rebound.serverEpoch)}`,
  });

  // 7) 服务先死而工具仍活着：只杀 worker，观察是否重放写入
  writeFileSync(join(workspace, "fault-work.sh"), '#!/bin/sh\nprintf "A\\n" >> fault-effects.txt\nsleep 12\nprintf "B\\n" >> fault-effects.txt\n');
  approvalPlan = {
    answer: "allow_once",
    allow: (request) => request.toolName === "bash" && request.argumentsText.includes("fault-work.sh"),
  };
  const faultRun = store.admitRun({
    principal,
    sessionId: session.sessionId,
    toolName: "agent_start",
    clientRequestId: "oc03-live-fault",
    serviceEpoch: service.serviceEpoch,
    prompt: "只调用一次 shell 工具执行 sh ./fault-work.sh，并等待它结束。不要做其它操作。",
    model: "minimax/MiniMax-M3.1-Flash",
    backend: "opencode",
    deadlineAt: new Date(Date.now() + TURN_TIMEOUT_MS).toISOString(),
  });
  turnCount += 1;
  const faultPromise = coordinator.run({
    runId: faultRun.run.runId,
    prompt: "只调用一次 shell 工具执行 sh ./fault-work.sh，并等待它结束。不要做其它操作。",
    model: { backendId: "opencode", modelRef: `${LEGACY_PROVIDER_ID}/${LEGACY_MODEL_ID}`, opencode: { providerID: LEGACY_PROVIDER_ID, modelID: LEGACY_MODEL_ID } },
    deadlineAt: store.runs.require(faultRun.run.runId).deadlineAt,
  });
  await waitFor(() => existsSync(join(workspace, "fault-effects.txt")), "脚本写出 A", 90_000);
  const killedPid = adapter.workerPid;
  if (killedPid !== null) process.kill(killedPid, "SIGKILL");
  const faultResult = await faultPromise.catch(() => null);
  await delay(15_000);
  const effects = existsSync(join(workspace, "fault-effects.txt"))
    ? readFileSync(join(workspace, "fault-effects.txt"), "utf8").split("\n").filter((line) => line.length > 0)
    : [];
  const countA = effects.filter((line) => line === "A").length;
  const countB = effects.filter((line) => line === "B").length;
  write("fault-effects.json", { countA, countB });
  check("fault/no-replay", countA === 1, `A 出现 ${countA} 次（必须恰好一次）`);
  // 孤儿工具（服务先死、工具后代继续）是已知缺口：观察到就必须算未通过，不能记成 pass。
  if (countB > 0) {
    results.push({
      name: "fault/orphan-tool",
      status: "fail",
      detail: "只杀服务后工具后代继续执行并写出 B：OC-03 未解决该缺口，需 OC-04 处理",
    });
    exitCode = 1;
  } else {
    results.push({ name: "fault/orphan-tool", status: "pass", detail: "未观察到工具后代继续执行" });
  }
  let closeError: string | null = null;
  try {
    await adapter.close();
  } catch (error) {
    closeError = error instanceof Error ? `${(error as { code?: string }).code ?? "error"}` : "error";
  }
  results.push({
    name: "fault/close-verifies",
    status: closeError === null && countB === 0 ? "pass" : "fail",
    detail: `close=${closeError ?? "ok"} state=${faultResult?.state ?? "unknown"} countB=${countB}`,
  });
  if (closeError !== null || countB > 0) exitCode = 1;
} catch (error) {
  exitCode = 1;
  results.push({ name: "unhandled", status: "fail", detail: redact(error instanceof Error ? error.message : "unknown error") });
} finally {
  clearTimeout(watchdog);
  try {
    await adapter.close();
  } catch (error) {
    notes.push(`final_close: ${error instanceof Error ? (error as { code?: string }).code ?? "error" : "error"}`);
  }
  const sessionRecord = store.sessions.require(session.sessionId);
  store.close();

  // 真正清理并按事实记录，不能写死 true。
  let workspaceRemoved = false;
  try {
    rmSync(runtimeRoot, { recursive: true, force: true });
    workspaceRemoved = !existsSync(runtimeRoot) && !existsSync(workspace);
  } catch (error) {
    notes.push(`cleanup_failed: ${error instanceof Error ? error.message : "unknown"}`);
  }
  let providerConfigUnchanged = false;
  try {
    providerConfigUnchanged =
      createHash("sha256").update(readFileSync(resolvedProviderPath)).digest("hex") === providerFileHash;
  } catch (error) {
    notes.push(`provider_hash_failed: ${error instanceof Error ? error.message : "unknown"}`);
  }
  if (!workspaceRemoved || !providerConfigUnchanged) exitCode = 1;

  write("summary.json", {
    at: new Date().toISOString(),
    model: `${LEGACY_PROVIDER_ID}/${LEGACY_MODEL_ID}`,
    opencodeVersion: OPENCODE_PINNED_VERSION,
    providerConfigSha256: providerFileHash,
    userTurns: turnCount,
    maxUserTurns: MAX_USER_TURNS,
    turnTimeoutMs: TURN_TIMEOUT_MS,
    totalTimeoutMs: TOTAL_TIMEOUT_MS,
    results,
    turns,
    notes,
    session: {
      state: sessionRecord.state,
      blockedReason: sessionRecord.blockedReason,
      recoveryVerification: sessionRecord.recoveryVerification,
      serverEpoch: sessionRecord.serverEpoch,
    },
    cleanup: {
      workspaceRemoved,
      providerConfigWrittenToEvidence: false,
      providerConfigUnchanged,
    },
  });
  process.stderr.write(
    `OC-03 live 结束：${results.filter((item) => item.status === "pass").length} pass, ` +
      `${results.filter((item) => item.status === "fail").length} fail, ` +
      `${results.filter((item) => item.status === "observed").length} observed；证据目录 ${outDir}\n`,
  );
  process.exit(exitCode);
}
