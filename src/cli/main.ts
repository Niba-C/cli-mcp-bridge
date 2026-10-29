/**
 * zbridge 入口。只做三件事：版本闸门、参数解析、把结果写到 stdout/stderr。
 * 业务逻辑一律在 commands.ts，保证 CLI 层不偷偷产生副作用。
 *
 * `zbridge` 是兼容命令名；产品名为 CLI MCP Bridge，旧命令与运行数据路径保持兼容。
 */
import { parseArgs, UsageError } from "./args.ts";
import { EXIT, runCommand } from "./commands.ts";

const USAGE = `用法: cli-mcp-bridge <command> [options]（ocbridge / zbridge 仍可用）
       产品 CLI MCP Bridge，配置 schemaVersion=3

命令:
  start / stop / restart / status [--json]   使用本机默认路径管理 MCP 后台
          [--data-dir <d>]                  stop/restart 遇到活动任务时可显式 --force
          status [--backend <id>]           查看各后端加载状态与差异（不连接后端）
  start / restart [--config <p>] [--provider-config <p>] [--opencode <abs>]
  backends list|show <id>|configure <id>|enable|disable|default|probe
                                            管理固定后端 opencode/codebuddy/qoder
  models list [--backend <id>] [--available] [--from <json/jsonc>] [--json]
                                            查看允许列表或本地供应商声明的模型
  models add provider/model [--backend <id>] [--from <json/jsonc>] [--default]
  models remove <model> [--backend <id>] [--replacement <model>]
  models default <model> [--backend <id>]   设置新会话默认模型；改后 restart 生效
          models 支持 --config / --provider-config / --data-dir 指向另一套配置
  version                                   版本、契约版本与配置版本
  doctor [--config <path>] [--data-dir <dir>] [--json]
                                            本地自检（不联网、不调模型、不启动 OpenCode）
  config init --out <path> [--backend <id>] [--executable <abs>] [--model <id>]
           [--auth cli-login|credential-file] [--auth-file <path>]
                                            生成示例配置（不覆盖已有文件）
  config validate (--file <path> | --config <path>) [--json]
                                            只校验 schema/路径，不启动后端
  config migrate --config <path> [--opencode <abs>] [--provider-config <p>] [--json]
                                            v2 → v3 迁移（自动备份原文件）
  tools list [--json]                       工具面与注册状态
  fake list [--json]                        可用的 fake 场景
  fake run --scenario <name> [--approval allow|deny|timeout]
           [--stop-after-ms <n>] [--stop-intent interrupt|cancel|close]
           [--out <path>] [--json]          离线跑一次 fake 执行
  daemon start --config <p> --data-dir <d> [--provider-config <p>]
           [--opencode <abs>] [--json]      启动本地 daemon（OpenCode 启用时才需要后端参数）
  daemon serve --data-dir <d> --config <p> [--provider-config <p>]
           [--opencode <abs>]               前台运行 daemon（内部/调试入口）
  daemon stop --data-dir <d>                通过 operator 通道关停 daemon
  daemon status --data-dir <d> [--json]     查询 daemon 状态
  operator approvals --data-dir <d> [--json]      列出待批审批（operator 通道）
  operator decide --data-dir <d> --approval-id <id> --decision allow_once|deny
           --payload-hash <h> --server-epoch <n> --attempt-id <a> [--json]
  operator release --data-dir <d> --session-id <id> [--note <s>] [--json]
  run start --data-dir <d> (--session-id <id> | --workspace <slug>)
           --prompt <text> --client-request-id <id> [--wait-ms <ms>] [--json]
  run get --data-dir <d> (--run-id <id> | --client-request-id <id>) [--json]
  run events --data-dir <d> --run-id <id> [--after-seq <n>] [--limit <n>] [--json]
  run result --data-dir <d> --run-id <id> [--json]
  run stop --data-dir <d> (--run-id <id> | --client-request-id <id>)
           [--intent interrupt|cancel] [--json]
  mcp serve --data-dir <d>                  MCP stdio gateway（stdout 仅 MCP 帧，诊断走 stderr）

退出码: 0 成功 / 1 未预期错误 / 2 用法错误 / 3 主动拒绝 / 4 前置条件不满足 / 5 未实现`;

function majorOf(version: string): number {
  return Number.parseInt(version.split(".")[0] ?? "0", 10);
}

const major = majorOf(process.versions.node);
if (major < 22) {
  process.stderr.write(`zbridge 需要 Node >=22.18（基线 24.18.0），当前 ${process.versions.node}\n`);
  process.exit(EXIT.precondition);
}
if (major < 24) {
  process.stderr.write(
    `警告: Node ${process.versions.node} 不在支持范围（基线 24.18.0，engines 要求 >=24）；` +
      "只用于临时排查，不得作为验收环境\n",
  );
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(argv.length === 0 ? EXIT.usage : EXIT.ok);
}

try {
  const parsed = parseArgs(argv);
  const result = await runCommand(parsed.positional, parsed.flags);
  // mcp serve 的 stdout 属于 MCP 帧；空输出不追加换行，避免污染协议流。
  if (result.output.length > 0) {
    process.stdout.write(`${result.output}\n`);
  }
  process.exit(result.exitCode);
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    process.exit(EXIT.usage);
  }
  const message = error instanceof Error ? error.message : "未知错误";
  const code = (error as { code?: unknown }).code;
  const prefix = typeof code === "string" ? `${code}: ` : "";
  process.stderr.write(`zbridge 失败: ${prefix}${message}\n`);
  const exitCode = (error as { exitCode?: unknown }).exitCode;
  process.exit(
    typeof exitCode === "number" && exitCode >= 0 && exitCode <= 5 ? exitCode : EXIT.error,
  );
}
