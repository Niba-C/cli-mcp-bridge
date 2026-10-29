/**
 * 工件元数据仓库。
 *
 * 只保存元数据（路径、哈希、字节数、来源），不读写文件内容；对外读取必须按
 * artifactId 并校验 owner，不接受任意路径或 URL。
 */
import type { IsoTimestamp } from "../../contracts/common.ts";
import type { Artifact, ArtifactMeta, ArtifactProvenance } from "../../contracts/index.ts";
import { ARTIFACT_PROVENANCE } from "../../contracts/artifacts.ts";
import { ZBridgeError } from "../../contracts/errors.ts";
import type { ArtifactId, PrincipalId, RunId } from "../../contracts/ids.ts";
import type { SqliteConnection } from "../db.ts";
import type { IdFactory } from "../ids.ts";
import { num, str, type SqlRow } from "../rows.ts";

export interface AddArtifactInput {
  readonly artifactId?: ArtifactId;
  readonly ownerId: PrincipalId;
  readonly runId: RunId;
  readonly mediaType: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly internalPath: string;
  readonly provenance: ArtifactProvenance;
  /** 工件用途标签（result/events/workspace-diff）；MCP 靠它发现配额跳过。 */
  readonly label?: string | null;
  /** 超过单工件配额被截断时为 true；MCP 可见，不假装完整。 */
  readonly truncated?: boolean;
  readonly at: IsoTimestamp;
}

function mapArtifact(row: SqlRow): Artifact {
  return {
    artifactId: str(row, "artifact_id") as ArtifactId,
    ownerId: str(row, "owner_id") as PrincipalId,
    runId: str(row, "run_id") as RunId,
    mediaType: str(row, "media_type"),
    sha256: str(row, "sha256"),
    bytes: num(row, "bytes"),
    internalPath: str(row, "internal_path"),
    provenance: str(row, "provenance") as ArtifactProvenance,
    createdAt: str(row, "created_at"),
    ...(row["label"] === undefined || row["label"] === null ? {} : { label: str(row, "label") }),
    ...(num(row, "truncated") === 1 ? { truncated: true } : {}),
  };
}

export function toArtifactMeta(artifact: Artifact): ArtifactMeta {
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

export class ArtifactRepository {
  private readonly db: SqliteConnection;
  private readonly ids: IdFactory;

  constructor(db: SqliteConnection, ids: IdFactory) {
    this.db = db;
    this.ids = ids;
  }

  add(input: AddArtifactInput): Artifact {
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
      throw new ZBridgeError("INVALID_ARGUMENT", "artifact.sha256 必须是 64 位小写十六进制");
    }
    if (!Number.isInteger(input.bytes) || input.bytes < 0) {
      throw new ZBridgeError("INVALID_ARGUMENT", "artifact.bytes 必须是 ≥0 的整数");
    }
    if (input.mediaType.trim().length === 0) {
      throw new ZBridgeError("INVALID_ARGUMENT", "artifact.mediaType 不能为空");
    }
    if (input.internalPath.trim().length === 0) {
      throw new ZBridgeError("INVALID_ARGUMENT", "artifact.internalPath 不能为空");
    }
    if (!ARTIFACT_PROVENANCE.includes(input.provenance)) {
      throw new ZBridgeError("INVALID_ARGUMENT", "artifact.provenance 非法");
    }
    const artifactId = input.artifactId ?? this.ids.artifact();
    this.db.raw
      .prepare(
        `INSERT INTO artifacts
           (artifact_id, owner_id, run_id, media_type, sha256, bytes, internal_path, provenance, label, truncated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifactId,
        input.ownerId,
        input.runId,
        input.mediaType,
        input.sha256,
        input.bytes,
        input.internalPath,
        input.provenance,
        input.label ?? null,
        input.truncated === true ? 1 : 0,
        input.at,
      );
    return this.require(artifactId);
  }

  get(artifactId: ArtifactId): Artifact | null {
    const row = this.db.raw.prepare("SELECT * FROM artifacts WHERE artifact_id = ?").get(artifactId);
    return row === undefined ? null : mapArtifact(row as SqlRow);
  }

  require(artifactId: ArtifactId): Artifact {
    const artifact = this.get(artifactId);
    if (artifact === null) throw new ZBridgeError("NOT_FOUND", "artifact 不存在");
    return artifact;
  }

  listByRun(runId: RunId): readonly Artifact[] {
    const rows = this.db.raw
      .prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, artifact_id")
      .all(runId);
    return rows.map((row) => mapArtifact(row as SqlRow));
  }

  count(): number {
    const row = this.db.raw.prepare("SELECT COUNT(*) AS n FROM artifacts").get();
    return row === undefined ? 0 : num(row as SqlRow, "n");
  }

  /** 已登记工件的字节总量；runId 为 null 时是全局总量（配额检查用）。 */
  sumBytes(runId: RunId | null): number {
    const row =
      runId === null
        ? this.db.raw.prepare("SELECT COALESCE(SUM(bytes), 0) AS total FROM artifacts").get()
        : this.db.raw.prepare("SELECT COALESCE(SUM(bytes), 0) AS total FROM artifacts WHERE run_id = ?").get(runId);
    return row === undefined ? 0 : num(row as SqlRow, "total");
  }
}
