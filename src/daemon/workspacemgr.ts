/**
 * 工作区登记与独立工作副本（OC-04 §2）。
 *
 * 硬规则：
 * - 登记只接受 realpath 之后的目录，路径规则沿用 `contracts/config.ts`；
 * - **普通重启不换 generation**：同 slug + 同 realpath + 同 profiles → 复用既有
 *   登记与副本。只有登记信息真正变化（root 变了拒绝同 slug；profiles 变化）
 *   或明确要求刷新副本时才递增 generation；
 * - 同 slug 但不同 realpath：直接拒绝，避免同一个名字悄悄换目录；
 * - 工作副本是**纯文件复制**：不执行任何 .git hooks、用户脚本或包管理器；
 * - 不复制 `.git`、凭据类文件（.env／*.key／auth.json…）与本地策略配置
 *   （.opencode／opencode.json／opencode.jsonc／.mcp.json…），
 *   worker 的配置由 daemon 受控生成；
 * - 不跟随逃逸 symlink：所有 symlink 条目一律跳过；
 * - 副本目标**排他新建**：目标已存在即拒绝（半成品/历史副本不覆盖）；
 *   源与目标重叠（互相包含）拒绝；复制失败清理半成品。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import type { ProductConfig } from "../contracts/config.ts";
import { checkWorkspaceRoot } from "../contracts/config.ts";
import { ZBridgeError } from "../contracts/errors.ts";
import type { Workspace, WorkspaceProfile } from "../contracts/workspace.ts";
import type { BridgeStore } from "../storage/index.ts";
import { ensureDaemonDir } from "./lock.ts";
import type { DaemonPaths } from "./layout.ts";

/** 完全跳过的目录名：版本库（含 hooks）与本产品不迁移的用户策略/依赖目录。 */
const SKIPPED_DIR_NAMES: ReadonlySet<string> = new Set([".git", ".opencode", ".claude", ".cursor", "node_modules"]);

/** 跳过的文件：凭据、密钥与本地策略/代理配置；命中即不复制，不计入错误。 */
const SKIPPED_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /^auth\.json$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /^id_ecdsa/i,
  /credentials\.json$/i,
  /^\.mcp\.json$/i,
  /^opencode\.json$/i,
  /^opencode\.jsonc$/i,
  /^\.opencode\.json$/i,
  /^\.opencode\.jsonc$/i,
  /^\.claude\.json$/i,
];

const MAX_COPY_FILES = 10_000;
const MAX_COPY_BYTES = 256 * 1024 * 1024;

export interface CopyReport {
  readonly files: number;
  readonly bytes: number;
  readonly skipped: number;
}

export interface RegistrationResult {
  readonly workspace: Workspace;
  readonly copyRoot: string | null;
  readonly copy: CopyReport | null;
  readonly generationBumped: boolean;
  readonly reused: boolean;
}

