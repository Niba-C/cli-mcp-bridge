/**
 * workspace 仓库。
 *
 * canonicalRoot 只在服务端保存；`generation` 每次登记修改递增，旧 session 不因
 * generation 变大而自动扩权（技术规格 §2、§8）。
 */
import { isAbsolute } from "node:path";
import type { IsoTimestamp } from "../../contracts/common.ts";
import { ZBridgeError } from "../../contracts/errors.ts";
import type { WorkspaceId } from "../../contracts/ids.ts";
import type { Workspace, WorkspaceProfile } from "../../contracts/index.ts";
import { WORKSPACE_PROFILES } from "../../contracts/workspace.ts";
import type { SqliteConnection } from "../db.ts";
import type { IdFactory } from "../ids.ts";
import { nullableStr, num, str, type SqlRow } from "../rows.ts";

export interface CreateWorkspaceInput {
  readonly workspaceId?: WorkspaceId;
  readonly name: string;
  readonly canonicalRoot: string;
  readonly profiles: readonly WorkspaceProfile[];
  /** 登记时建立的独立工作副本路径；daemon 持有，不进对外 DTO。 */
  readonly copyRoot?: string | null;
  readonly generation?: number;
  readonly at?: IsoTimestamp;
}

function parseProfiles(raw: string): readonly WorkspaceProfile[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new ZBridgeError("INVALID_ARGUMENT", "workspace.profiles 数据损坏");
  return parsed.filter(
    (item): item is WorkspaceProfile =>
      typeof item === "string" && (WORKSPACE_PROFILES as readonly string[]).includes(item),
  );
}

function mapWorkspace(row: SqlRow): Workspace {
  return {
    workspaceId: str(row, "workspace_id") as WorkspaceId,
    name: str(row, "name"),
    canonicalRoot: str(row, "canonical_root"),
    profiles: parseProfiles(str(row, "profiles")),
    generation: num(row, "generation"),
    copyRoot: nullableStr(row, "copy_root"),
    createdAt: str(row, "created_at"),
  };
}

export class WorkspaceRepository {
  private readonly db: SqliteConnection;
  private readonly ids: IdFactory;

  constructor(db: SqliteConnection, ids: IdFactory) {
    this.db = db;
    this.ids = ids;
  }

  create(input: CreateWorkspaceInput): Workspace {
    const at = input.at ?? new Date().toISOString();
    const name = input.name.trim();
    if (name.length === 0 || name.length > 128) {
      throw new ZBridgeError("INVALID_ARGUMENT", "workspace.name 必须为 1–128 字符");
    }
    if (!isAbsolute(input.canonicalRoot) || input.canonicalRoot.includes("\0")) {
      throw new ZBridgeError("INVALID_ARGUMENT", "workspace.canonicalRoot 必须是绝对路径");
    }
    if (input.profiles.length === 0) {
      throw new ZBridgeError("INVALID_ARGUMENT", "workspace.profiles 不能为空");
    }
    const profiles = [...new Set(input.profiles)];
    if (profiles.some((profile) => !WORKSPACE_PROFILES.includes(profile))) {
      throw new ZBridgeError("PROFILE_NOT_ALLOWED", "workspace.profiles 含有未知 profile");
    }
    const generation = input.generation ?? 1;
    if (!Number.isInteger(generation) || generation < 1) {
      throw new ZBridgeError("INVALID_ARGUMENT", "workspace.generation 必须是 ≥1 的整数");
    }
    const workspaceId = input.workspaceId ?? this.ids.workspace();
    this.db.raw
      .prepare(
        `INSERT INTO workspaces
           (workspace_id, name, canonical_root, profiles, generation, copy_root, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(workspaceId, name, input.canonicalRoot, JSON.stringify(profiles), generation, input.copyRoot ?? null, at, at);
    return this.require(workspaceId);
  }

  get(workspaceId: WorkspaceId): Workspace | null {
    const row = this.db.raw.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(workspaceId);
    return row === undefined ? null : mapWorkspace(row as SqlRow);
  }

  require(workspaceId: WorkspaceId): Workspace {
    const workspace = this.get(workspaceId);
    if (workspace === null) throw new ZBridgeError("NOT_FOUND", "workspace 不存在");
    return workspace;
  }

  list(): readonly Workspace[] {
    const rows = this.db.raw.prepare("SELECT * FROM workspaces ORDER BY created_at, workspace_id").all();
    return rows.map((row) => mapWorkspace(row as SqlRow));
  }

  findByCanonicalRoot(canonicalRoot: string): Workspace | null {
    const row = this.db.raw
      .prepare("SELECT * FROM workspaces WHERE canonical_root = ? ORDER BY created_at LIMIT 1")
      .get(canonicalRoot);
    return row === undefined ? null : mapWorkspace(row as SqlRow);
  }

  /** 登记信息变更（profiles/副本/generation）一次性更新；generation 只增不减。 */
  updateRegistration(
    workspaceId: WorkspaceId,
    input: { generation?: number; profiles?: readonly WorkspaceProfile[]; copyRoot?: string | null },
    at: IsoTimestamp,
  ): Workspace {
    const current = this.require(workspaceId);
    const generation = input.generation ?? current.generation;
    if (!Number.isInteger(generation) || generation < current.generation) {
      throw new ZBridgeError("INVALID_ARGUMENT", "workspace.generation 不能回退", {
        details: { current: current.generation, requested: generation },
      });
    }
    const profiles = input.profiles ?? current.profiles;
    if (profiles.length === 0) {
      throw new ZBridgeError("INVALID_ARGUMENT", "workspace.profiles 不能为空");
    }
    const copyRoot = input.copyRoot === undefined ? current.copyRoot : input.copyRoot;
    const result = this.db.raw
      .prepare(
        `UPDATE workspaces
            SET generation = ?, profiles = ?, copy_root = ?, updated_at = ?
          WHERE workspace_id = ?`,
      )
      .run(generation, JSON.stringify([...new Set(profiles)]), copyRoot, at, workspaceId);
    if (Number(result.changes) === 0) throw new ZBridgeError("NOT_FOUND", "workspace 不存在");
    return this.require(workspaceId);
  }

  /** 更新副本路径（登记/重建副本时）；generation 语义不变。 */
  setCopyRoot(workspaceId: WorkspaceId, copyRoot: string | null, at: IsoTimestamp): Workspace {
    const result = this.db.raw
      .prepare("UPDATE workspaces SET copy_root = ?, updated_at = ? WHERE workspace_id = ?")
      .run(copyRoot, at, workspaceId);
    if (Number(result.changes) === 0) throw new ZBridgeError("NOT_FOUND", "workspace 不存在");
    return this.require(workspaceId);
  }

  /** 登记信息变更等价于新 generation；已有 session 的快照不会自动跟着变。 */
  updateGeneration(workspaceId: WorkspaceId, generation: number, at: IsoTimestamp): Workspace {
    if (!Number.isInteger(generation) || generation < 1) {
      throw new ZBridgeError("INVALID_ARGUMENT", "workspace.generation 必须是 ≥1 的整数");
    }
    const result = this.db.raw
      .prepare("UPDATE workspaces SET generation = ?, updated_at = ? WHERE workspace_id = ?")
      .run(generation, at, workspaceId);
    if (Number(result.changes) === 0) throw new ZBridgeError("NOT_FOUND", "workspace 不存在");
    return this.require(workspaceId);
  }
}
