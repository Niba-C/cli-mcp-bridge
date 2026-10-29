/**
 * daemon 本地布局（技术规格 §10 的 `operatorDir` 细分）。
 *
 * 所有受控文件集中在一个 0700 目录里：实例锁、两条 Unix IPC socket（普通客户端
 * 与 operator 分开）、运行信息与 backend 请求日志。socket 权限是本机身份边界的
 * **一部分**而不是全部——同 macOS 用户的进程仍然能连上，这一点在边界记录里如实写明。
 */
import { join } from "node:path";

export interface DaemonPaths {
  readonly dataRoot: string;
  readonly daemonDir: string;
  readonly lockFile: string;
  readonly clientSocket: string;
  readonly operatorSocket: string;
  readonly runInfoFile: string;
  readonly principalFile: string;
  readonly workspacesDir: string;
  readonly artifactsDir: string;
  readonly backendLog: string;
}

export function resolveDaemonPaths(dataRoot: string): DaemonPaths {
  const daemonDir = join(dataRoot, "daemon");
  return {
    dataRoot,
    daemonDir,
    lockFile: join(daemonDir, "daemon.lock"),
    clientSocket: join(daemonDir, "client.sock"),
    operatorSocket: join(daemonDir, "operator.sock"),
    runInfoFile: join(daemonDir, "daemon.json"),
    principalFile: join(dataRoot, "operator", "principal.json"),
    workspacesDir: join(dataRoot, "workspaces"),
    artifactsDir: join(dataRoot, "artifacts"),
    backendLog: join(daemonDir, "backend-requests.jsonl"),
  };
}