function skipFile(name: string): boolean {
  return SKIPPED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function sameProfiles(a: readonly WorkspaceProfile[], b: readonly WorkspaceProfile[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

function isInsidePath(candidate: string, ancestor: string): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}${sep}`);
}

export class WorkspaceManager {
  private readonly store: BridgeStore;
  private readonly paths: DaemonPaths;

  constructor(store: BridgeStore, paths: DaemonPaths) {
    this.store = store;
    this.paths = paths;
  }

  /**
   * daemon 启动时同步配置里的工作区。
   *
   * 重启语义：同 slug + 同 root + 同 profiles = 复用（generation 不变、副本不重建）。
   * profiles 变化 = 登记变化 → generation+1 并新建副本。root 变化 = 拒绝。
   */
  registerAllFromConfig(config: ProductConfig): RegistrationResult[] {
    const results: RegistrationResult[] = [];
    for (const entry of config.workspaces) {
      results.push(this.register(entry.id, entry.root, entry.profiles));
    }
    return results;
  }

  register(slug: string, root: string, profiles: readonly WorkspaceProfile[], options: { refreshCopy?: boolean } = {}): RegistrationResult {
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(slug)) {
      throw new ZBridgeError("INVALID_ARGUMENT", "workspace slug 只允许小写字母、数字和连字符（2–32 位）");
    }
    if (profiles.length === 0) {
      throw new ZBridgeError("INVALID_ARGUMENT", "workspace profiles 不能为空");
    }
    let real: string;
    try {
      const stat = statSync(root);
      if (!stat.isDirectory()) throw new Error("not a directory");
      real = realpathSync(root);
    } catch {
      throw new ZBridgeError("WORKSPACE_NOT_ALLOWED", "工作区 root 不存在或不是目录，拒绝登记");
    }
    const problem = checkWorkspaceRoot(real);
    if (problem !== null) {
      throw new ZBridgeError("WORKSPACE_NOT_ALLOWED", `工作区路径被拒绝: ${problem}`);
    }
    // realpath 可能穿过 symlink（macOS 的 /tmp → /private/tmp）：
    // 必须对 realpath 后的 root 与 realpath 后的 $TMPDIR 再比一次，否则
    // 登记规则会被 /var → /private/var 这类符号链接绕过。
    const tmpReal = (() => {
      try {
        return realpathSync(tmpdir());
      } catch {
        return tmpdir();
      }
    })();
    if (real === tmpReal || real.startsWith(`${tmpReal}${sep}`)) {
      throw new ZBridgeError(
        "WORKSPACE_NOT_ALLOWED",
        "root 不能位于 $TMPDIR 下：该限制来自旧的沙箱假设，OpenCode 路线尚未重新验证，暂保留",
      );
    }

    const existing = this.store.workspaces.list().find((candidate) => candidate.name === slug) ?? null;
    if (existing !== null && existing.canonicalRoot !== real) {
      throw new ZBridgeError("INVALID_ARGUMENT", `workspace ${slug} 已登记在其它目录；同 slug 换目录被拒绝，请改用新 slug`, {
        details: { registered: existing.canonicalRoot },
      });
    }

    ensureDaemonDir(this.paths.workspacesDir);

    if (existing !== null) {
      const profilesChanged = !sameProfiles(existing.profiles, profiles);
      if (!profilesChanged && !options.refreshCopy) {
        // 普通重启：复用登记与副本，不动 generation。
        const copyOk = existing.copyRoot !== null && existsSync(existing.copyRoot);
        if (existing.copyRoot === null || !copyOk) {
          // 副本缺失：重建同一 generation 的副本（排他目标；存在即拒绝）。
          const copyRoot = this.copyPathFor(slug, existing.generation);
          const copy = this.buildCopyExclusive(real, copyRoot);
          const workspace = this.store.workspaces.setCopyRoot(existing.workspaceId, copyRoot, this.store.now());
          return { workspace, copyRoot, copy, generationBumped: false, reused: true };
        }
        return { workspace: existing, copyRoot: existing.copyRoot, copy: null, generationBumped: false, reused: true };
      }
      // 登记信息变化：generation+1、新副本；旧 session 不自动扩权（存储层校验）。
      const generation = existing.generation + 1;
      const copyRoot = this.copyPathFor(slug, generation);
      const copy = this.buildCopyExclusive(real, copyRoot);
      let workspace: Workspace;
      try {
        workspace = this.store.workspaces.updateRegistration(
          existing.workspaceId,
          { generation, profiles, copyRoot },
          this.store.now(),
        );
      } catch (error) {
        try {
          rmSync(copyRoot, { recursive: true, force: true });
        } catch {
          // 清理失败不掩盖原始错误。
        }
        throw error;
      }
      return { workspace, copyRoot, copy, generationBumped: true, reused: false };
    }

    const generation = 1;
    const copyRoot = this.copyPathFor(slug, generation);
    const copy = this.buildCopyExclusive(real, copyRoot);
    let workspace: Workspace;
    try {
      workspace = this.store.createWorkspace({
        name: slug,
        canonicalRoot: real,
        profiles,
        copyRoot,
        generation,
      });
    } catch (error) {
      // 登记失败不能留下半套状态：删除刚建立的副本。
      try {
        rmSync(copyRoot, { recursive: true, force: true });
      } catch {
        // 清理失败不掩盖原始错误。
      }
      throw error;
    }
    return { workspace, copyRoot, copy, generationBumped: false, reused: false };
  }

  private copyPathFor(slug: string, generation: number): string {
    return join(this.paths.workspacesDir, `${slug}-g${String(generation)}`);
  }

  /** 排他新建副本：目标已存在即拒绝；重叠拒绝；失败清理半成品。 */
  private buildCopyExclusive(sourceRoot: string, destinationRoot: string): CopyReport {
    if (existsSync(destinationRoot) || existsSync(`${destinationRoot}${sep}`)) {
      throw new ZBridgeError("INVALID_ARGUMENT", `工作副本目标已存在，拒绝覆盖: ${basename(destinationRoot)}（人工确认后删除）`);
    }
    if (isInsidePath(destinationRoot, sourceRoot) || isInsidePath(sourceRoot, destinationRoot)) {
      throw new ZBridgeError("INVALID_ARGUMENT", "工作区 root 与副本目录重叠，拒绝登记");
    }
    try {
      mkdirSync(destinationRoot, { recursive: false, mode: 0o700 });
      const state = { files: 0, bytes: 0, skipped: 0 };
      copyTree(sourceRoot, destinationRoot, state, 0);
      return { files: state.files, bytes: state.bytes, skipped: state.skipped };
    } catch (error) {
      try {
        rmSync(destinationRoot, { recursive: true, force: true });
      } catch {
        // 清理失败不掩盖原始错误。
      }
      throw error;
    }
  }
}

export function buildWorkingCopy(sourceRoot: string, destinationRoot: string): CopyReport {
  mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  const state = { files: 0, bytes: 0, skipped: 0 };
  copyTree(sourceRoot, destinationRoot, state, 0);
  return { files: state.files, bytes: state.bytes, skipped: state.skipped };
}

function copyTree(source: string, destination: string, state: { files: number; bytes: number; skipped: number }, depth: number): void {
  if (depth > 32) {
    throw new ZBridgeError("INVALID_ARGUMENT", "工作副本目录过深（>32 层），拒绝复制");
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(source, { withFileTypes: true }) as unknown as Dirent[];
  } catch (error) {
    throw new ZBridgeError("INVALID_ARGUMENT", `无法读取工作区目录 ${basename(source)}: ${(error as Error).message}`);
  }
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      // 不跟随：既防逃逸（指向登记范围外），也防把用户目录结构带进受控副本。
      state.skipped += 1;
      continue;
    }
    if (entry.isDirectory()) {
      if (SKIPPED_DIR_NAMES.has(entry.name)) {
        state.skipped += 1;
        continue;
      }
      mkdirSync(destinationPath, { recursive: true, mode: 0o700 });
      copyTree(sourcePath, destinationPath, state, depth + 1);
      continue;
    }
    if (!entry.isFile()) {
      // FIFO、socket、设备等一律跳过；副本里只需要源代码与文本。
      state.skipped += 1;
      continue;
    }
    if (skipFile(entry.name)) {
      state.skipped += 1;
      continue;
    }
    const stat = statSync(sourcePath);
    state.files += 1;
    state.bytes += stat.size;
    if (state.files > MAX_COPY_FILES) {
      throw new ZBridgeError("RESOURCE_EXHAUSTED", `工作副本超过 ${MAX_COPY_FILES} 个文件上限，登记失败`);
    }
    if (state.bytes > MAX_COPY_BYTES) {
      throw new ZBridgeError("RESOURCE_EXHAUSTED", `工作副本超过 ${MAX_COPY_BYTES} 字节上限，登记失败`);
    }
    copyFileSync(sourcePath, destinationPath);
  }
}
