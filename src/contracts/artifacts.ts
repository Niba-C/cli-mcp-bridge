/**
 * 工件（artifact）元数据。
 *
 * 对外只能按 artifactId 读取，拒绝任意 path/URL；所有权校验与 run 同一套规则。
 * internalPath 只存在服务端，不进 MCP 返回值。
 */
import type { ArtifactId, PrincipalId, RunId } from "./ids.ts";
import type { IsoTimestamp } from "./common.ts";

export const ARTIFACT_PROVENANCE = [
  "backend_stdout",
  "backend_file",
  "daemon_capture",
  "git_diff",
  "verification",
] as const;
export type ArtifactProvenance = (typeof ARTIFACT_PROVENANCE)[number];

export interface Artifact {
  readonly artifactId: ArtifactId;
  readonly ownerId: PrincipalId;
  readonly runId: RunId;
  readonly mediaType: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly internalPath: string;
  readonly provenance: ArtifactProvenance;
  readonly createdAt: IsoTimestamp;
  /** 工件用途标签（result/events/workspace-diff）；缺省为旧数据。 */
  readonly label?: string;
  /** 超过单工件配额被截断；对外可见，不假装完整。 */
  readonly truncated?: boolean;
}

export interface ArtifactMeta {
  readonly artifactId: ArtifactId;
  readonly runId: RunId;
  readonly mediaType: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly provenance: ArtifactProvenance;
  readonly createdAt: IsoTimestamp;
  readonly label?: string;
  readonly truncated?: boolean;
}

/** 单次读取上限（Unicode code point，不是 UTF-16 单元）。 */
export const ARTIFACT_READ_MAX_CHARS = 16000;
