#!/usr/bin/env node
/**
 * CodeBuddy 受管 SDK worker（OC-09-03）。
 *
 * daemon 以独占子进程方式启动本文件；worker 是产品里唯一 import
 * @tencent-ai/agent-sdk 的代码。职责：
 * - 按 daemon 的 run 命令驱动 SDK query()（绑定本机受控 CLI、隔离状态目录）；
 * - 把 SDK 消息映射为 protocol.ts 的 WorkerReport 写到 stdout；
 * - canUseTool → review 硬拒绝优先，其余上报 daemon 审批队列并等待决定；
 * - 观察自身子进程（CLI/工具后代）并上报归属；
 * - interrupt/cancel/shutdown 的有界执行。
 *
 * 测试注入：--sdk-module 指向实现了同表面的 fake 模块（真实子进程边界不变）。
 */
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  decodeWorkerCommand,
  encodeWorkerReport,
  type WorkerCommand,
  type WorkerReport,
} from "./protocol.ts";
import {
  assistantText,
  isReviewHardDenied,
  mapCbOutcome,
  observedModelFromAssistant,
  toolSummary,
} from "./mapping.ts";
import { listProcessTable } from "../../core/proc.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? (args[i + 1] ?? null) : null;
};

const sdkModuleId = flag("sdk-module") ?? "@tencent-ai/agent-sdk";
const executable = flag("executable");
const bindingDir = flag("exe-binding");
const stateDir = flag("state-dir");
const cwd = flag("cwd");

