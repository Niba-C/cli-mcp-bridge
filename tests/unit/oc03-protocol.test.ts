import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvalArgumentsText,
  approvalTargetPaths,
  assistantText,
  attributeRun,
  classifyPermission,
  collectTools,
  isBackendMessageId,
  lastAssistantFields,
  newUserMessageId,
  parseMessageList,
  parsePermissionList,
  parseSessionStatus,
} from "../../src/backend/opencode/protocol.ts";

const SES = "ses_e98826385ffeP4Znn8cejHI9XR";
const USER = "msg_1677d9c84001HYtO9DdD8YywzB";
const A1 = "msg_1677d9c8a001Qblz1HL5fmCkno";
const A2 = "msg_1677da9fb001cZVwww3ZB0QD58";

/**
 * 形状来自本机 OpenCode 1.18.32 采集样本：
 * 两段 assistant 都以用户消息为 parentID；第一段 finish=tool-calls，第二段 finish=stop。
 */
function rawMessages(): unknown {
  return [
    {
      info: {
        id: USER,
        sessionID: SES,
        role: "user",
        time: { created: 1792737639675 },
        agent: "build",
        model: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
      },
      parts: [
        {
          id: "prt_user_text",
          sessionID: SES,
          messageID: USER,
          type: "text",
          text: "请创建 approved.txt",
        },
      ],
    },
    {
      info: {
        id: A1,
        sessionID: SES,
        role: "assistant",
        parentID: USER,
        time: { created: 1792737649438, completed: 1792737650586 },
        finish: "tool-calls",
        modelID: "MiniMax-M3.1-Flash",
        providerID: "minimax",
        tokens: { total: 100, input: 60, output: 40, reasoning: 10, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: "prt_reason",
          sessionID: SES,
          messageID: A1,
          type: "reasoning",
          text: "内部推理不应进入正文",
        },
        {
          id: "prt_tool",
          sessionID: SES,
          messageID: A1,
          type: "tool",
          callID: "call_fa78fd6a3b144a389176f547",
          tool: "write",
          state: { status: "completed", input: { filePath: "/tmp/approved.txt" }, output: "ok", title: "approved.txt", metadata: {}, time: { start: 1, end: 2 } },
        },
      ],
    },
    {
      info: {
        id: A2,
        sessionID: SES,
        role: "assistant",
        parentID: USER,
        time: { created: 1792737655300, completed: 1792737656000 },
        finish: "stop",
        modelID: "MiniMax-M3.1-Flash",
        providerID: "minimax",
        tokens: { total: 20, input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        { id: "prt_text2", sessionID: SES, messageID: A2, type: "text", text: "DONE" },
        { id: "prt_synth", sessionID: SES, messageID: A2, type: "text", text: "synthetic note", synthetic: true },
      ],
    },
  ];
}

test("解析消息列表：保留归属字段并统计坏条目", () => {
  const parsed = parseMessageList(rawMessages());
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.messages.length, 3);
  const [first, second] = parsed.messages;
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first.role, "user");
  assert.equal(first.providerId, "minimax");
  assert.equal(second.parentId, USER);
  assert.equal(second.finish, "tool-calls");
  assert.equal(second.completedMs, 1792737650586);

  const withBad = parseMessageList([{ info: { id: "msg_x" } }, { nope: true }, ...(rawMessages() as unknown[])]);
  assert.equal(withBad.skipped, 2);
  assert.equal(withBad.messages.length, 3);
});

test("归属只看 messageID + parentID + sessionID，不看顺序或时间", () => {
  const parsed = parseMessageList(rawMessages());
  const attribution = attributeRun(parsed.messages, { sessionId: SES, userMessageId: USER });
  assert.equal(attribution.confirmed, true);
  assert.equal(attribution.conflict, false);
  assert.deepEqual(
    attribution.assistants.map((message) => message.id),
    [A1, A2],
  );

  // 打乱顺序也得到相同归属与相同排序。
  const shuffled = attributeRun([...parsed.messages].reverse(), { sessionId: SES, userMessageId: USER });
  assert.deepEqual(
    shuffled.assistants.map((message) => message.id),
    [A1, A2],
  );

  // 用别的 messageID 查询：没有归属，也没有 assistant。
  const other = attributeRun(parsed.messages, { sessionId: SES, userMessageId: "msg_other0000000000000000000001" });
  assert.equal(other.confirmed, false);
  assert.equal(other.assistants.length, 0);

  // 会话不符：即使 ID 相同也视为冲突，不能拿来归属。
  const wrongSession = attributeRun(parsed.messages, { sessionId: "ses_other00000000000000000000001", userMessageId: USER });
  assert.equal(wrongSession.conflict, true);
  assert.equal(wrongSession.confirmed, false);
});

