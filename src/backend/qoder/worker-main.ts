#!/usr/bin/env node
/**
 * Qoder 受管 SDK worker（OC-09-04）。
 *
 * 与 codebuddy/worker-main.ts 平行但方言独立（不共享协议模块）：
 * - 认证：credential-file 使用私有 PAT；cli-login 经 SDK daemon 的账号面
 *   只读复用浏览器登录，会话配置仍放独立目录；
 * - 隔离：CLI 官方 --config-dir（extraArgs 透传）+ settingSources: []；
 * - interrupt 带回执上报（interrupt_ack，排队消息 UUID 是停止证据）；
 * - env 注入 QODER_SKIP_DOWNLOAD=1（绝不下载 SDK 自带 CLI；路径显式绑定本机 CLI）。
 */
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { encodeQoderReport, type QoderWorkerCommand, type QoderWorkerReport } from "./protocol.ts";
import {
  assistantText,
  isReviewHardDenied,
  mapQdOutcome,
  observedModelFromAssistant,
  observedModelFromUsageKeys,
  toolSummary,
  QODER_REVIEW_DISALLOWED_TOOLS,
} from "./mapping.ts";
import { listProcessTable } from "../../core/proc.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? (args[i + 1] ?? null) : null;
};

const sdkModuleId = flag("sdk-module") ?? "@qoder-ai/qoder-agent-sdk";
const executable = flag("executable");
const stateDir = flag("state-dir");
const cwd = flag("cwd");
const authFile = flag("auth-file");
const authMode = flag("auth-mode") ?? "credential-file";

interface QdQuery {
  [Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>, void, unknown>;
  interrupt(): Promise<{ uuid?: string }[] | unknown>;
  return?(): Promise<unknown>;
}

interface QdSdkModule {
  query(params: { prompt: unknown; options?: Record<string, unknown> }): QdQuery;
  accessToken(token: string): unknown;
  qodercliAuth?: () => unknown;
  startDaemon?: (options: Record<string, unknown>) => Promise<QdDaemon>;
}

interface QdDaemon {
  readonly state: string;
  auth(): Promise<boolean>;
  stop(): Promise<void>;
}

let browserDaemon: QdDaemon | null = null;
async function loggedInDaemon(sdk: QdSdkModule): Promise<QdDaemon> {
  if (browserDaemon?.state === "ready") return browserDaemon;
  if (typeof sdk.startDaemon !== "function" || typeof sdk.qodercliAuth !== "function") throw new Error("SDK 不支持 cli-login daemon");
  const daemon = await sdk.startDaemon({
    auth: sdk.qodercliAuth(), pathToQoderCLIExecutable: executable,
    env: { ...process.env, QODER_SKIP_DOWNLOAD: "1" }, initializeTimeoutMs: 15_000,
    debugFile: path.join(stateDir!, "sdk-daemon.log"), stderr: () => undefined,
  });
  if (!(await daemon.auth())) { await daemon.stop(); throw new Error("Qoder 浏览器登录不可用"); }
  browserDaemon = daemon;
  return daemon;
}

/** QoderCliInitializationError.result 携带的结构终态证据。 */
interface StructuredFailure {
  readonly subtype: string;
  readonly isError: boolean;
  readonly errors: readonly string[];
}

function structuredFailure(error: unknown): StructuredFailure | null {
  if (error === null || typeof error !== "object") return null;
  const result = (error as Record<string, unknown>)["result"];
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  const subtype = record["subtype"];
  if (typeof subtype !== "string" || subtype.length === 0) return null;
  const rawErrors = record["errors"];
  return {
    subtype,
    isError: record["is_error"] !== false,
    errors: Array.isArray(rawErrors)
      ? rawErrors.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 8)
      : [],
  };
}

function send(report: QoderWorkerReport): void {
  process.stdout.write(`${encodeQoderReport(report)}\n`);
}

