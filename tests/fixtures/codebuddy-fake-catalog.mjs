/**
 * CodeBuddy 在线目录 fake SDK（管理命令离线测试专用）。
 * ZB_CATALOG_SCENARIO=ok|empty|unsupported|auth|hang 控制 supportedModels 的行为。
 */
const scenario = () => process.env["ZB_CATALOG_SCENARIO"] ?? "ok";

function query() {
  const created = {
    async connect() {
      if (scenario() === "auth") throw new Error("authentication_failed: token invalid");
      if (scenario() === "hang") await new Promise(() => {});
    },
    async return() {},
  };
  if (scenario() !== "unsupported") {
    created.supportedModels = async () => {
      if (scenario() === "empty") return [];
      return [
        { value: "cb-catalog-1", displayName: "CB One", description: "first" },
        { value: "cb-catalog-2", displayName: "CB Two", description: "second" },
      ];
    };
  }
  return created;
}

export { query };