test("assistant 文本排除推理与 synthetic，工具状态跨消息归集", () => {
  const parsed = parseMessageList(rawMessages());
  const attribution = attributeRun(parsed.messages, { sessionId: SES, userMessageId: USER });
  assert.equal(assistantText(attribution.assistants), "DONE");
  assert.equal(assistantText(attribution.assistants).includes("内部推理"), false);
  assert.equal(assistantText(attribution.assistants).includes("synthetic note"), false);

  const tools = collectTools(attribution.assistants);
  assert.equal(tools.pending, false);
  assert.equal(tools.anyError, false);
  assert.equal(tools.observations.length, 1);
  assert.equal(tools.observations[0]?.toolName, "write");
  assert.equal(tools.observations[0]?.state, "completed");

  const running: unknown = [
    {
      info: { id: A1, sessionID: SES, role: "assistant", parentID: USER, time: { created: 1 } },
      parts: [
        { id: "p1", type: "tool", callID: "c1", tool: "bash", state: { status: "running", input: {}, time: { start: 1 } } },
      ],
    },
    {
      info: { id: A2, sessionID: SES, role: "assistant", parentID: USER, time: { created: 2 } },
      parts: [
        { id: "p2", type: "tool", callID: "c2", tool: "bash", state: { status: "pending", input: {} } },
      ],
    },
  ];
  const pendingTools = collectTools(parseMessageList(running).messages);
  assert.equal(pendingTools.pending, true);
  assert.equal(pendingTools.observations.length, 2);
});

test("末段 assistant 的 finish／error／completed 是唯一终态字段来源", () => {
  const parsed = parseMessageList(rawMessages());
  const attribution = attributeRun(parsed.messages, { sessionId: SES, userMessageId: USER });
  const fields = lastAssistantFields(attribution.assistants);
  assert.equal(fields.finish, "stop");
  assert.equal(fields.errorName, null);
  assert.equal(fields.messageCompleted, true);
  assert.equal(fields.providerId, "minimax");

  const toolCallsOnly = lastAssistantFields(attribution.assistants.slice(0, 1));
  assert.equal(toolCallsOnly.finish, "tool-calls");
  assert.equal(lastAssistantFields([]).finish, null);
  assert.equal(lastAssistantFields([]).messageCompleted, false);
});

test("权限请求解析保留后端 requestID、callID 与参数文本", () => {
  const raw = [
    {
      id: "per_1677da7a4001dfEsFpUGtoyHl3",
      sessionID: SES,
      permission: "edit",
      patterns: ["private/tmp/ws/approved.txt"],
      metadata: { filepath: "/tmp/ws/approved.txt", diff: "--- a\n+++ b\n" },
      always: ["*"],
      tool: { messageID: A1, callID: "call_fa78fd6a3b144a389176f547" },
    },
    {
      id: "per_1677dc045001WVTJ6INB9VRnV6",
      sessionID: SES,
      permission: "bash",
      patterns: ["sh ./cancel-work.sh"],
      metadata: { command: "sh ./cancel-work.sh" },
      always: ["sh *"],
      tool: { messageID: A1, callID: "call_f87493252872405481c067a5" },
    },
    { id: "per_broken" },
  ];
  const parsed = parsePermissionList(raw);
  assert.equal(parsed.skipped, 1);
  assert.equal(parsed.requests.length, 2);
  const [edit, bash] = parsed.requests;
  assert.ok(edit !== undefined && bash !== undefined);
  assert.equal(edit.permission, "edit");
  assert.equal(edit.toolCallId, "call_fa78fd6a3b144a389176f547");
  assert.equal(edit.toolMessageId, A1);
  assert.match(approvalArgumentsText(edit), /diff:/);
  assert.deepEqual(approvalTargetPaths(edit), ["private/tmp/ws/approved.txt"]);
  assert.equal(classifyPermission("edit"), "tool_permission");
  assert.equal(classifyPermission("bash"), "tool_permission");
  assert.equal(classifyPermission("mystery"), "unknown");
  assert.match(approvalArgumentsText(bash), /command: sh \.\/cancel-work\.sh/);
});

test("session/status 只作提示：缺项与非法值都不算完成", () => {
  assert.equal(parseSessionStatus({ [SES]: { type: "idle" } }, SES), "idle");
  assert.equal(parseSessionStatus({ [SES]: { type: "busy" } }, SES), "busy");
  assert.equal(parseSessionStatus({ [SES]: { type: "retry" } }, SES), "retry");
  assert.equal(parseSessionStatus({}, SES), "absent");
  assert.equal(parseSessionStatus({ [SES]: { type: "weird" } }, SES), "absent");
  assert.equal(parseSessionStatus(null, SES), "absent");
});

test("显式用户 messageID 满足 OpenCode 的 ^msg 约束", () => {
  const id = newUserMessageId(Date.parse("2026-10-23T06:40:37.773Z"), "a1b2c3d4e5f60718");
  assert.match(id, /^msg/);
  assert.equal(isBackendMessageId(id), true);
  assert.equal(isBackendMessageId("ses_not_a_message"), false);
  assert.equal(isBackendMessageId("msg_"), true);
  assert.equal(isBackendMessageId("msg_bad id"), false);
  // 同毫秒不同随机段必须不同，避免同一 run 重试时复用（重试本身不被允许）。
  assert.notEqual(newUserMessageId(1, "aaaaaaaaaaaaaaaa"), newUserMessageId(1, "bbbbbbbbbbbbbbbb"));
});
