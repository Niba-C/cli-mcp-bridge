/**
 * OC-02 崩溃注入子进程：模拟「dispatch 意图已落库、外部请求已写出、回执未确认」
 * 之后进程被强杀。父测试只允许它写一次 sent 标记；恢复后不得再写第二次。
 *
 * 这不是产品入口，只由 tests/fault/storage-recovery.test.ts 启动。
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { BridgeStore } from "../../src/storage/index.ts";
import { admit, bootstrap } from "../helpers/storage-fixture.ts";

const [dbPath, readyPath, sentPath] = process.argv.slice(2);
if (dbPath === undefined || readyPath === undefined || sentPath === undefined) {
  process.exit(2);
}

const store = BridgeStore.open(dbPath);
const fixture = bootstrap(store);
const admitted = admit(store, fixture, { clientRequestId: "crash-child-1" });
const prepared = store.prepareDispatch({
  runId: admitted.run.runId,
  backendSessionId: "oc-backend-1",
  serverEpoch: fixture.serverEpoch,
});

// 这一行代表「外部请求已经写出」；它在 intent 落库之后、确认之前。
appendFileSync(sentPath, `sent:${prepared.intent.attemptId}\n`);
writeFileSync(readyPath, "ready\n");

// 保持进程存活，等待父进程 SIGKILL；不关闭数据库，模拟真实崩溃。
setInterval(() => {}, 60_000);
