/**
 * 存储层 ID 生成。
 *
 * 业务实体沿用 `contracts/ids.ts` 的前缀与 uuid 规则；attemptId 和 resultManifestId
 * 是产品内部标识，不进入 MCP wire contract，因此单独给前缀但仍用 uuid 保证唯一。
 */
import { randomUUID } from "node:crypto";
import { newId } from "../contracts/ids.ts";
import type { ApprovalId, ArtifactId, RunId, SessionId, WorkspaceId } from "../contracts/ids.ts";

export interface IdFactory {
  workspace(): WorkspaceId;
  session(): SessionId;
  run(): RunId;
  approval(): ApprovalId;
  artifact(): ArtifactId;
  attempt(): string;
  manifest(): string;
}

export const defaultIdFactory: IdFactory = {
  workspace: () => newId("workspace"),
  session: () => newId("session"),
  run: () => newId("run"),
  approval: () => newId("approval"),
  artifact: () => newId("artifact"),
  attempt: () => `att_${randomUUID()}`,
  manifest: () => `res_${randomUUID()}`,
};