function fail(message: string): never {
  send({ kind: "worker_error", message, fatal: true });
  process.exit(1);
}

if (executable === null || stateDir === null || cwd === null) {
  fail("缺少 --executable/--state-dir/--cwd 参数");
}

fs.mkdirSync(stateDir, { recursive: true });

const pendingApprovals = new Map<string, (decision: "allow_once" | "deny" | "timeout" | "channel_lost") => void>();
let activeQuery: QdQuery | null = null;
let activeRunAbort: AbortController | null = null;

function reportOwnedPids(): void {
  const table = listProcessTable();
  const children = table.filter((row) => row.ppid === process.pid).map((row) => row.pid);
  if (children.length > 0) send({ kind: "owned_pids", pids: children });
}

const ownedTimer = setInterval(() => {
  reportOwnedPids();
}, 2_000);
ownedTimer.unref();

/** 读取私有认证文件。文件内容约定为 {"accessToken": "..."}；只进 worker 内存。 */
function loadAuthToken(file: string | null): string | null {
  if (file === null) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const token = parsed["accessToken"];
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const sdk = (await import(sdkModuleId)) as unknown as QdSdkModule;
  if (typeof sdk.query !== "function" || typeof sdk.accessToken !== "function") {
    fail("SDK 模块未导出 query()/accessToken()");
  }
  if (authFile !== null && loadAuthToken(authFile) === null) {
    fail("认证文件不存在或不含 accessToken 字段");
  }

  send({ kind: "ready", workerProtocol: 1, sdkVersion: null, cliVersionObserved: null });

  const stdin = createInterface({ input: process.stdin, crlfDelay: Infinity });
  stdin.on("close", () => {
    void shutdown("stdin_closed");
  });
  stdin.on("line", (line) => {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value["kind"] !== "string") return;
    void handleCommand(value as unknown as QoderWorkerCommand).catch((error) => {
      send({ kind: "worker_error", message: error instanceof Error ? error.message : String(error), fatal: false });
    });
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

async function handleCommand(command: QoderWorkerCommand): Promise<void> {
  if (command.kind === "shutdown") {
    await shutdown("requested");
    return;
  }
  if (command.kind === "approval_decision") {
    pendingApprovals.get(command.approvalId)?.(command.decision);
    return;
  }
  if (command.kind === "interrupt" || command.kind === "cancel") {
    try {
      const ack = await activeQuery?.interrupt();
      const uuids = Array.isArray(ack)
        ? ack.map((entry) => (entry !== null && typeof entry === "object" ? String((entry as { uuid?: unknown }).uuid ?? "") : "")).filter((v) => v.length > 0)
        : [];
      if (command.kind === "interrupt") {
        send({ kind: "interrupt_ack", runId: command.runId, queuedMessageUuids: uuids });
      }
    } catch {
      /* 中断失败由 outcome/超时路径收敛 */
    }
    if (command.kind === "cancel") activeRunAbort?.abort();
    return;
  }
  if (command.kind === "run") {
    await runTurn(command);
  }
}

async function runTurn(command: Extract<QoderWorkerCommand, { kind: "run" }>): Promise<void> {
  const sdk = (await import(sdkModuleId)) as unknown as QdSdkModule;
  const abort = new AbortController();
  activeRunAbort = abort;
  let resultObserved = false;
  let inputUnsupported = false;
  let resultFields: {
    subtype: string | null;
    isError: boolean;
    errors: readonly string[];
    resultText: string | null;
    usage: { inputTokens: number | null; outputTokens: number | null } | null;
    modelUsageKeys: string[];
    numTurns: number | null;
    stopReason: string | null;
    terminalReason: string | null;
  } | null = null;
  let reportedSession = false;
  let observedFromAssistant = false;
  /** SDK 迭代抛出的异常：结构终态证据按 subtype 映射，无证据保持 unknown。 */
  let iterationError: string | null = null;
  let iterationFailure: StructuredFailure | null = null;

  const deadlineTimer = setTimeout(() => {
    void (async () => {
      try { await activeQuery?.interrupt(); } catch { /* 收敛走 outcome */ }
    })();
  }, Math.max(1_000, Date.parse(command.deadlineAt) - Date.now()));
  deadlineTimer.unref();

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
    options: { toolUseID?: string },
  ): Promise<{ behavior: "allow" | "deny"; message?: string }> => {
    if (isReviewHardDenied(toolName)) {
      return { behavior: "deny", message: "review profile 禁止该工具" };
    }
    if (toolName === "AskUserQuestion") {
      // 事实提问不是授权：走产品既有的「不支持输入」有界停止，不占用审批队列。
      if (!inputUnsupported) {
        inputUnsupported = true;
        send({
          kind: "input_requested",
          runId: command.runId,
          schema: { kind: "text", question: "后端要求补充信息（本项不支持自动回答）", options: [] },
        });
        void activeQuery?.interrupt();
      }
      return { behavior: "deny", message: "本项不支持事实输入" };
    }
    const approvalId = `qda_${options.toolUseID ?? `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`}`;
    let argumentsText: string;
    try {
      argumentsText = JSON.stringify(input) ?? "";
    } catch {
      argumentsText = String(input);
    }
    const targetPaths: string[] = [];
    for (const key of ["file_path", "path", "notebook_path", "filePath"]) {
      const value = input[key];
      if (typeof value === "string") targetPaths.push(value);
    }
    send({
      kind: "approval_requested",
      runId: command.runId,
      approvalId,
      toolName,
      toolCallId: options.toolUseID ?? approvalId,
      attemptId: command.attemptId,
      argumentsText: argumentsText.slice(0, 4_096),
      targetPaths: targetPaths.slice(0, 16),
      requestKind: "tool_permission",
    });
    const decision = await new Promise<"allow_once" | "deny" | "timeout" | "channel_lost">((resolve) => {
      pendingApprovals.set(approvalId, resolve);
    });
    pendingApprovals.delete(approvalId);
    if (decision === "allow_once") return { behavior: "allow" };
    return { behavior: "deny", message: decision === "deny" ? "operator denied" : `approval ${decision}` };
  };

  // credential-file：token 只在 worker 内存；未配置认证文件时传占位 token——
  // CLI 会在首次推理前校验并返回结构化错误（fake 也不启动真实网络）。
  const authToken = loadAuthToken(authFile) ?? "oc09-unconfigured-placeholder";

  let query: QdQuery;
  try {
    const daemon = authMode === "cli-login" ? await loggedInDaemon(sdk) : null;
    query = sdk.query({
      prompt: command.prompt,
      options: {
        ...(daemon === null ? { pathToQoderCLIExecutable: executable, auth: sdk.accessToken(authToken), env: { QODER_SKIP_DOWNLOAD: "1" } } : { daemon }),
        cwd,
        settingSources: [],
        extraArgs: { "config-dir": stateDir },
        permissionMode: "default",
        includePartialMessages: false,
        model: command.model,
        ...(command.resume !== null ? { resume: command.resume } : {}),
        abortController: abort,
        canUseTool,
        disallowedTools: [...QODER_REVIEW_DISALLOWED_TOOLS],
        strictMcpConfig: true,
        mcpServers: {},
        stderr: (data: string) => {
          send({ kind: "event", runId: command.runId, type: "stderr", text: data.slice(-2_000) });
        },
      },
    });
  } catch {
    clearTimeout(deadlineTimer);
    activeRunAbort = null;
    send({ kind: "dispatch", runId: command.runId, messageId: null, accepted: false });
    send({ kind: "outcome", runId: command.runId, subtype: "error_during_execution", isError: true,
      resultText: null, errors: ["Qoder 登录或会话初始化失败"], stopReason: "backend_error", terminalReason: null,
      usage: null, modelUsageKeys: [], numTurns: 0 });
    return;
  }
  activeQuery = query;

  try {
    for await (const message of query) {
      if (abort.signal.aborted) break;
      const type = message["type"];
      if (type === "system" && message["subtype"] === "init") {
        if (!reportedSession && typeof message["session_id"] === "string") {
          reportedSession = true;
          send({
            kind: "session",
            backendSessionId: message["session_id"],
            cliVersion: typeof message["qodercli_version"] === "string" ? message["qodercli_version"] : null,
            protocolVersion: typeof message["protocol_version"] === "string" ? message["protocol_version"] : null,
            modelReported: typeof message["model"] === "string" ? message["model"] : null,
            toolsCount: Array.isArray(message["tools"]) ? message["tools"].length : null,
          });
        }
        continue;
      }
      if (type === "user" && typeof message["uuid"] === "string") {
        send({ kind: "dispatch", runId: command.runId, messageId: message["uuid"], accepted: true });
        continue;
      }
      if (type === "assistant") {
        const inner = message["message"] as Record<string, unknown> | undefined;
        const model = observedModelFromAssistant(inner as { model?: unknown } | undefined);
        if (model !== null) {
          observedFromAssistant = true;
          send({ kind: "observed_model", runId: command.runId, model });
        }
        const content = Array.isArray(inner?.["content"]) ? (inner?.["content"] as readonly unknown[]) : [];
        const text = assistantText(content);
        if (text.length > 0) {
          send({ kind: "event", runId: command.runId, type: "message", text: text.slice(0, 4_000), final: false });
        }
        for (const block of content) {
          if (block !== null && typeof block === "object" && !Array.isArray(block)) {
            const record = block as Record<string, unknown>;
            if (record["type"] === "tool_use" && typeof record["name"] === "string") {
              send({
                kind: "event",
                runId: command.runId,
                type: "tool",
                text: "",
                tool: {
                  toolCallId: typeof record["id"] === "string" ? record["id"] : "unknown",
                  toolName: record["name"],
                  phase: "requested",
                  summary: toolSummary(record["name"], record["input"]),
                },
              });
            }
          }
        }
        continue;
      }
      if (type === "result") {
        resultObserved = true;
        const subtype = typeof message["subtype"] === "string" ? message["subtype"] : null;
        const modelUsage = message["modelUsage"] as Record<string, unknown> | undefined;
        resultFields = {
          subtype,
          isError: message["is_error"] === true,
          errors: Array.isArray(message["errors"]) ? (message["errors"] as string[]).slice(0, 8).map(String) : [],
          resultText: typeof message["result"] === "string" ? message["result"] : null,
          usage: (() => {
            const usage = message["usage"] as Record<string, unknown> | undefined;
            if (usage === undefined) return null;
            const num = (v: unknown) => (typeof v === "number" ? v : null);
            return { inputTokens: num(usage["input_tokens"]), outputTokens: num(usage["output_tokens"]) };
          })(),
          modelUsageKeys: modelUsage !== undefined && modelUsage !== null ? Object.keys(modelUsage).slice(0, 8) : [],
          numTurns: typeof message["num_turns"] === "number" ? message["num_turns"] : null,
          stopReason: typeof message["stop_reason"] === "string" ? message["stop_reason"] : null,
          terminalReason: typeof message["terminal_reason"] === "string" ? message["terminal_reason"] : null,
        };
        if (typeof message["session_id"] === "string" && !reportedSession) {
          reportedSession = true;
          send({ kind: "session", backendSessionId: message["session_id"], cliVersion: null, protocolVersion: null, modelReported: null, toolsCount: null });
        }
        break;
      }
    }
  } catch (error) {
    iterationError = error instanceof Error ? error.message : String(error);
    iterationFailure = structuredFailure(error);
    send({
      kind: "worker_error",
      message: `query 迭代异常: ${iterationError}`,
      fatal: false,
    });
  } finally {
    clearTimeout(deadlineTimer);
    activeQuery = null;
    activeRunAbort = null;
  }

  // 结构化终态（QoderCliInitializationError.result）保留 subtype/errors；
  // 无结构终态的传输/读取异常保持 unknown，不冒充确定失败。
  const structuredIteration: StructuredFailure | null = resultObserved ? null : iterationFailure;
  const outcome = mapQdOutcome(
    resultObserved
      ? {
          subtype: resultFields?.subtype ?? null,
          isError: resultFields?.isError ?? true,
          errors: resultFields?.errors ?? [],
          resultObserved: true,
        }
      : structuredIteration !== null
        ? {
            subtype: structuredIteration.subtype,
            isError: structuredIteration.isError,
            errors: structuredIteration.errors,
            resultObserved: true,
          }
        : { subtype: null, isError: true, errors: [], resultObserved: false },
  );
  // observedModel 后备：只在 assistant 消息未给出本轮身份时使用 modelUsageKeys。
  const usageModel = observedFromAssistant ? null : observedModelFromUsageKeys(resultFields?.modelUsageKeys ?? []);
  if (usageModel !== null) send({ kind: "observed_model", runId: command.runId, model: usageModel });

  const outcomeSubtype: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "unknown" =
    structuredIteration !== null
      ? (structuredIteration.subtype as typeof outcomeSubtype)
      : resultObserved && outcome.kind !== "unknown"
        ? ((resultFields?.subtype ?? "unknown") as typeof outcomeSubtype)
        : "unknown";
  const baseStopReason = resultObserved || structuredIteration !== null ? outcome.stopReason : null;
  send({
    kind: "outcome",
    runId: command.runId,
    subtype: outcomeSubtype,
    isError: inputUnsupported || outcome.kind !== "completed",
    resultText: resultFields?.resultText ?? null,
    errors: inputUnsupported
      ? ["后端要求事实输入，本项不支持自动回答"]
      : structuredIteration !== null
        ? structuredIteration.errors
        : resultObserved
          ? outcome.kind === "unknown" && resultFields === null
            ? ["无结构化终态"]
            : (resultFields?.errors ?? [])
          : [`SDK 执行异常: ${iterationError ?? "unknown"}`],
    stopReason: baseStopReason === "turn_complete" || baseStopReason === "output_limit" || baseStopReason === "backend_error" || baseStopReason === "aborted" || baseStopReason === "refusal" || baseStopReason === "tool_calls_pending" ? baseStopReason : baseStopReason === null ? null : `unknown:${String(baseStopReason)}`,
    terminalReason: resultFields?.terminalReason ?? null,
    usage: resultFields?.usage ?? null,
    modelUsageKeys: resultFields?.modelUsageKeys ?? [],
    numTurns: resultFields?.numTurns ?? null,
    ...(inputUnsupported
      ? { failureCode: "INPUT_REQUIRED_UNSUPPORTED", failureMessage: "后端要求事实输入，本项不支持自动回答" }
      : {}),
  });
}

async function shutdown(_reason: string): Promise<void> {
  try {
    await activeQuery?.interrupt();
    await activeQuery?.return?.();
  } catch {
    /* 收尾尽力而为；daemon 侧按进程树回收 */
  }
  clearInterval(ownedTimer);
  if (browserDaemon !== null) { try { await browserDaemon.stop(); } catch { /* daemon 侧有界回收 */ } browserDaemon = null; }
  try {
    const children = listProcessTable().filter((row) => row.ppid === process.pid);
    for (const child of children) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        /* ESRCH：已退出 */
      }
    }
  } catch {
    /* 进程表读不到时依赖 daemon 侧回收 */
  }
  process.exit(0);
}

void main().catch((error) => {
  fail(`worker 初始化失败: ${error instanceof Error ? error.message : String(error)}`);
});
void path;
