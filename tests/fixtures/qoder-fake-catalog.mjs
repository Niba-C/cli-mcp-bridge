/**
 * Qoder 在线目录 fake SDK（管理命令离线测试专用）。
 * ZB_CATALOG_SCENARIO=ok|empty|unsupported|auth|hang 控制 getModels 的行为。
 */
const scenario = () => process.env["ZB_CATALOG_SCENARIO"] ?? "ok";

async function startDaemon(options) {
  const daemon = {
    async stop() {},
  };
  if (scenario() !== "unsupported") {
    daemon.getModels = async (params) => {
      if (params?.fetchStrategy !== "live") throw new Error("fake 目录只接受 live");
      if (!["accessToken", "qodercli"].includes(options?.auth?.type)) throw new Error("AUTH_PAYLOAD_REQUIRED");
      if (scenario() === "auth") throw new Error("AUTH_PAYLOAD_REQUIRED");
      if (scenario() === "hang") await new Promise(() => {});
      if (scenario() === "empty") return [];
      return [
        { value: "qd-catalog-1", modelId: "qd-catalog-1", displayName: "QD One", description: "first" },
        { value: "qd-catalog-2", modelId: "qd-catalog-2", displayName: "QD Two", description: "second" },
      ];
    };
  }
  return daemon;
}

function qodercliAuth() { return { type: "qodercli" }; }
export { startDaemon, qodercliAuth };
