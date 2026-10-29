/**
 * zbridge CLI 的命令集（兼容命令名，产品名为 CLI MCP Bridge）。
 *
 * OC-04 后新增本地 daemon／operator／run 命令：它们通过 Unix IPC 与本地 daemon
 * 通信；身份由 daemon 按通道决定，命令行不传 principal。`config/doctor/tools/fake`
 * 仍完全不接触真实后端。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackendEvent, BackendEventSink } from "../contracts/backend.ts";
import { validateConfigObject, type ProductConfig } from "../contracts/config.ts";
import {
  CONFIG_SCHEMA_VERSION,
  CONTRACT_VERSION,
  NODE_BASELINE,
  PRODUCT_DISPLAY_NAME,
  PRODUCT_NAME,
  PRODUCT_VERSION,
} from "../contracts/version.ts";
import { newId } from "../contracts/ids.ts";
import { TOOL_MANIFEST, registrableTools } from "../contracts/tools.ts";
import { defaultDataRoot, resolveDataPaths } from "../core/paths.ts";
import { applyTurnOutcome } from "../core/apply-outcome.ts";
import { FakeBackend } from "../backend/fake/index.ts";
import { scenarioNames } from "../backend/fake/scenarios.ts";
import { LEGACY_MODEL_ID, LEGACY_PROVIDER_ID } from "../backend/opencode/profile.ts";
import { ipcCall } from "../daemon/ipc.ts";
import { resolveDaemonPaths } from "../daemon/layout.ts";
import { InstanceLock, processIdentity } from "../daemon/lock.ts";
import { IMPLEMENTED_TOOLS } from "../transport/handlers.ts";
import { runConfigCommand, runManagementCommand } from "./manage.ts";
import {
  UsageError,
  assertKnownFlags,
  optionalInt,
  optionalString,
  requireString,
  type ParsedArgs,
} from "./args.ts";

export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  refused: 3,
  precondition: 4,
  notImplemented: 5,
} as const;

export interface CommandResult {
  readonly exitCode: number;
  readonly output: string;
}

const FIXED_RUN_UUID = "00000000-0000-4000-8000-000000000001";

function emit(flags: ParsedArgs["flags"], json: unknown, text: () => string): CommandResult {
  return { exitCode: EXIT.ok, output: flags["json"] === true ? JSON.stringify(json, null, 2) : text() };
}

interface DoctorCheck {
  readonly id: string;
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
}

function checkDataDir(path: string): DoctorCheck {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const probe = `${path}/.opencode-bridge-write-probe`;
    writeFileSync(probe, "ok", { mode: 0o600 });
    const stat = statSync(probe);
    if (!stat.isFile()) return { id: "dataDir", status: "fail", detail: "写入探针异常" };
    // 探针文件保留在临时目录里也无需清理；正式数据目录的清理由 doctor 后续版本负责。
    return { id: "dataDir", status: "ok", detail: `可写（0700）: ${path}` };
  } catch (error) {
    return { id: "dataDir", status: "fail", detail: `不可写: ${(error as Error).message}` };
  }
}

function commandVersion(flags: ParsedArgs["flags"]): CommandResult {
  assertKnownFlags(flags, []);
  const nodeVersion = process.versions.node;
  const payload = {
    name: PRODUCT_NAME,
    displayName: PRODUCT_DISPLAY_NAME,
    version: PRODUCT_VERSION,
    contractVersion: CONTRACT_VERSION,
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
    nodeVersion,
    nodeBaseline: NODE_BASELINE,
    baselineMatch: nodeVersion === NODE_BASELINE,
    platform: `${process.platform}-${process.arch}`,
  };
  return emit(flags, payload, () =>
    [
      `${PRODUCT_DISPLAY_NAME} ${PRODUCT_VERSION}（命令 cli-mcp-bridge，契约 v${CONTRACT_VERSION}，配置 v${CONFIG_SCHEMA_VERSION}）`,
      `Node ${nodeVersion}（基线 ${NODE_BASELINE}${payload.baselineMatch ? "" : "，当前不匹配"}）`,
      `${payload.platform}`,
    ].join("\n"),
  );
}

function commandDoctor(flags: ParsedArgs["flags"]): CommandResult {
  assertKnownFlags(flags, ["config", "data-dir"]);
  const checks: DoctorCheck[] = [];
  const nodeVersion = process.versions.node;
  checks.push({
    id: "runtime.node",
    status: nodeVersion === NODE_BASELINE ? "ok" : "warn",
    detail: `Node ${nodeVersion}（基线 ${NODE_BASELINE}）`,
  });

  const configPath = optionalString(flags, "config");
  if (configPath) {
    const absolute = resolve(configPath);
    if (!existsSync(absolute)) {
      checks.push({ id: "config.file", status: "fail", detail: `配置不存在: ${absolute}` });
    } else {
      try {
        const parsed = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
        const result = validateConfigObject(parsed);
        checks.push(
          result.ok
            ? { id: "config.file", status: "ok", detail: `schema 通过，${result.config.workspaces.length} 个工作区` }
            : { id: "config.file", status: "fail", detail: result.issues.join("; ") },
        );
      } catch (error) {
        checks.push({ id: "config.file", status: "fail", detail: `JSON 解析失败: ${(error as Error).message}` });
      }
    }
  } else {
    checks.push({ id: "config.file", status: "warn", detail: "未指定 --config，跳过配置校验" });
  }

  const dataDir = optionalString(flags, "data-dir");
  if (dataDir) {
    checks.push(checkDataDir(resolve(dataDir)));
  } else {
    checks.push({
      id: "dataDir",
      status: "warn",
      detail: `未指定 --data-dir；默认根 ${defaultDataRoot()}（未创建、未写入）`,
    });
  }

  checks.push({
    id: "backend.live",
    status: "warn",
    detail: "本命令仅做离线自检：未启动 opencode serve，也未调用模型；实时 probe 结果为 unknown",
  });
  checks.push({
    id: "mcp.gateway",
    status: "ok",
    detail: "stdio gateway 已实现；用 `zbridge mcp serve --data-dir <dir>` 连接本地 daemon",
  });
  checks.push({
    id: "tools.registrable",
    status: "ok",
    detail: `已注册 ${IMPLEMENTED_TOOLS.size} 个工具（v0.1 工具面共 ${TOOL_MANIFEST.length} 个）`,
  });

  const failed = checks.some((check) => check.status === "fail");
  const payload = {
    contractVersion: CONTRACT_VERSION,
    ok: !failed,
    checks,
    dataPaths: resolveDataPaths(dataDir ? resolve(dataDir) : defaultDataRoot()),
  };
  const text = checks.map((check) => `[${check.status}] ${check.id}: ${check.detail}`).join("\n");
  return { exitCode: failed ? EXIT.precondition : EXIT.ok, output: flags["json"] === true ? JSON.stringify(payload, null, 2) : text };
}

function commandTools(flags: ParsedArgs["flags"]): CommandResult {
  assertKnownFlags(flags, []);
  // OC-05：注册集合与 MCP gateway 的 tools/list 共用同一份已实现集合。
  const implemented = IMPLEMENTED_TOOLS;
  const registrable = registrableTools(implemented);
  const payload = {
    contractVersion: CONTRACT_VERSION,
    registrableCount: registrable.length,
    tools: TOOL_MANIFEST.map((tool) => ({
      name: tool.name,
      stage: tool.stage,
      implementedIn: tool.implementedIn,
      implemented: implemented.has(tool.name),
      annotations: tool.annotations,
      summary: tool.summary,
    })),
  };
  return emit(flags, payload, () =>
    [
      `可注册工具 ${registrable.length} 个（能力未实现则不注册）`,
      ...payload.tools.map(
        (tool) => `  - ${tool.name} [${tool.implemented ? "已实现" : `待 ${tool.implementedIn}`}] ${tool.summary}`,
      ),
    ].join("\n"),
  );
}

function makeSink(events: BackendEvent[], approval: string): BackendEventSink {
  return {
    emit(event) {
      events.push(event);
    },
    async requestApproval(_request) {
      if (approval === "deny") return { decision: "deny", actor: "operator" };
      if (approval === "timeout") return { decision: "timeout", actor: "product_expiry" };
      return { decision: "allow_once", actor: "operator" };
    },
    async requestInput() {
      return "unsupported";
    },
  };
}

async function commandFake(positional: readonly string[], flags: ParsedArgs["flags"]): Promise<CommandResult> {
  const sub = positional[1];
  if (sub === "list") {
    assertKnownFlags(flags, []);
    return emit(flags, { scenarios: scenarioNames() }, () => scenarioNames().map((name) => `- ${name}`).join("\n"));
  }
  if (sub !== "run") {
    throw new UsageError("用法: zbridge fake <run --scenario <name> | list>");
  }

  assertKnownFlags(flags, ["scenario", "approval", "stop-after-ms", "stop-intent", "out"]);
  const scenarioName = requireString(flags, "scenario");
  if (!scenarioNames().includes(scenarioName)) {
    // 场景名打错是用法问题（exit 2），不是内部错误（exit 1）。
    throw new UsageError(`未知场景 ${scenarioName}；可用: ${scenarioNames().join(", ")}`);
  }
  const approval = optionalString(flags, "approval") ?? "allow";
  if (!["allow", "deny", "timeout"].includes(approval)) {
    throw new UsageError("--approval 只支持 allow|deny|timeout");
  }
  const stopIntentRaw = optionalString(flags, "stop-intent") ?? "cancel";
  if (!["interrupt", "cancel", "close"].includes(stopIntentRaw)) {
    throw new UsageError("--stop-intent 只支持 interrupt|cancel|close");
  }
  const stopIntent = stopIntentRaw as "interrupt" | "cancel" | "close";

  const backend = new FakeBackend({
    scenario: scenarioName,
    stopAfterMs: optionalInt(flags, "stop-after-ms"),
    stopIntent,
  });

  const events: BackendEvent[] = [];
  const sink = makeSink(events, approval);
  const session = await backend.createSession({
    workspaceRoot: "/nonexistent/fake-workspace",
    profile: "review",
    policyProfile: "review",
    model: { providerID: LEGACY_PROVIDER_ID, modelID: LEGACY_MODEL_ID },
    runDir: "/nonexistent/fake-run",
  });

  const runId = newId("run", FIXED_RUN_UUID);
  const outcome = await backend.execute(
    {
      runId,
      session,
      prompt: "fake scenario",
      model: { backendId: "opencode", modelRef: `${LEGACY_PROVIDER_ID}/${LEGACY_MODEL_ID}`, opencode: { providerID: LEGACY_PROVIDER_ID, modelID: LEGACY_MODEL_ID } },
      deadlineAt: "2026-01-01T00:01:00.000Z",
    },
    sink,
  );
  await backend.close();

  // 关键一步：不是把 outcome.kind 抄成 state，而是过一遍状态机。
  const applied = applyTurnOutcome(outcome, { stopIntent });

  const summary = {
    scenario: scenarioName,
    runId,
    /** 归约后的产品状态（晚到终态会被拒，见 rejectedTerminal）。 */
    state: applied.state,
    /** 后端自己报的终态，保留供对账；可能与 state 不同。 */
    backendReportedState: outcome.kind,
    transitions: applied.path,
    rejectedTerminal: applied.rejectedTerminal,
    rejectionReason: applied.rejected,
    stopReason: outcome.stopReason,
    terminalObservedAfterStop: outcome.terminalObservedAfterStop,
    error: outcome.error,
    agentReported: outcome.agentReported,
    eventCount: events.length,
    startedAt: outcome.startedAt,
    endedAt: outcome.endedAt,
    transcript: backend.transcript,
  };

  const out = optionalString(flags, "out");
  if (out) {
    const absolute = resolve(out);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  }

  return emit(flags, summary, () =>
    [
      `场景 ${scenarioName}: ${applied.state}（后端报 ${outcome.kind}，stopReason=${outcome.stopReason ?? "none"}）`,
      applied.path.length > 0 ? `状态路径: running → ${applied.path.join(" → ")}` : "",
      applied.rejectedTerminal
        ? `注意：拒绝改写后端终态 ${applied.rejectedTerminal}（${applied.rejected ?? "late_terminal"}），最终按停止意图收敛`
        : "",
      outcome.error ? `错误: ${outcome.error.code} ${outcome.error.message}` : "",
      `事件 ${events.length} 条，虚拟时长 ${Date.parse(outcome.endedAt) - Date.parse(outcome.startedAt)} ms`,
      out ? `已写入 ${resolve(out)}` : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
}

// ---------------------------------------------------------------- daemon / operator / run (OC-04)

const DAEMON_READY_TIMEOUT_MS = 30_000;

function daemonPaths(flags: ParsedArgs["flags"]) {
  return resolveDaemonPaths(resolve(requireString(flags, "data-dir")));
}

function loadConfigFile(path: string): { ok: true; config: ProductConfig } | { ok: false; issues: readonly string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    return { ok: false, issues: [`配置读取/解析失败: ${(error as Error).message}`] };
  }
  const result = validateConfigObject(parsed);
  return result.ok ? { ok: true, config: result.config } : { ok: false, issues: result.issues };
}

