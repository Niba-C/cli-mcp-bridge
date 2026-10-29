/**
 * 结果清单仓库。
 *
 * 三类证据分开保存，不合并成一段“模型说完成了”：
 * - agentReported：模型自述，没有证据引用；
 * - observed：产品观察到的事实（可带工件引用）；
 * - verification：必须带证据引用的验证记录。
 * `verified` 只是「存在 verification 条目」的派生值，不代表本轮已经做过真机验证。
 */
import type { IsoTimestamp } from "../../contracts/common.ts";
import type { RunId } from "../../contracts/ids.ts";
import type { SqliteConnection } from "../db.ts";
import { num, nullableStr, str, type SqlRow } from "../rows.ts";
import type { ResultManifest, VerificationClaim } from "../types.ts";

export type ResultChannel = "agentReported" | "observed" | "verification";

export interface InsertClaimInput {
  readonly channel: ResultChannel;
  readonly text: string;
  readonly evidenceRef: string | null;
}

export class ResultRepository {
  private readonly db: SqliteConnection;

  constructor(db: SqliteConnection) {
    this.db = db;
  }

  insertManifest(manifestId: string, runId: RunId, ownerId: string, at: IsoTimestamp): void {
    this.db.raw
      .prepare("INSERT INTO result_manifests (manifest_id, run_id, owner_id, created_at) VALUES (?, ?, ?, ?)")
      .run(manifestId, runId, ownerId, at);
  }

  insertClaims(manifestId: string, claims: readonly InsertClaimInput[]): void {
    const statement = this.db.raw.prepare(
      "INSERT INTO result_claims (manifest_id, channel, ordinal, text, evidence_ref) VALUES (?, ?, ?, ?, ?)",
    );
    const counters: Record<ResultChannel, number> = { agentReported: 0, observed: 0, verification: 0 };
    for (const claim of claims) {
      const ordinal = counters[claim.channel] + 1;
      counters[claim.channel] = ordinal;
      statement.run(manifestId, claim.channel, ordinal, claim.text, claim.evidenceRef);
    }
  }

  get(manifestId: string): ResultManifest | null {
    const row = this.db.raw.prepare("SELECT * FROM result_manifests WHERE manifest_id = ?").get(manifestId);
    if (row === undefined) return null;
    return this.hydrate(row as SqlRow);
  }

  getByRun(runId: RunId): ResultManifest | null {
    const row = this.db.raw.prepare("SELECT * FROM result_manifests WHERE run_id = ?").get(runId);
    return row === undefined ? null : this.hydrate(row as SqlRow);
  }

  private hydrate(manifestRow: SqlRow): ResultManifest {
    const manifestId = str(manifestRow, "manifest_id");
    const rows = this.db.raw
      .prepare("SELECT * FROM result_claims WHERE manifest_id = ? ORDER BY channel, ordinal")
      .all(manifestId);
    const agentReported: string[] = [];
    const observed: string[] = [];
    const verification: VerificationClaim[] = [];
    for (const raw of rows) {
      const row = raw as SqlRow;
      const channel = str(row, "channel") as ResultChannel;
      const text = str(row, "text");
      const evidenceRef = nullableStr(row, "evidence_ref");
      if (channel === "agentReported") agentReported.push(text);
      else if (channel === "observed") observed.push(text);
      else if (evidenceRef !== null) verification.push({ text, evidenceRef });
    }
    return {
      manifestId,
      runId: str(manifestRow, "run_id") as RunId,
      ownerId: str(manifestRow, "owner_id"),
      createdAt: str(manifestRow, "created_at"),
      agentReported,
      observed,
      verification,
      verified: verification.length > 0,
    };
  }

  count(): number {
    const row = this.db.raw.prepare("SELECT COUNT(*) AS n FROM result_manifests").get();
    return row === undefined ? 0 : num(row as SqlRow, "n");
  }

  countClaims(manifestId: string): number {
    const row = this.db.raw
      .prepare("SELECT COUNT(*) AS n FROM result_claims WHERE manifest_id = ?")
      .get(manifestId);
    return row === undefined ? 0 : num(row as SqlRow, "n");
  }
}
