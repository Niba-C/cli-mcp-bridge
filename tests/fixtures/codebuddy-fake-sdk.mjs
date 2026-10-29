/**
 * CodeBuddy fake SDK（OC-09-03 离线测试专用）。
 *
 * 实现 worker-main.ts 消费的 SDK 最小表面（query + connect + 异步迭代 +
 * interrupt），不 import 真实 SDK。scenario 由 prompt 内嵌标记驱动：
 *   SCENARIO:text            → init + assistant 文本 + result success
 *   SCENARIO:error           → result error_during_execution
 *   SCENARIO:no-result       → 迭代直接结束（无结构终态）
 *   SCENARIO:hard-tool       → 调 canUseTool("Write")（应被 worker 硬拒绝）
 *   SCENARIO:ask-tool        → 调 canUseTool("Read")（走 daemon 审批队列）
 *   SCENARIO:question        → 调 canUseTool("AskUserQuestion")（应走不支持输入停止）
 *   SCENARIO:mismatch        → assistant 报 glm-mismatch（验证 B06 身份矛盾）
 *   SCENARIO:hang            → 不产出任何消息直到 interrupt/abort
 *   SCENARIO:stuck           → interrupt/abort/return 都不生效（adapter 超时与组回收升级路径）
 *   SCENARIO:stuck-writer    → 同 stuck，且 CLI 子进程持续写 marker（回收期间不得重叠的取证）
 *   SCENARIO:bg-writer       → 正常取消后 CLI 子进程仍继续写 marker（正常取消静止取证）
 *   SCENARIO:iterate-throw   → init 后迭代抛出无结构终态异常（必须保持 unknown）
 *   SCENARIO:iterate-max-turns / :iterate-budget / :iterate-exec-error
 *                            → 抛真实 ExecutionError（保留 subtype 映射）
 * 另外 spawn 一个受控 fake CLI 子进程（真实子进程边界：owned_pids 观察与回收）。
 * 记录收到的 options 供断言（--fake-log <path> 落盘 JSON）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const { ExecutionError } = await import(
  fileURLToPath(new URL("../../node_modules/@tencent-ai/agent-sdk/lib/errors.js", import.meta.url))
);

// 日志路径由调用侧经 CODEBUDDY_CONFIG_DIR 推导（worker argv 不透传测试参数）：
// <stateRoot>/config → <stateRoot>/fake-sdk.json
let logPath = null;

const captured = {
  prompt: null,
  model: null,
  pathToCodebuddyCode: null,
  envCodebuddyConfigDir: null,
  settingSources: null,
  sessionId: null,
  resume: null,
  permissionMode: null,
  interruptCount: 0,
  canUseToolCalls: [],
  cliChildPid: null,
};

function persist() {
  if (logPath !== null) {
    try {
      fs.writeFileSync(logPath, `${JSON.stringify(captured, null, 2)}\n`);
    } catch {
      /* 日志尽力而为 */
    }
  }
}