/** 读取供应商配置文件（含密钥）。内容绝不打印、不进任何输出。 */
function loadProviderConfig(path: string): unknown {
  const raw = readFileSync(resolve(path), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("--provider-config 必须是 JSON 对象文件");
  }
  return parsed;
}

function emitJson(flags: ParsedArgs["flags"], value: unknown, text: string): CommandResult {
  return { exitCode: EXIT.ok, output: flags["json"] === true ? JSON.stringify(value, null, 2) : text };
}

async function commandDaemon(positional: readonly string[], flags: ParsedArgs["flags"]): Promise<CommandResult> {
  const sub = positional[1];
  if (sub === "start") {
    // 生产入口：**不接受**测试后端参数（由 assertKnownFlags 拒绝未知参数保证）。
    assertKnownFlags(flags, ["config", "data-dir", "opencode", "provider-config"]);
    const paths = daemonPaths(flags);
    const configPath = requireString(flags, "config");
    const config = loadConfigFile(configPath);
    if (!config.ok) {
      return { exitCode: EXIT.precondition, output: `配置不合法:\n${config.issues.map((issue) => `- ${issue}`).join("\n")}` };
    }
    const opencode = config.config.backends["opencode"];
    const opencodeEntry = opencode !== undefined && opencode.adapter === "opencode-http" ? opencode : undefined;
    const opencodeEnabled = opencodeEntry !== undefined && opencodeEntry.enabled;
    const executable = optionalString(flags, "opencode");
    const providerConfigPath = optionalString(flags, "provider-config");
    if (!opencodeEnabled && (executable !== undefined || providerConfigPath !== undefined)) {
      throw new UsageError("OpenCode 未配置或未启用；--opencode/--provider-config 只覆盖 OpenCode");
    }
    if (opencodeEnabled) {
      if (executable !== undefined && !isAbsolute(executable)) {
        throw new UsageError("--opencode 必须是绝对路径");
      }
      if (executable === undefined && (opencodeEntry.executable === null || opencodeEntry.executable === undefined)) {
        return { exitCode: EXIT.precondition, output: "缺少 --opencode <绝对路径>；daemon 需要独占启动受控 OpenCode 服务" };
      }
      if (providerConfigPath === undefined && (opencodeEntry.providerConfigFile === null || opencodeEntry.providerConfigFile === undefined)) {
        return { exitCode: EXIT.precondition, output: "缺少 --provider-config <绝对路径>；OpenCode 需要供应商配置" };
      }
      // 读取一次以尽早暴露错误；内容不打印。
      if (providerConfigPath !== undefined) loadProviderConfig(providerConfigPath);
    }

    const childArgs = [
      fileURLToPath(new URL("./main.ts", import.meta.url)),
      "daemon", "serve",
      "--data-dir", paths.dataRoot,
      "--config", resolve(configPath),
    ];
    if (opencodeEnabled) {
      if (providerConfigPath !== undefined) childArgs.push("--provider-config", resolve(providerConfigPath));
      if (executable !== undefined) childArgs.push("--opencode", executable);
    }
    const child = spawn(process.execPath, childArgs, { detached: true, stdio: "ignore" });
    child.unref();

    const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
    let lastError: string | null = null;
    while (Date.now() < deadline) {
      try {
        const status = (await ipcCall(paths.operatorSocket, "ping", {}, { timeoutMs: 1_000 })) as Record<string, unknown>;
        return emitJson(flags, status, `daemon 已启动 pid=${String(status["pid"])} serviceEpoch=${String(status["serviceEpoch"])}`);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 400));
      }
    }
    return {
      exitCode: EXIT.precondition,
      output: `daemon 未能在 ${DAEMON_READY_TIMEOUT_MS}ms 内就绪（子进程 pid=${child.pid ?? 0}）：${lastError ?? "无响应"}；可用 --data-dir 同目录前台运行 daemon serve 查看错误`,
    };
  }

  if (sub === "serve") {
    assertKnownFlags(flags, ["config", "data-dir", "opencode", "provider-config", "test-backend-cmd", "test-backend-scenario", "test-sdk-codebuddy", "test-sdk-qoder", "test-sdk-deadline-grace-ms"]);
    const paths = daemonPaths(flags);
    const configPath = resolve(requireString(flags, "config"));
    const config = loadConfigFile(configPath);
    if (!config.ok) {
      return { exitCode: EXIT.precondition, output: `配置不合法:\n${config.issues.map((issue) => `- ${issue}`).join("\n")}` };
    }
    const testBackendCmd = optionalString(flags, "test-backend-cmd");
    const testScenario = optionalString(flags, "test-backend-scenario");
    const executable = optionalString(flags, "opencode");
    const providerFlag = optionalString(flags, "provider-config");
    const opencode = config.config.backends["opencode"];
    const opencodeEntry = opencode !== undefined && opencode.adapter === "opencode-http" ? opencode : undefined;
    const opencodeEnabled = opencodeEntry !== undefined && opencodeEntry.enabled;
    if (!opencodeEnabled && (executable !== undefined || providerFlag !== undefined)) {
      throw new UsageError("OpenCode 未配置或未启用；--opencode/--provider-config 只覆盖 OpenCode");
    }
    let providerConfig: unknown;
    if (providerFlag !== undefined) {
      providerConfig = loadProviderConfig(providerFlag);
    } else if (opencodeEnabled && (opencodeEntry.providerConfigFile === null || opencodeEntry.providerConfigFile === undefined) && testBackendCmd === undefined) {
      return { exitCode: EXIT.precondition, output: "缺少 --provider-config <绝对路径>；OpenCode 需要供应商配置" };
    }
    if (testBackendCmd !== undefined) {
      // 测试通道必须成对出现，且 fixture 必须是绝对路径（避免相对路径歧义）。
      if (!isAbsolute(testBackendCmd)) throw new UsageError("--test-backend-cmd 必须是绝对路径");
      if (testScenario === undefined) throw new UsageError("--test-backend-cmd 需要配对 --test-backend-scenario");
    } else if (opencodeEnabled) {
      const effectiveExecutable = executable ?? opencodeEntry.executable;
      if (effectiveExecutable === null || effectiveExecutable === undefined) {
        return { exitCode: EXIT.precondition, output: "缺少 --opencode <绝对路径>；OpenCode 需要独占启动受控服务" };
      }
    }
    const { Daemon } = await import("../daemon/daemon.ts");
    const daemon = new Daemon({
      dataRoot: paths.dataRoot,
      config: config.config,
      ...(providerConfig !== undefined ? { providerConfig } : {}),
      ...(executable !== undefined ? { executable } : {}),
      sourceConfigPath: configPath,
      ...(providerFlag !== undefined ? { sourceProviderConfigPath: resolve(providerFlag) } : {}),
      ...(testBackendCmd !== undefined && testScenario !== undefined
        ? { testBackendCommand: { fixturePath: testBackendCmd, scenario: testScenario } }
        : {}),
      ...(() => {
        const cb = optionalString(flags, "test-sdk-codebuddy");
        const qd = optionalString(flags, "test-sdk-qoder");
        if (cb === undefined && qd === undefined) return {};
        if (cb !== undefined && !isAbsolute(cb)) throw new UsageError("--test-sdk-codebuddy 必须是绝对路径");
        if (qd !== undefined && !isAbsolute(qd)) throw new UsageError("--test-sdk-qoder 必须是绝对路径");
        return {
          testSdkModuleIds: {
            ...(cb === undefined ? {} : { codebuddy: cb }),
            ...(qd === undefined ? {} : { qoder: qd }),
          },
        };
      })(),
      ...(() => {
        const grace = optionalInt(flags, "test-sdk-deadline-grace-ms");
        if (grace === undefined) return {};
        if (grace < 1 || grace > 60_000) throw new UsageError("--test-sdk-deadline-grace-ms 必须在 1..60000 之间");
        if (optionalString(flags, "test-sdk-codebuddy") === undefined && optionalString(flags, "test-sdk-qoder") === undefined) {
          throw new UsageError("--test-sdk-deadline-grace-ms 只能与 --test-sdk-codebuddy/--test-sdk-qoder 一起使用");
        }
        return { testSdkDeadlineGraceMs: grace };
      })(),
      onEvent: (message) => {
        process.stderr.write(`[daemon] ${message}\n`);
      },
    });
    let reason: string | null = null;
    const shutdownOnce = (cause: string): void => {
      if (reason !== null) return;
      reason = cause;
      void daemon.shutdown(cause).catch(() => undefined);
    };
    process.on("SIGTERM", () => shutdownOnce("SIGTERM"));
    process.on("SIGINT", () => shutdownOnce("SIGINT"));
    await daemon.start();
    process.stderr.write(`[daemon] ready pid=${process.pid} dataRoot=${paths.dataRoot}\n`);
    while (daemon.isRunning) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
    }
    return { exitCode: EXIT.ok, output: `daemon 已停止（${reason ?? "unknown"}）` };
  }

  if (sub === "stop") {
    assertKnownFlags(flags, ["data-dir"]);
    const paths = daemonPaths(flags);
    const lock = new InstanceLock(paths.lockFile);
    const held = lock.peek();
    if (held === null) {
      return { exitCode: EXIT.precondition, output: `daemon 未在运行（没有可读的锁: ${paths.lockFile}）` };
    }
    try {
      await ipcCall(paths.operatorSocket, "daemon.shutdown", {}, { timeoutMs: 5_000 });
    } catch (error) {
      // IPC 不可达但锁进程还活着：核对身份后按 PID 兜底（防止身份不符的误杀）。
      if (processIdentity(held.pid) === held.identity) {
        try {
          process.kill(held.pid, "SIGTERM");
        } catch {
          // 已退出。
        }
      } else {
        return {
          exitCode: EXIT.precondition,
          output: `operator 通道不可达且锁进程身份无法确认（pid=${held.pid}），未发送任何信号；请人工核对`,
        };
      }
      void error;
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && held.pid !== process.pid && processIdentity(held.pid) !== null) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
    }
    return { exitCode: EXIT.ok, output: `daemon 停止请求已发送（pid=${held.pid}）` };
  }

  if (sub === "status") {
    assertKnownFlags(flags, ["data-dir"]);
    const paths = daemonPaths(flags);
    const lock = new InstanceLock(paths.lockFile);
    const held = lock.peek();
    if (held === null) {
      return { exitCode: EXIT.precondition, output: `daemon 未在运行（没有可读的锁: ${paths.lockFile}）` };
    }
    try {
      const status = (await ipcCall(paths.operatorSocket, "daemon.status", {}, { timeoutMs: 3_000 })) as Record<string, unknown>;
      return emitJson(flags, status, `daemon pid=${String(status["pid"])} serviceEpoch=${String(status["serviceEpoch"])} activeRun=${String(status["activeRunId"])} queue=${String((status["queue"] as unknown[] | undefined)?.length ?? 0)}`);
    } catch {
      return {
        exitCode: EXIT.precondition,
        output: `锁存在（pid=${held.pid}，startedAt=${held.startedAt}）但 IPC 无响应；可能正在启动或已僵死，请人工核对`,
      };
    }
  }

  throw new UsageError("用法: zbridge daemon <start|serve|stop|status> …");
}

