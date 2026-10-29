/**
 * Qoder fake SDK（OC-09-04 离线测试专用；与 codebuddy fake 方言独立）。
 *
 * 场景标记：SCENARIO:text / :error / :no-result / :hard-tool / :ask-tool / :question / :mismatch / :hang
 * 另有 :stuck（interrupt/abort/return 均不生效）、:stuck-writer（同 stuck 且 CLI 持续写 marker）、
 * :bg-writer（正常取消后 CLI 继续写 marker）、:iterate-throw（无结构终态异常）以及
 * :iterate-max-turns / :iterate-budget / :iterate-exec-error（真实 QoderCliInitializationError 结构）。
 * AskUserQuestion 走输入停止；mismatch 的 assistant 模型固定为 qoder-mismatch。
 * 捕获 options 落盘 <stateRoot>/fake-qoder-sdk.json 供断言；spawn 真实 fake CLI 子进程。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const { QoderCliInitializationError } = await import(
  fileURLToPath(new URL("../../node_modules/@qoder-ai/qoder-agent-sdk/dist/index.js", import.meta.url))
);

let logPath = null;
const captured = {
  prompt: null,
  model: null,
  pathToQoderCLIExecutable: null,
  configDir: null,
  settingSources: null,
  authPresent: false,
  daemonRoute: false,
  resume: null,
  permissionMode: null,
  interruptCount: 0,
  interruptAcks: [],
  canUseToolCalls: [],
  cliChildPid: null,
};

function persist() {
  if (logPath !== null) {
    try {
      fs.writeFileSync(logPath, `${JSON.stringify(captured, null, 2)}\n`);
    } catch {
      /* 尽力而为 */
    }
  }
}

function accessToken(token) {
  // 验证 token 存在即回传标记对象（真实 SDK 会包成 InternalAuthOptions）。
  return { type: "accessToken", __fake: true, present: typeof token === "string" && token.length > 0 && token !== "oc09-unconfigured-placeholder" };
}

function query(params) {
  const options = params.options ?? {};
  captured.prompt = typeof params.prompt === "string" ? params.prompt : null;
  captured.model = options.model ?? null;
  captured.pathToQoderCLIExecutable = options.pathToQoderCLIExecutable ?? null;
  captured.configDir = options.extraArgs?.["config-dir"] ?? null;
  captured.settingSources = options.settingSources ?? null;
  captured.authPresent = options.auth?.present === true || options.daemon?.state === "ready";
  captured.daemonRoute = options.daemon !== undefined;
  captured.resume = options.resume ?? null;
  captured.permissionMode = options.permissionMode ?? null;

  if (typeof captured.configDir === "string") {
    logPath = `${captured.configDir.replace(/\/config$/, "")}/fake-qoder-sdk.json`;
    try {
      fs.mkdirSync(captured.configDir, { recursive: true });
    } catch {
      /* 目录已存在 */
    }
  }

  const prompt = String(captured.prompt ?? "");
  const writerMarker =
    typeof captured.configDir === "string" ? `${captured.configDir.replace(/\/config$/, "")}/background-marker` : null;
  const keepsWriting = prompt.includes("SCENARIO:bg-writer") || prompt.includes("SCENARIO:stuck-writer");
  const cliCode = keepsWriting && writerMarker !== null
    ? `setInterval(() => require("node:fs").appendFileSync(${JSON.stringify(writerMarker)}, "x"), 50)`
    : "setTimeout(() => process.exit(0), 120000)";
  const cliChild = spawn(process.execPath, ["-e", cliCode], { stdio: "ignore" });
  captured.cliChildPid = cliChild.pid;
  persist();

  let interrupted = false;
  const abortSignal = options.abortController?.signal ?? null;

  return {
    async interrupt() {
      captured.interruptCount += 1;
      interrupted = true;
      captured.interruptAcks = [{ uuid: "qmsg_interrupt-1" }];
      if (!keepsWriting) {
        // 正常 SDK 在 interrupt 后会收掉 CLI；writer 场景留给 adapter 的静止取证。
        try {
          cliChild.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
      }
      persist();
      return captured.interruptAcks;
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
      const yield_ = async function* (message) {
        yield message;
      };
      const self = this;
      return (async function* () {
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
              session_id: "qd-fake-session",
              stop_reason: null,
              modelUsage: {},
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
          session_id: "qd-fake-session",
          qodercli_version: "1.1.78-fake",
          protocol_version: "1",
          model: captured.model ?? "fake-qoder-model",
          tools: ["Read", "Write"],
        };
        if (prompt.includes("SCENARIO:iterate-throw")) {
          throw new Error("fake 迭代异常");
        }
        if (prompt.includes("SCENARIO:iterate-max-turns")) {
          throw new QoderCliInitializationError({
            type: "result",
            subtype: "error_max_turns",
            is_error: true,
            errors: ["fake 达到最大轮次"],
          });
        }
        if (prompt.includes("SCENARIO:iterate-budget")) {
          throw new QoderCliInitializationError({
            type: "result",
            subtype: "error_max_budget_usd",
            is_error: true,
            errors: ["fake 超出预算"],
          });
        }
        if (prompt.includes("SCENARIO:iterate-exec-error")) {
          throw new QoderCliInitializationError({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["fake 执行错误"],
          });
        }
        if (prompt.includes("SCENARIO:hard-tool")) {
          const decision = await options.canUseTool?.("Write", { file_path: "/tmp/x" }, { toolUseID: "tu_qd_hard" });
          captured.canUseToolCalls.push({ tool: "Write", decision });
          persist();
        }
        if (prompt.includes("SCENARIO:ask-tool")) {
          const decision = await options.canUseTool?.("Read", { file_path: "src/a.ts" }, { toolUseID: "tu_qd_soft" });
          captured.canUseToolCalls.push({ tool: "Read", decision });
          persist();
        }
        if (prompt.includes("SCENARIO:question")) {
          const decision = await options.canUseTool?.("AskUserQuestion", { questions: [{ question: "选哪个？" }] }, { toolUseID: "tu_qd_question" });
          captured.canUseToolCalls.push({ tool: "AskUserQuestion", decision });
          persist();
        }
        if (prompt.includes("SCENARIO:no-result")) {
          return;
        }
        yield {
          type: "assistant",
          uuid: "as_qd_1",
          session_id: "qd-fake-session",
          message: {
            id: "msg_qd_1",
            role: "assistant",
            model: prompt.includes("SCENARIO:mismatch") ? "qoder-mismatch" : (captured.model ?? "fake-qoder-model"),
            content: [{ type: "text", text: "QODER FAKE 完成文本" }],
          },
          parent_tool_use_id: null,
        };
        if (prompt.includes("SCENARIO:error")) {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["qoder fake 执行错误"],
            session_id: "qd-fake-session",
            stop_reason: "error",
            usage: { input_tokens: 3, output_tokens: 5 },
            modelUsage: { "qoder-max": { input_tokens: 3, output_tokens: 5 } },
            num_turns: 1,
          };
          return;
        }
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "QODER FAKE 结果",
          session_id: "qd-fake-session",
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 5 },
          modelUsage: { "qoder-max": { input_tokens: 3, output_tokens: 5 } },
          num_turns: 1,
        };
        void self;
      })();
    },
  };
}

function qodercliAuth() { return { type: "qodercli" }; }
async function startDaemon(options) {
  if (options.auth?.type !== "qodercli") throw new Error("wrong browser auth");
  return { state: "ready", async auth() { return true; }, async stop() { this.state = "stopped"; } };
}
export { query, accessToken, qodercliAuth, startDaemon };
