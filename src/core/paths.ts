/**
 * 数据目录布局（技术规格 §10）。
 *
 * 配置、业务库、工件、operator 数据、backend 状态各自独立子目录，
 * 为后续「分身份/分权限」留出边界。测试必须用 --data-dir 指向临时目录。
 *
 * 默认根已更名为 OpenCodeBridge；旧 ZCodeBridge 目录不静默搬移、不自动读取。
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface DataPaths {
  readonly root: string;
  readonly configDir: string;
  readonly configFile: string;
  readonly dataDir: string;
  readonly dbFile: string;
  readonly artifactsDir: string;
  readonly operatorDir: string;
  readonly logsDir: string;
  readonly backendDir: string;
  /** 每个 OpenCode 服务独占的运行目录（独立 HOME／XDG／config／data）。 */
  readonly backendRunDir: string;
}

export function defaultDataRoot(home: string = homedir()): string {
  return join(home, "Library", "Application Support", "OpenCodeBridge");
}

export function resolveDataPaths(root: string): DataPaths {
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  const backendDir = join(root, "backend");
  return {
    root,
    configDir,
    configFile: join(configDir, "config.json"),
    dataDir,
    dbFile: join(dataDir, "opencode-bridge.sqlite"),
    artifactsDir: join(root, "artifacts"),
    operatorDir: join(root, "operator"),
    logsDir: join(root, "logs"),
    backendDir,
    backendRunDir: join(backendDir, "run"),
  };
}