async function commandOperator(positional: readonly string[], flags: ParsedArgs["flags"]): Promise<CommandResult> {
  const sub = positional[1];
  const paths = daemonPaths(flags);
  if (sub === "approvals") {
    assertKnownFlags(flags, ["data-dir"]);
    const result = (await ipcCall(paths.operatorSocket, "approval.list", {}, { timeoutMs: 5_000 })) as {
      approvals: Array<Record<string, unknown>>;
    };
    return emitJson(
      flags,
      result,
      result.approvals.length === 0
        ? "没有待批审批"
        : result.approvals
            .map((approval) =>
              [
                `${String(approval["approvalId"])} [${String(approval["state"])}] ${String(approval["toolName"])} ${String(approval["toolCallId"])}`,
                `  run=${String(approval["runId"])} attempt=${String(approval["attemptId"])} epoch=${String(approval["serverEpoch"])}`,
                `  args=${String(approval["argumentsText"])}`,
                `  payloadHash=${String(approval["payloadHash"])} expiresAt=${String(approval["expiresAt"])}`,
              ].join("\n"),
            )
            .join("\n"),
    );
  }
  if (sub === "decide") {
    assertKnownFlags(flags, ["data-dir", "approval-id", "decision", "payload-hash", "server-epoch", "attempt-id"]);
    const decision = requireString(flags, "decision");
    if (decision !== "allow_once" && decision !== "deny") {
      throw new UsageError("--decision 只支持 allow_once|deny");
    }
    const payload = {
      approvalId: requireString(flags, "approval-id"),
      decision,
      payloadHash: requireString(flags, "payload-hash"),
      serverEpoch: optionalInt(flags, "server-epoch") ?? 0,
      attemptId: requireString(flags, "attempt-id"),
    };
    const result = await ipcCall(paths.operatorSocket, "approval.decide", payload, { timeoutMs: 5_000 });
    return emitJson(flags, result, `决定已记录: ${JSON.stringify(result)}`);
  }
  if (sub === "release") {
    assertKnownFlags(flags, ["data-dir", "session-id", "note"]);
    const payload: Record<string, unknown> = { sessionId: requireString(flags, "session-id") };
    const note = optionalString(flags, "note");
    if (note !== undefined) payload["note"] = note;
    const result = await ipcCall(paths.operatorSocket, "session.release", payload, { timeoutMs: 5_000 });
    return emitJson(flags, result, `session 阻塞已解除: ${JSON.stringify(result)}`);
  }
  if (sub === "status") {
    assertKnownFlags(flags, ["data-dir"]);
    const status = (await ipcCall(paths.operatorSocket, "daemon.status", {}, { timeoutMs: 5_000 })) as Record<string, unknown>;
    return emitJson(flags, status, JSON.stringify(status, null, 2));
  }
  throw new UsageError("用法: zbridge operator <approvals|decide|release|status> …");
}

