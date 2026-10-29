/**
 * 工件管理（OC-05）。daemon 侧受控目录 + 读取校验。
 *
 * - 工件文件只存在 daemon 的 `dataRoot/artifacts/` 下；数据库保存
 *   artifactId/sha256/bytes/owner/run 归属，`internalPath` 是相对工件根的路径，
 *   **绝不**出现在 MCP 返回值里；
 * - 每个 run 收敛后生成三个工件：结果文本、事件记录（JSONL）、工作副本 diff；
 *   diff 对比**本轮派发前**的基线快照，用户在登记前就有的改动不会算进本轮
 *   （基线在派发前落快照，只读任务正常应得到空 diff）；
 * - 读取只接受 artifactId：校验 owner、mediaType、真实大小与 sha256，
 *   realpath 必须仍落在工件根内（symlink 逃逸拒绝）；
 *   二进制内容不按 UTF-8 破损返回，明确报错；
 * - 配额复用配置 limits：artifactMaxBytes（单工件）、artifactBytesPerRun、
 *   artifactBytesGlobal；超限时截断并写入显式标记，不假装完整。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { ProductLimits } from "../contracts/config.ts";
import { ZBridgeError } from "../contracts/errors.ts";
import type { ArtifactId, PrincipalId, RunId } from "../contracts/ids.ts";
import { sliceByCodePoints, type TextPage } from "../contracts/paging.ts";
import type { Artifact, ArtifactMeta } from "../contracts/artifacts.ts";
import type { Principal } from "../contracts/common.ts";
import type { BridgeStore } from "../storage/index.ts";

const MAX_WALK_FILES = 10_000;
const MAX_WALK_BYTES = 256 * 1024 * 1024;
const WALK_MAX_DEPTH = 32;
/** 单次读取与 contracts/paging.ts 的上限一致。 */
const READ_MAX_CHARS = 16_000;

export interface WorkspaceFileSnapshot {
  readonly files: ReadonlyMap<string, { readonly sha256: string; readonly bytes: number }>;
  readonly truncated: boolean;
}

export interface CaptureReport {
  readonly artifacts: readonly ArtifactMeta[];
  readonly notes: readonly string[];
}

interface WalkResult {
  readonly files: Map<string, { sha256: string; bytes: number }>;
  readonly truncated: boolean;
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function walkFiles(root: string): WalkResult {
  const files = new Map<string, { sha256: string; bytes: number }>();
  let truncated = false;
  let totalBytes = 0;
  const visit = (dir: string, prefix: string, depth: number): void => {
    if (truncated) return;
    if (depth > WALK_MAX_DEPTH) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      truncated = true;
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // 不跟随：逃逸与外部内容都不进快照
      if (entry.isDirectory()) {
        visit(full, relative, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = statSync(full);
      } catch {
        truncated = true;
        return;
      }
      totalBytes += stat.size;
      if (files.size >= MAX_WALK_FILES || totalBytes > MAX_WALK_BYTES) {
        truncated = true;
        return;
      }
      try {
        files.set(relative, { sha256: sha256Hex(readFileSync(full)), bytes: stat.size });
      } catch {
        truncated = true;
        return;
      }
    }
  };
  visit(root, "", 0);
  return { files, truncated };
}

export class ArtifactManager {
  private readonly store: BridgeStore;
  private readonly root: string;
  private readonly limits: ProductLimits;
  private readonly baselines = new Map<RunId, WorkspaceFileSnapshot>();

  constructor(store: BridgeStore, artifactsDir: string, limits: ProductLimits) {
    this.store = store;
    this.root = artifactsDir;
    this.limits = limits;
  }

  /** 派发前快照工作副本；daemon 重启会丢失内存基线，diff 工件将如实标注。 */
  captureBaseline(runId: RunId, copyRoot: string): void {
    const walk = walkFiles(copyRoot);
    this.baselines.set(runId, { files: walk.files, truncated: walk.truncated });
  }

