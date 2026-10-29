/**
 * 工作区与权限 profile。
 *
 * canonicalRoot 只在服务端持有：对外 DTO（WorkspaceSummary）不带绝对路径，
 * 避免通过工具结果泄露本机目录结构（技术规格 §6 workspace_list）。
 */
import type { WorkspaceId } from "./ids.ts";

export const WORKSPACE_PROFILES = ["review", "edit"] as const;
export type WorkspaceProfile = (typeof WORKSPACE_PROFILES)[number];

export interface Workspace {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  /** realpath 之后的绝对路径；登记后不可变，变更等价于新 generation。 */
  readonly canonicalRoot: string;
  readonly profiles: readonly WorkspaceProfile[];
  /** 每次管理员修改登记即递增；旧 session 不因 generation 变大而自动扩权。 */
  readonly generation: number;
  /**
   * 登记时建立的独立工作副本路径（OC-04，服务端持有）。
   * worker 的 cwd 一律指向副本而不是 canonicalRoot；null 表示尚未建立副本。
   */
  readonly copyRoot: string | null;
  readonly createdAt: string;
}

export interface WorkspaceSummary {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly profiles: readonly WorkspaceProfile[];
  readonly generation: number;
}