// ---------------------------------------------------------------- mcp (OC-05)

async function commandMcp(positional: readonly string[], flags: ParsedArgs["flags"]): Promise<CommandResult> {
  const sub = positional[1];
  if (sub === "serve") {
    assertKnownFlags(flags, ["data-dir"]);
    const paths = daemonPaths(flags);
    // gateway 不接受 config/provider/opencode 参数：它只连既有 daemon 的 client socket。
    const { runStdioGateway } = await import("../transport/gateway.ts");
    let transportClosed = false;
    process.on("SIGTERM", () => {
      if (!transportClosed) process.exit(0);
    });
    process.on("SIGINT", () => {
      if (!transportClosed) process.exit(0);
    });
    await runStdioGateway({
      dataDir: paths.dataRoot,
      onEvent: (message) => {
        process.stderr.write(`[mcp] ${message}\n`);
      },
    });
    transportClosed = true;
    return { exitCode: EXIT.ok, output: "" };
  }
  throw new UsageError("用法: zbridge mcp serve --data-dir <dir>");
}

async function commandRun(positional: readonly string[], flags: ParsedArgs["flags"]): Promise<CommandResult> {
  const sub = positional[1];
  const paths = daemonPaths(flags);
  if (sub === "start") {
    assertKnownFlags(flags, ["data-dir", "session-id", "workspace", "prompt", "client-request-id", "wait-ms", "model", "backend"]);
    const sessionId = optionalString(flags, "session-id");
    const workspace = optionalString(flags, "workspace");
    if (sessionId === undefined && workspace === undefined) {
      throw new UsageError("--session-id 与 --workspace 至少提供一个");
    }
    const waitMs = optionalInt(flags, "wait-ms");
    const model = optionalString(flags, "model");
    const backend = optionalString(flags, "backend");
    if (backend !== undefined && !["opencode", "codebuddy", "qoder"].includes(backend)) {
      throw new UsageError("--backend 只接受 opencode|codebuddy|qoder");
    }
    if (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(model)) {
      // 省略 backend 时可能是会话继承的 SDK 后端：原生单段 ID 与 OpenCode 双段均放行，
      // 具体格式与允许列表由 daemon 按会话/默认后端统一裁决。
      throw new UsageError("--model 必须是 providerID/modelID 或后端原生模型 ID");
    }
    const payload: Record<string, unknown> = {
      prompt: requireString(flags, "prompt"),
      clientRequestId: requireString(flags, "client-request-id"),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(workspace !== undefined ? { workspaceSlug: workspace } : {}),
      ...(waitMs !== undefined ? { waitMs } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(backend !== undefined ? { backend } : {}),
    };
    const result = await ipcCall(paths.clientSocket, "run.start", payload, {
      timeoutMs: Math.max(30_000, (waitMs ?? 0) + 15_000),
    });
    return emitJson(flags, result, `run 已受理: ${JSON.stringify(result)}`);
  }
  if (sub === "get") {
    assertKnownFlags(flags, ["data-dir", "run-id", "client-request-id"]);
    const runId = optionalString(flags, "run-id");
    const clientRequestId = optionalString(flags, "client-request-id");
    if (runId === undefined && clientRequestId === undefined) {
      throw new UsageError("--run-id 与 --client-request-id 至少提供一个");
    }
    const payload: Record<string, unknown> = {};
    if (runId !== undefined) payload["runId"] = runId;
    if (clientRequestId !== undefined) payload["clientRequestId"] = clientRequestId;
    const result = await ipcCall(paths.clientSocket, "run.get", payload, { timeoutMs: 5_000 });
    return emitJson(flags, result, JSON.stringify(result, null, 2));
  }
  if (sub === "events") {
    assertKnownFlags(flags, ["data-dir", "run-id", "after-seq", "limit"]);
    const payload: Record<string, unknown> = { runId: requireString(flags, "run-id") };
    const afterSeq = optionalInt(flags, "after-seq");
    const limit = optionalInt(flags, "limit");
    if (afterSeq !== undefined) payload["afterSeq"] = afterSeq;
    if (limit !== undefined) payload["limit"] = limit;
    const result = await ipcCall(paths.clientSocket, "run.events", payload, { timeoutMs: 5_000 });
    return emitJson(flags, result, JSON.stringify(result, null, 2));
  }
  if (sub === "result") {
    assertKnownFlags(flags, ["data-dir", "run-id"]);
    const result = await ipcCall(paths.clientSocket, "run.result", { runId: requireString(flags, "run-id") }, { timeoutMs: 5_000 });
    return emitJson(flags, result, JSON.stringify(result, null, 2));
  }
  if (sub === "stop") {
    assertKnownFlags(flags, ["data-dir", "run-id", "client-request-id", "intent"]);
    const runId = optionalString(flags, "run-id");
    const clientRequestId = optionalString(flags, "client-request-id");
    if (runId === undefined && clientRequestId === undefined) {
      throw new UsageError("--run-id 与 --client-request-id 至少提供一个");
    }
    const intent = optionalString(flags, "intent") ?? "cancel";
    if (intent !== "interrupt" && intent !== "cancel") {
      throw new UsageError("--intent 只支持 interrupt|cancel");
    }
    const payload: Record<string, unknown> = { intent };
    if (runId !== undefined) payload["runId"] = runId;
    if (clientRequestId !== undefined) payload["clientRequestId"] = clientRequestId;
    const result = await ipcCall(paths.clientSocket, "run.stop", payload, { timeoutMs: 30_000 });
    return emitJson(flags, result, JSON.stringify(result, null, 2));
  }
  throw new UsageError("用法: zbridge run <start|get|events|result|stop> …");
}

export async function runCommand(positional: readonly string[], flags: ParsedArgs["flags"]): Promise<CommandResult> {
  const command = positional[0];
  switch (command) {
    case "start":
    case "stop":
    case "restart":
    case "status":
    case "models":
    case "backends":
      return runManagementCommand(positional, flags, runCommand);
    case "version":
      return commandVersion(flags);
    case "doctor":
      return commandDoctor(flags);
    case "config":
      return runConfigCommand(positional, flags);
    case "tools":
      return commandTools(flags);
    case "fake":
      return commandFake(positional, flags);
    case "daemon":
      return commandDaemon(positional, flags);
    case "operator":
      return commandOperator(positional, flags);
    case "run":
      return commandRun(positional, flags);
    case "mcp":
      return commandMcp(positional, flags);
    case undefined:
      throw new UsageError("缺少命令；可用: version | doctor | config | tools | fake | daemon | operator | run | mcp");
    default:
      throw new UsageError(`未知命令 ${command}`);
  }
}