  private artifactPath(runId: RunId, artifactId: ArtifactId): string {
    return join(runId, `${artifactId}.txt`);
  }

  private writeArtifactFile(runId: RunId, artifactId: ArtifactId, content: string): { path: string; bytes: number } {
    const dir = join(this.root, runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const full = join(dir, `${artifactId}.txt`);
    const buffer = Buffer.from(content, "utf8");
    // 排他创建：同 ID 已有文件即失败，绝不覆盖旧工件。
    writeFileSync(full, buffer, { mode: 0o600, flag: "wx" });
    return { path: this.artifactPath(runId, artifactId), bytes: buffer.byteLength };
  }

  private quotaOk(runId: RunId, incomingBytes: number, notes: string[]): boolean {
    const globalBytes = this.store.artifacts.sumBytes(null);
    const runBytes = this.store.artifacts.sumBytes(runId);
    if (globalBytes + incomingBytes > this.limits.artifactBytesGlobal) {
      notes.push(`artifact 全局配额已满（${globalBytes}+${incomingBytes} > ${this.limits.artifactBytesGlobal}），跳过写入`);
      return false;
    }
    if (runBytes + incomingBytes > this.limits.artifactBytesPerRun) {
      notes.push(`artifact 单 run 配额已满（${runBytes}+${incomingBytes} > ${this.limits.artifactBytesPerRun}），跳过写入`);
      return false;
    }
    return true;
  }

  private registerArtifact(input: {
    readonly runId: RunId;
    readonly ownerId: PrincipalId;
    readonly name: string;
    readonly content: string;
    readonly notes: string[];
  }): ArtifactMeta | null {
    const artifactId = this.store.ids.artifact();
    let content = input.content;
    let truncated = false;
    const originalBytes = Buffer.byteLength(content, "utf8");
    if (originalBytes > this.limits.artifactMaxBytes) {
      // 单工件超限：按 code point 截断（不产生替代字符），截断标记**计入**配额，
      // 最终字节数必须 ≤ artifactMaxBytes。
      const marker = `\n# TRUNCATED: 原始 ${originalBytes} 字节超过单工件配额 ${this.limits.artifactMaxBytes}\n`;
      const budget = this.limits.artifactMaxBytes - Buffer.byteLength(marker, "utf8");
      let cut = "";
      let used = 0;
      for (const ch of content) {
        const charBytes = Buffer.byteLength(ch, "utf8");
        if (used + charBytes > budget) break;
        cut += ch;
        used += charBytes;
      }
      content = cut + marker;
      truncated = true;
      input.notes.push(`artifact ${input.name} 超过单工件配额，已按码点截断到 ${Buffer.byteLength(content, "utf8")} 字节`);
    }
    const bytes = Buffer.byteLength(content, "utf8");
    // 先预算后落盘：配额拒绝时不产生任何未登记文件（缺失的 label 对外可见）。
    if (!this.quotaOk(input.runId, bytes, input.notes)) {
      return null;
    }
    let file: { path: string; bytes: number };
    try {
      file = this.writeArtifactFile(input.runId, artifactId, content);
    } catch (error) {
      // 排他落盘失败（重名/磁盘）：不登记，也不留下半成品文件。
      input.notes.push(`artifact ${input.name} 落盘失败: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    let artifact: Artifact;
    try {
      artifact = this.store.addArtifact({
        artifactId,
        ownerId: input.ownerId,
        runId: input.runId,
        mediaType: "text/plain; charset=utf-8",
        sha256: sha256Hex(Buffer.from(content, "utf8")),
        bytes: file.bytes,
        internalPath: file.path,
        provenance: "daemon_capture",
        label: input.name,
        truncated,
      });
    } catch (error) {
      // 登记失败必须清理已落盘文件，否则重复运行会无限占磁盘。
      try {
        rmSync(join(this.root, file.path), { force: true });
      } catch {
        // 清理失败不掩盖登记错误。
      }
      throw error;
    }
    return toMeta(artifact);
  }

  /**
   * run 收敛后生成结果／事件／diff 工件。失败只记录说明，不影响 run 终态。
   */
  captureRunArtifacts(input: {
    readonly runId: RunId;
    readonly state: string;
    readonly ownerId: PrincipalId;
    readonly copyRoot: string | null;
  }): CaptureReport {
    const notes: string[] = [];
    const artifacts: ArtifactMeta[] = [];
    // 基线必须存活到 diff 生成之后才能释放；提前删除会让所有正常 run 误报
    // 「基线不可用」。释放动作在本方法末尾执行。

    // 1) 结果文本（agentReported；observed/verification 保持经 agent_result 通道读取）
    try {
      const manifest = this.store.results.getByRun(input.runId);
      const agentText = manifest === null ? "" : manifest.agentReported.join("\n\n");
      const content = [
        `# run result text`,
        `# runId: ${input.runId}`,
        `# state: ${input.state}`,
        `# 注意: agentReported 是模型自述，不是 verification 证据`,
        "",
        agentText.length === 0 ? "(模型未返回正文)" : agentText,
        "",
      ].join("\n");
      const artifact = this.registerArtifact({
        runId: input.runId,
        ownerId: input.ownerId,
        name: "result",
        content,
        notes,
      });
      if (artifact !== null) artifacts.push(artifact);
    } catch (error) {
      notes.push(`结果工件生成失败: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 2) 事件记录（JSONL，分页读完；超过单工件配额由 registerArtifact 截断标记）
    try {
      const lines: string[] = [`# run events JSONL`, `# runId: ${input.runId}`];
      let afterSeq = 0;
      for (;;) {
        const page = this.store.readEvents(input.runId, { afterSeq, limit: 500 });
        for (const event of page.events) {
          lines.push(
            JSON.stringify({ seq: event.seq, type: event.type, at: event.at, state: event.state ?? null, payload: event.payload }),
          );
        }
        if (!page.hasMore) break;
        afterSeq = page.nextSeq;
      }
      const artifact = this.registerArtifact({
        runId: input.runId,
        ownerId: input.ownerId,
        name: "events",
        content: `${lines.join("\n")}\n`,
        notes,
      });
      if (artifact !== null) artifacts.push(artifact);
    } catch (error) {
      notes.push(`事件工件生成失败: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 3) 工作副本 diff（基线 -> 当前；排除登记前已有改动）
    try {
      const content = this.diffContent(input.runId, input.copyRoot);
      const artifact = this.registerArtifact({
        runId: input.runId,
        ownerId: input.ownerId,
        name: "workspace-diff",
        content,
        notes,
      });
      if (artifact !== null) artifacts.push(artifact);
    } catch (error) {
      notes.push(`diff 工件生成失败: ${error instanceof Error ? error.message : String(error)}`);
    }

    // diff 已经生成完毕，现在才能释放内存基线。
    this.baselines.delete(input.runId);
    return { artifacts, notes };
  }

  private diffContent(runId: RunId, copyRoot: string | null): string {
    const header = [`# workspace diff (本轮派发前基线 -> run 收敛时)`, `# runId: ${runId}`];
    const baseline = this.baselines.get(runId);
    if (copyRoot === null) {
      return [...header, "# 工作副本缺失，无法生成 diff", ""].join("\n");
    }
    if (baseline === undefined) {
      return [...header, "# 基线不可用（daemon 在本轮执行期间重启，内存基线丢失）；不声称空 diff 也不声称有改动", ""].join("\n");
    }
    const current = walkFiles(copyRoot);
    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];
    for (const [path, before] of baseline.files) {
      const after = current.files.get(path);
      if (after === undefined) removed.push(path);
      else if (after.sha256 !== before.sha256) modified.push(path);
    }
    for (const path of current.files.keys()) {
      if (!baseline.files.has(path)) added.push(path);
    }
    const lines = [...header];
    if (baseline.truncated || current.truncated) {
      lines.push("# WARNING: 基线或当前快照被截断（文件数/字节超界），diff 可能不完整");
    }
    lines.push(`# added=${added.length} modified=${modified.length} deleted=${removed.length}`);
    for (const path of [...added].sort()) lines.push(`A ${path}`);
    for (const path of [...modified].sort()) lines.push(`M ${path}`);
    for (const path of [...removed].sort()) lines.push(`D ${path}`);
    if (added.length === 0 && modified.length === 0 && removed.length === 0) {
      lines.push("no file changes");
    }
    lines.push("");
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- 读取

  /**
   * 按 artifactId 分页读取受控文本工件。
   *
   * 校验顺序：owner（store 内）→ 类型（只接受 UTF-8 文本）→ 路径（realpath 必须仍在
   * 工件根内，symlink 逃逸拒绝）→ 大小与 sha256（与登记一致）→ code_point 分页。
   * 返回值不包含 internalPath。
   */
  read(input: {
    readonly artifactId: ArtifactId;
    readonly principal: Principal;
    readonly offset?: number;
    readonly limitChars?: number;
  }): { readonly artifact: ArtifactMeta; readonly page: TextPage } {
    const artifact = this.store.getArtifact(input.artifactId, input.principal);
    if (!artifact.mediaType.startsWith("text/") || !artifact.mediaType.includes("charset=utf-8")) {
      throw new ZBridgeError("INVALID_ARGUMENT", "二进制或非受控编码工件不支持按文本读取", {
        details: { artifactId: input.artifactId, mediaType: artifact.mediaType },
      });
    }
    const relative = artifact.internalPath;
    if (relative.includes("..") || relative.startsWith("/") || relative.startsWith("~")) {
      throw new ZBridgeError("INVALID_ARGUMENT", "工件路径非法");
    }
    const full = join(this.root, relative);
    let real: string;
    let realRoot: string;
    try {
      real = realpathSync(full);
      realRoot = realpathSync(this.root);
    } catch {
      throw new ZBridgeError("NOT_FOUND", "工件文件不存在");
    }
    if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) {
      throw new ZBridgeError("UNAUTHORIZED", "工件路径逃逸出受控目录，拒绝读取");
    }
    let buffer: Buffer;
    try {
      buffer = readFileSync(real);
    } catch {
      throw new ZBridgeError("NOT_FOUND", "工件文件不可读");
    }
    if (buffer.byteLength !== artifact.bytes) {
      throw new ZBridgeError("BACKEND_PROTOCOL_MISMATCH", "工件实际大小与登记不一致", {
        details: { registered: artifact.bytes, actual: buffer.byteLength },
      });
    }
    const actualHash = sha256Hex(buffer);
    if (actualHash !== artifact.sha256) {
      throw new ZBridgeError("BACKEND_PROTOCOL_MISMATCH", "工件 sha256 校验失败", {
        details: { artifactId: input.artifactId },
      });
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new ZBridgeError("INVALID_ARGUMENT", "工件内容不是合法 UTF-8 文本，拒绝按损坏文本返回");
    }
    const page = sliceByCodePoints(text, input.offset ?? 0, Math.min(input.limitChars ?? READ_MAX_CHARS, READ_MAX_CHARS));
    return { artifact: toMeta(artifact), page };
  }
}

/** 对外 meta：绝不含 internalPath。 */
function toMeta(artifact: Artifact): ArtifactMeta {
  return {
    artifactId: artifact.artifactId,
    runId: artifact.runId,
    mediaType: artifact.mediaType,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    provenance: artifact.provenance,
    createdAt: artifact.createdAt,
    ...(artifact.label === undefined ? {} : { label: artifact.label }),
    ...(artifact.truncated === undefined ? {} : { truncated: artifact.truncated }),
  };
}