function query(params) {
  const options = params.options ?? {};
  captured.prompt = params.prompt ?? null;
  captured.model = options.model ?? null;
  captured.pathToCodebuddyCode = options.pathToCodebuddyCode ?? null;
  captured.envCodebuddyConfigDir = options.env?.CODEBUDDY_CONFIG_DIR ?? null;
  if (typeof captured.envCodebuddyConfigDir === "string") {
    logPath = `${captured.envCodebuddyConfigDir.replace(/\/config$/, "")}/fake-sdk.json`;
    try {
      fs.mkdirSync(captured.envCodebuddyConfigDir.replace(/\/config$/, ""), { recursive: true });
    } catch {
      /* 目录已存在 */
    }
  }
  captured.settingSources = options.settingSources ?? null;
  captured.sessionId = options.sessionId ?? null;
  captured.resume = options.resume ?? null;
  captured.permissionMode = options.permissionMode ?? null;

  const prompt = String(params.prompt ?? "");
  const writerMarker =
    typeof captured.envCodebuddyConfigDir === "string"
      ? `${captured.envCodebuddyConfigDir.replace(/\/config$/, "")}/background-marker`
      : null;
  const keepsWriting = prompt.includes("SCENARIO:bg-writer") || prompt.includes("SCENARIO:stuck-writer");
  // fake CLI 子进程：worker 的 owned_pids 会观察到它，close 后必须被回收。
  // writer 场景每 50ms 追加一字节，用于证明“确认停止后后台仍在执行”。
  const cliCode = keepsWriting && writerMarker !== null
    ? `setInterval(() => require("node:fs").appendFileSync(${JSON.stringify(writerMarker)}, "x"), 50)`
    : "setTimeout(() => process.exit(0), 120000)";
  const cliChild = spawn(process.execPath, ["-e", cliCode], {
    stdio: "ignore",
  });
  captured.cliChildPid = cliChild.pid;
  persist();

  let interrupted = false;
  let abortSignal = options.abortController?.signal ?? null;

  return {
    async connect() {
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    async interrupt() {
      captured.interruptCount += 1;
      interrupted = true;
      // 正常 SDK 在 interrupt 后会收掉 CLI；writer 场景故意留下它，
      // 由 adapter 的静止取证/回收路径收口。
      if (!keepsWriting) {
        try {
          cliChild.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
      }
      persist();
    },
    async return() {
      if (prompt.includes("SCENARIO:stuck")) {
        // 连 worker 的 shutdown/return 也卡住：只有 adapter 的组回收能收口。
        await new Promise(() => {});
      }
      try {
        cliChild.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    },
    [Symbol.asyncIterator]() {
      const self = this;
      return (async function* () {
        const yield_ = async function* (message) {
          yield message;
        };
        if (prompt.includes("SCENARIO:hang") || prompt.includes("SCENARIO:bg-writer")) {
          await new Promise((resolve) => {
            const timer = setInterval(() => {
              if (interrupted || abortSignal?.aborted) {
                clearInterval(timer);
                resolve(undefined);
              }
            }, 50);
          });
          if (interrupted) {
            yield* yield_({
              type: "result",
              subtype: "error_during_execution",
              is_error: true,
              errors: ["interrupted"],
              session_id: "cb-fake-session",
              usage: { input_tokens: 1, output_tokens: 1 },
              num_turns: 1,
            });
          }
          return;
        }
        if (prompt.includes("SCENARIO:stuck")) {
          // 模拟「interrupt/abort 都不生效」的卡死轮次：adapter 超时后必须自行升级停止。
          await new Promise(() => {});
        }
        yield {
          type: "system",
          subtype: "init",
          session_id: "cb-fake-session",
          model: captured.model ?? "fake-model",
          codebuddy_code_version: "2.173.0-fake",
          tools: ["Read", "Write", "Bash"],
          permissionMode: "default",
        };
        if (prompt.includes("SCENARIO:iterate-throw")) {
          throw new Error("fake 迭代异常");
        }
        if (prompt.includes("SCENARIO:iterate-max-turns")) {
          throw new ExecutionError(["fake 达到最大轮次"], "error_max_turns");
        }
        if (prompt.includes("SCENARIO:iterate-budget")) {
          throw new ExecutionError(["fake 超出预算"], "error_max_budget_usd");
        }
        if (prompt.includes("SCENARIO:iterate-exec-error")) {
          throw new ExecutionError(["fake 执行错误"], "error_during_execution");
        }
        if (prompt.includes("SCENARIO:hard-tool")) {
          const decision = await options.canUseTool?.("Write", { file_path: "/tmp/x" }, { toolUseID: "tu_hard" });
          captured.canUseToolCalls.push({ tool: "Write", decision });
          persist();
        }
        if (prompt.includes("SCENARIO:ask-tool")) {
          const decision = await options.canUseTool?.("Read", { file_path: "src/a.ts" }, { toolUseID: "tu_soft" });
          captured.canUseToolCalls.push({ tool: "Read", decision });
          persist();
        }
        if (prompt.includes("SCENARIO:question")) {
          const decision = await options.canUseTool?.("AskUserQuestion", { questions: [{ question: "选哪个？" }] }, { toolUseID: "tu_question" });
          captured.canUseToolCalls.push({ tool: "AskUserQuestion", decision });
          persist();
        }
        if (prompt.includes("SCENARIO:no-result")) {
          return;
        }
        yield {
          type: "assistant",
          uuid: "as_1",
          session_id: "cb-fake-session",
          message: {
            id: "msg_1",
            role: "assistant",
            model: prompt.includes("SCENARIO:mismatch") ? "glm-mismatch" : (captured.model ?? "fake-model"),
            content: [{ type: "text", text: "FAKE 完成文本" }],
            stop_reason: null,
            usage: { input_tokens: 3, output_tokens: 5 },
          },
          parent_tool_use_id: null,
        };
        if (prompt.includes("SCENARIO:error")) {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["fake 执行错误"],
            session_id: "cb-fake-session",
            usage: { input_tokens: 3, output_tokens: 5 },
            num_turns: 1,
          };
          return;
        }
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "FAKE 结果",
          session_id: "cb-fake-session",
          usage: { input_tokens: 3, output_tokens: 5 },
          num_turns: 1,
        };
        void self;
      })();
    },
  };
}

export { query };