interface SdkQuery {
  connect(): Promise<void>;
  [Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>, void, unknown>;
  interrupt(): Promise<void>;
  return?(): Promise<unknown>;
}

interface SdkModule {
  query(params: {
    prompt?: string;
    options?: Record<string, unknown>;
  }): SdkQuery;
}

/** SDK 迭代异常携带的结构终态证据（ExecutionError 的 errors/subtype）。 */
interface StructuredFailure {
  readonly subtype: string;
  readonly errors: readonly string[];
}

function structuredFailure(error: unknown): StructuredFailure | null {
  if (error === null || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const subtype = record["subtype"];
  if (typeof subtype !== "string" || subtype.length === 0) return null;
  const rawErrors = record["errors"];
  if (!Array.isArray(rawErrors)) return null;
  return {
    subtype,
    errors: rawErrors.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 8),
  };
}

function send(report: WorkerReport): void {
  process.stdout.write(`${encodeWorkerReport(report)}\n`);
}

function fail(message: string): never {
  send({ kind: "worker_error", message, fatal: true });
  process.exit(1);
}

if (executable === null || bindingDir === null || stateDir === null || cwd === null) {
  fail("缺少 --executable/--exe-binding/--state-dir/--cwd 参数");
}

// SDK 0.3.291 只对 .exe 后缀走 directExecute（原生二进制 + 纯净参数）；
// 受控绑定目录里的符号链接指向配置的本机 CLI，不使用 SDK 包内自带版本。
fs.mkdirSync(bindingDir, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
const exeBinding = path.join(bindingDir, "codebuddy.exe");
try {
  fs.rmSync(exeBinding, { force: true });
  fs.symlinkSync(fs.realpathSync(executable), exeBinding);
} catch (error) {
  fail(`建立 .exe 绑定失败: ${error instanceof Error ? error.message : String(error)}`);
}

const pendingApprovals = new Map<string, (decision: "allow_once" | "deny" | "timeout" | "channel_lost") => void>();
let activeQuery: SdkQuery | null = null;
let activeRunAbort: AbortController | null = null;
// shutdown 由 SIGTERM/命令路径触发；不保留额外标志。

/** 自身子进程（CLI 及其后代线索）观察：daemon 据此记录归属并核对回收。 */
function reportOwnedPids(): void {
  const table = listProcessTable();
  const children = table.filter((row) => row.ppid === process.pid).map((row) => row.pid);
  if (children.length > 0) send({ kind: "owned_pids", pids: children });
}

const ownedTimer = setInterval(() => {
  reportOwnedPids();
}, 2_000);
ownedTimer.unref();

let sdk: SdkModule | null = null;

async function main(): Promise<void> {
  sdk = (await import(sdkModuleId)) as unknown as SdkModule;
  if (typeof sdk.query !== "function") fail("SDK 模块未导出 query()");

  send({ kind: "ready", workerProtocol: 1, sdkVersion: null, cliVersionObserved: null });

  const stdin = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // 孤儿防御：daemon 死亡/关闭 stdin 时 worker 必须自我了断并回收 CLI 后代，
  // 否则父进程崩溃会遗留无主 SDK/CLI 进程。
  stdin.on("close", () => {
    void shutdown("stdin_closed");
  });
  stdin.on("line", (line) => {
    const command = decodeWorkerCommand(line);
    if (command === null) return;
    void handleCommand(command).catch((error) => {
      send({
        kind: "worker_error",
        message: error instanceof Error ? error.message : String(error),
        fatal: false,
      });
    });
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

async function handleCommand(command: WorkerCommand): Promise<void> {
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
      await activeQuery?.interrupt();
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

async function runTurn(command: Extract<WorkerCommand, { kind: "run" }>): Promise<void> {
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
    numTurns: number | null;
    stopReason: string | null;
  } | null = null;
  let messageId: string | null = null;
  let reportedSession = false;
  /** SDK 迭代抛出的异常：结构终态证据按 subtype 映射，无证据保持 unknown。 */
  let iterationError: string | null = null;
  let iterationFailure: StructuredFailure | null = null;

  // deadline：worker 侧有界兜底（coordinator 的绝对期限仍为主控）。
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
      // review 硬拒绝：不进审批队列，operator 无法放开本阶段禁用的能力。
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
        // 拒绝后让本轮尽快收敛，避免模型换一种问法继续消耗。
        void activeQuery?.interrupt();
      }
      return { behavior: "deny", message: "本项不支持事实输入" };
    }
    const approvalId = `cba_${options.toolUseID ?? `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`}`;
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

  if (sdk === null) fail("worker 尚未完成 SDK 初始化");
  const query = sdk.query({
    prompt: command.prompt,
    options: {
      pathToCodebuddyCode: exeBinding,
      cwd,
      settingSources: [],
      env: { CODEBUDDY_CONFIG_DIR: stateDir },
      permissionMode: "default",
      includePartialMessages: false,
      model: command.model,
      ...(command.sessionId !== null ? { sessionId: command.sessionId } : {}),
      ...(command.resume !== null ? { resume: command.resume } : {}),
      disallowedTools: [],
      canUseTool,
      abortController: abort,
      stderr: (data: string) => {
        send({ kind: "event", runId: command.runId, type: "stderr", text: data.slice(-2_000) });
      },
    },
  });
  activeQuery = query;

  try {
    await query.connect();
    send({ kind: "dispatch", runId: command.runId, messageId: null, accepted: true });
  } catch (error) {
    send({
      kind: "dispatch",
      runId: command.runId,
      messageId: null,
      accepted: false,
    });
    send({
      kind: "outcome",
      runId: command.runId,
      subtype: "unknown",
      isError: true,
      resultText: null,
      errors: [`connect 失败: ${error instanceof Error ? error.message : String(error)}`],
      stopReason: null,
      usage: null,
      numTurns: null,
    });
    return;
  }

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
            cliVersion: typeof message["codebuddy_code_version"] === "string" ? message["codebuddy_code_version"] : null,
            modelReported: typeof message["model"] === "string" ? message["model"] : null,
            toolsCount: Array.isArray(message["tools"]) ? message["tools"].length : null,
          });
        }
        continue;
      }
      if (type === "user" && typeof message["uuid"] === "string" && messageId === null) {
        messageId = message["uuid"];
        send({ kind: "dispatch", runId: command.runId, messageId, accepted: true });
        continue;
      }
      if (type === "assistant") {
        const inner = message["message"] as Record<string, unknown> | undefined;
        const model = observedModelFromAssistant(inner as { model?: unknown } | undefined);
        if (model !== null) send({ kind: "observed_model", runId: command.runId, model });
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
          numTurns: typeof message["num_turns"] === "number" ? message["num_turns"] : null,
          stopReason: null,
        };
        if (typeof message["session_id"] === "string" && !reportedSession) {
          reportedSession = true;
          send({ kind: "session", backendSessionId: message["session_id"], cliVersion: null, modelReported: null, toolsCount: null });
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

  // 结构化终态异常（真实 SDK 的 ExecutionError）保留 subtype/errors；
  // 无结构终态的传输/读取异常不能从「结果不明」提升为确定失败。
  const structuredIteration: StructuredFailure | null = resultObserved ? null : iterationFailure;
  const outcome = mapCbOutcome(
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
            isError: true,
            errors: structuredIteration.errors,
            resultObserved: true,
          }
        : { subtype: null, isError: true, errors: [], resultObserved: false },
  );
  const outcomeSubtype: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "aborted" | "unknown" =
    structuredIteration !== null
      ? (structuredIteration.subtype as typeof outcomeSubtype)
      : resultObserved && outcome.kind !== "unknown"
        ? ((resultFields?.subtype ?? "unknown") as typeof outcomeSubtype)
        : "unknown";
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
    stopReason: resultObserved || structuredIteration !== null ? outcome.stopReason : null,
    usage: resultFields?.usage ?? null,
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
  // 退出前回收自己的全部子进程（SDK 的 return() 不保证收割 directExecute
  // CLI；周期上报也可能错过短轮次）。worker 是这些进程的父进程，这是
  // 归属最明确的一层；daemon 侧的 owned 回收是第二层（worker 崩溃时）。
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
