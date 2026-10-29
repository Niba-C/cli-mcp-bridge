/**
 * 版本化 schema migrations（技术规格 §4）。
 *
 * 迁移是显式、单调、只向前：每个版本在独立事务里执行 SQL 并写 `schema_migrations`。
 * 已应用版本不重复执行；数据库版本高于程序已知版本时拒绝打开，避免旧程序写坏新库。
 */
import type { IsoTimestamp } from "../contracts/common.ts";
import type { SqliteConnection } from "./db.ts";
import { ZBridgeError } from "../contracts/errors.ts";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

const RUN_STATES_SQL = `
  'queued','starting','running','waiting_approval','waiting_input','draining','stopping',
  'completed','failed','cancelled','interrupted','timed_out','unknown'
`;

const MIGRATION_1: Migration = {
  version: 1,
  name: "initial-persistence",
  statements: [
    `CREATE TABLE counters (
       name TEXT PRIMARY KEY,
       value INTEGER NOT NULL CHECK (value >= 0)
     )`,
    `CREATE TABLE service_instances (
       service_epoch INTEGER PRIMARY KEY,
       status TEXT NOT NULL CHECK (status IN ('active','stopped','crashed')),
       pid INTEGER,
       started_at TEXT NOT NULL,
       ended_at TEXT,
       created_at TEXT NOT NULL
     )`,
    `CREATE TABLE server_instances (
       server_epoch INTEGER PRIMARY KEY,
       service_epoch INTEGER NOT NULL REFERENCES service_instances(service_epoch),
       status TEXT NOT NULL CHECK (status IN ('active','stopped','crashed')),
       pid INTEGER,
       run_dir TEXT,
       backend_version TEXT,
       started_at TEXT NOT NULL,
       ended_at TEXT,
       created_at TEXT NOT NULL
     )`,
    `CREATE INDEX ix_server_instances_service ON server_instances(service_epoch)`,
    `CREATE TABLE workspaces (
       workspace_id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       canonical_root TEXT NOT NULL,
       profiles TEXT NOT NULL,
       generation INTEGER NOT NULL CHECK (generation >= 1),
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
    `CREATE TABLE sessions (
       session_id TEXT PRIMARY KEY,
       owner_id TEXT NOT NULL,
       workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
       workspace_generation INTEGER NOT NULL CHECK (workspace_generation >= 1),
       profile TEXT NOT NULL CHECK (profile IN ('review','edit')),
       backend_session_id TEXT,
       server_epoch INTEGER REFERENCES server_instances(server_epoch),
       recovery_verification TEXT NOT NULL
         CHECK (recovery_verification IN ('unverified','verified','unavailable')),
       state TEXT NOT NULL CHECK (state IN ('idle','busy','unavailable','closed')),
       revision INTEGER NOT NULL CHECK (revision >= 1),
       blocked_reason TEXT,
       blocked_run_id TEXT,
       blocked_at TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       CHECK ((backend_session_id IS NULL) = (server_epoch IS NULL)),
       CHECK ((blocked_reason IS NULL) = (blocked_at IS NULL))
     )`,
    `CREATE UNIQUE INDEX ux_sessions_backend
       ON sessions(backend_session_id, server_epoch)
       WHERE backend_session_id IS NOT NULL`,
    `CREATE INDEX ix_sessions_owner ON sessions(owner_id)`,
    `CREATE INDEX ix_sessions_workspace ON sessions(workspace_id)`,
    `CREATE TABLE runs (
       run_id TEXT PRIMARY KEY,
       session_id TEXT NOT NULL REFERENCES sessions(session_id),
       owner_id TEXT NOT NULL,
       workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
       request_id TEXT NOT NULL,
       request_hash TEXT NOT NULL,
       request_tool TEXT NOT NULL,
       profile TEXT NOT NULL CHECK (profile IN ('review','edit')),
       state TEXT NOT NULL CHECK (state IN (${RUN_STATES_SQL})),
       revision INTEGER NOT NULL CHECK (revision >= 1),
       last_event_seq INTEGER NOT NULL CHECK (last_event_seq >= 0),
       earliest_seq INTEGER NOT NULL DEFAULT 1 CHECK (earliest_seq >= 1),
       backend_attempt_id TEXT,
       deadline_at TEXT NOT NULL,
       result_manifest_id TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       CHECK (revision = last_event_seq)
     )`,
    `CREATE INDEX ix_runs_session ON runs(session_id)`,
    `CREATE INDEX ix_runs_state ON runs(state)`,
    `CREATE TABLE run_events (
       run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
       seq INTEGER NOT NULL CHECK (seq >= 1),
       revision INTEGER NOT NULL,
       type TEXT NOT NULL,
       at TEXT NOT NULL,
       state TEXT,
       payload TEXT NOT NULL,
       PRIMARY KEY (run_id, seq),
       CHECK (revision = seq)
     )`,
    `CREATE TABLE request_receipts (
       principal_id TEXT NOT NULL,
       tool_name TEXT NOT NULL,
       client_request_id TEXT NOT NULL,
       service_epoch INTEGER NOT NULL REFERENCES service_instances(service_epoch),
       request_hash TEXT NOT NULL,
       run_id TEXT NOT NULL REFERENCES runs(run_id),
       created_at TEXT NOT NULL,
       PRIMARY KEY (principal_id, tool_name, client_request_id, service_epoch)
     )`,
    `CREATE INDEX ix_receipts_run ON request_receipts(run_id)`,
    `CREATE TABLE dispatch_intents (
       attempt_id TEXT PRIMARY KEY,
       run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
       session_id TEXT NOT NULL REFERENCES sessions(session_id),
       backend_session_id TEXT NOT NULL,
       server_epoch INTEGER NOT NULL REFERENCES server_instances(server_epoch),
       backend_message_id TEXT,
       phase TEXT NOT NULL
         CHECK (phase IN ('possibly_sent','sent','confirmed','not_sent','unknown')),
       prepared_at TEXT NOT NULL,
       possibly_sent_at TEXT NOT NULL,
       sent_at TEXT,
       confirmed_at TEXT,
       not_sent_at TEXT,
       unknown_at TEXT,
       detail TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       CHECK (phase <> 'sent' OR sent_at IS NOT NULL),
       CHECK (phase <> 'confirmed'
         OR (sent_at IS NOT NULL AND confirmed_at IS NOT NULL AND backend_message_id IS NOT NULL)),
       CHECK (phase <> 'not_sent' OR not_sent_at IS NOT NULL),
       CHECK (phase <> 'unknown' OR unknown_at IS NOT NULL)
     )`,
    `CREATE INDEX ix_dispatch_session ON dispatch_intents(session_id)`,
    `CREATE TABLE approvals (
       approval_id TEXT PRIMARY KEY,
       owner_id TEXT NOT NULL,
       run_id TEXT NOT NULL REFERENCES runs(run_id),
       session_id TEXT NOT NULL REFERENCES sessions(session_id),
       workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
       attempt_id TEXT NOT NULL REFERENCES dispatch_intents(attempt_id),
       server_epoch INTEGER NOT NULL REFERENCES server_instances(server_epoch),
       request_kind TEXT NOT NULL
         CHECK (request_kind IN ('tool_permission','plan_approval','scope_expansion','sandbox_write','unknown')),
       tool_name TEXT NOT NULL,
       tool_call_id TEXT NOT NULL,
       arguments_text TEXT NOT NULL,
       target_paths TEXT NOT NULL,
       payload_hash TEXT NOT NULL,
       policy_version TEXT NOT NULL,
       expires_at TEXT NOT NULL,
       repeat_count INTEGER NOT NULL CHECK (repeat_count >= 1),
       state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','expired','cancelled')),
       decision_actor TEXT CHECK (decision_actor IN ('operator','product_expiry','channel_lost')),
       decided_at TEXT,
       created_at TEXT NOT NULL,
       revision INTEGER NOT NULL CHECK (revision >= 1),
       UNIQUE (attempt_id, tool_call_id, request_kind),
       CHECK ((state = 'pending') = (decided_at IS NULL)),
       CHECK (state = 'pending' OR decision_actor IS NOT NULL)
     )`,
    `CREATE INDEX ix_approvals_run ON approvals(run_id, state)`,
    `CREATE TABLE artifacts (
       artifact_id TEXT PRIMARY KEY,
       owner_id TEXT NOT NULL,
       run_id TEXT NOT NULL REFERENCES runs(run_id),
       media_type TEXT NOT NULL,
       sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
       bytes INTEGER NOT NULL CHECK (bytes >= 0),
       internal_path TEXT NOT NULL,
       provenance TEXT NOT NULL
         CHECK (provenance IN ('backend_stdout','backend_file','daemon_capture','git_diff','verification')),
       created_at TEXT NOT NULL
     )`,
    `CREATE INDEX ix_artifacts_run ON artifacts(run_id)`,
    `CREATE TABLE result_manifests (
       manifest_id TEXT PRIMARY KEY,
       run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
       owner_id TEXT NOT NULL,
       created_at TEXT NOT NULL
     )`,
    `CREATE TABLE result_claims (
       manifest_id TEXT NOT NULL REFERENCES result_manifests(manifest_id) ON DELETE CASCADE,
       channel TEXT NOT NULL CHECK (channel IN ('agentReported','observed','verification')),
       ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
       text TEXT NOT NULL,
       evidence_ref TEXT,
       PRIMARY KEY (manifest_id, channel, ordinal),
       CHECK (channel <> 'agentReported' OR evidence_ref IS NULL),
       CHECK (channel <> 'verification' OR (evidence_ref IS NOT NULL AND length(evidence_ref) > 0))
     )`,
  ],
};

/**
 * OC-04：daemon 需要的两块持久化。
 *
 * - `workspaces.copy_root`：登记时建立的独立工作副本路径（服务端持有，不进对外 DTO）；
 * - `worker_processes`：daemon 启动的每个 OpenCode worker 的身份与归属证据
 *   （PID、进程组、`ps lstart` 身份串、运行目录、曾观察到的后代及其身份）。
 *   daemon 崩溃重启后凭这份记录判断「遗留进程是否确属自己」，不能只凭 PID；
 *   后代也带各自的 lstart 身份，恢复时逐个核对，防止 PID 复用导致误杀。
 */
const MIGRATION_2: Migration = {
  version: 2,
  name: "oc04-daemon-ownership",
  statements: [
    `ALTER TABLE workspaces ADD COLUMN copy_root TEXT`,
    `CREATE TABLE worker_processes (
       server_epoch INTEGER PRIMARY KEY REFERENCES server_instances(server_epoch),
       service_epoch INTEGER NOT NULL,
       pid INTEGER NOT NULL,
       pgid INTEGER NOT NULL,
       process_identity TEXT,
       executable TEXT NOT NULL,
       run_dir TEXT NOT NULL,
       descendants TEXT NOT NULL DEFAULT '[]',
       status TEXT NOT NULL CHECK (status IN ('active','stopped','crashed','unknown')),
       note TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
    `CREATE INDEX ix_worker_processes_status ON worker_processes(status)`,
  ],
};

/**
 * OC-05：停止类工具（agent_interrupt／agent_cancel／agent_close）的持久幂等回执。
 *
 * `request_receipts` 的 run_id NOT NULL 外键只适合「受理即建 run」的 agent_start；
 * interrupt/cancel 面向已有 run、close 面向 session，且同 key 重试必须**重放原响应**
 * （revision 已经变化也不能重新计算）。因此单独建表：请求哈希 + 原响应 JSON 一起落库。
 *
 * 同一迁移给 `artifacts` 补 `label`/`truncated` 两列：MCP 调用方靠它们发现
 * 「哪个工件因配额被跳过（label 缺失）/ 哪个被截断」，不再只依赖 daemon stderr。
 */
const MIGRATION_3: Migration = {
  version: 3,
  name: "oc05-tool-receipts",
  statements: [
    `CREATE TABLE tool_receipts (
       principal_id TEXT NOT NULL,
       tool_name TEXT NOT NULL,
       client_request_id TEXT NOT NULL,
       service_epoch INTEGER NOT NULL REFERENCES service_instances(service_epoch),
       request_hash TEXT NOT NULL,
       target_id TEXT NOT NULL,
       response_json TEXT NOT NULL,
       created_at TEXT NOT NULL,
       PRIMARY KEY (principal_id, tool_name, client_request_id, service_epoch)
     )`,
    `CREATE INDEX ix_tool_receipts_target ON tool_receipts(target_id)`,
    `ALTER TABLE artifacts ADD COLUMN label TEXT`,
    `ALTER TABLE artifacts ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0`,
  ],
};

/**
 * OC-08：通过 MCP 指定模型。
 *
 * - `runs.selected_model`：受理时解析并持久化的完整 `providerID/modelID`。
 *   迁移前的历史 run 为 NULL——那时实现固定 minimax/MiniMax-M3.1-Flash，
 *   读取侧按这一事实解释，**不回填**为用户后来修改的 default；
 * - `runs.observed_model`：后端关联消息里实际观测到的模型；尚无证据时为 NULL；
 * - `sessions.last_selected_model`：会话最近一次**已受理**任务的选定模型，
 *   省略 model 的后续请求沿用它；只在新受理时更新，幂等重放不改写。
 */
const MIGRATION_4: Migration = {
  version: 4,
  name: "oc08-model-selection",
  statements: [
    `ALTER TABLE runs ADD COLUMN selected_model TEXT`,
    `ALTER TABLE runs ADD COLUMN observed_model TEXT`,
    `ALTER TABLE sessions ADD COLUMN last_selected_model TEXT`,
  ],
};

/**
 * OC-09：三后端身份归属。
 *
 * - `sessions.backend_id`：会话固定归属的后端，创建后不可变更；
 * - `runs.backend_id`：受理时随请求解析持久化；旧回执重放不改写；
 * - `server_instances.backend_id`：一次后端运行时（OpenCode HTTP 服务或
 *   SDK worker 服务代际）归属于哪个后端；
 * - `worker_processes.backend_id`：daemon 记录的受管 worker 进程归属，
 *   回收时只在同后端运行时内核对身份。
 *
 * 历史行（v4 及之前）确定标记 'opencode'：当时唯一后端就是 OpenCode，
 * 这是事实声明而不是猜测。selected_model 的旧 NULL 解释沿用 OC-08，
 * observed_model 不编造回填。request_hash 与已存回执正文不改写；
 * 读取边界在投影层补充 backendId，不重写历史行。
 */
const MIGRATION_5: Migration = {
  version: 5,
  name: "oc09-backend-identity",
  statements: [
    `ALTER TABLE sessions ADD COLUMN backend_id TEXT NOT NULL DEFAULT 'opencode'
       CHECK (backend_id IN ('opencode','codebuddy','qoder'))`,
    `ALTER TABLE runs ADD COLUMN backend_id TEXT NOT NULL DEFAULT 'opencode'
       CHECK (backend_id IN ('opencode','codebuddy','qoder'))`,
    `ALTER TABLE server_instances ADD COLUMN backend_id TEXT NOT NULL DEFAULT 'opencode'
       CHECK (backend_id IN ('opencode','codebuddy','qoder'))`,
    `ALTER TABLE worker_processes ADD COLUMN backend_id TEXT NOT NULL DEFAULT 'opencode'
       CHECK (backend_id IN ('opencode','codebuddy','qoder'))`,
    `CREATE INDEX ix_sessions_backend ON sessions(backend_id)`,
    `CREATE INDEX ix_runs_backend ON runs(backend_id)`,
  ],
};

export const MIGRATIONS: readonly Migration[] = [MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5];
export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export function migrate(connection: SqliteConnection, now: IsoTimestamp): number {
  const db = connection.raw;
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const appliedRows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
    version: number;
  }>;
  const applied = new Set(appliedRows.map((row) => Number(row.version)));

  for (const version of applied) {
    if (version > CURRENT_SCHEMA_VERSION) {
      throw new ZBridgeError("INVALID_ARGUMENT", "数据库 schema 版本高于当前程序，拒绝写入", {
        details: { databaseVersion: version, supportedVersion: CURRENT_SCHEMA_VERSION },
      });
    }
  }

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    connection.transaction(() => {
      for (const sql of migration.statements) db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        now,
      );
    });
  }

  return CURRENT_SCHEMA_VERSION;
}
