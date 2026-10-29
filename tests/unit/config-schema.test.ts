import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { test } from "node:test";
import { checkWorkspaceRoot, configTemplate, validateConfigObject } from "../../src/contracts/config.ts";
import {
  CODEBUDDY_PINNED_CLI_VERSION,
  CONFIG_SCHEMA_VERSION,
  OPENCODE_ADAPTER_ID,
  OPENCODE_PINNED_VERSION,
  QODER_PINNED_CLI_VERSION,
} from "../../src/contracts/version.ts";

function withConfig(mutate: (config: Record<string, unknown>) => void): unknown {
  const config = JSON.parse(JSON.stringify(configTemplate())) as Record<string, unknown>;
  mutate(config);
  return config;
}

/** v3 里的 OpenCode 项（大多数既有断言的落点）。 */
function opencodeOf(config: Record<string, unknown>): Record<string, unknown> {
  const backends = config["backends"] as Record<string, Record<string, unknown>>;
  return backends["opencode"]!;
}

function withCodebuddy(mutate: (entry: Record<string, unknown>) => void = () => {}): unknown {
  return withConfig((config) => {
    const backends = config["backends"] as Record<string, unknown>;
    backends["codebuddy"] = {
      adapter: "codebuddy-sdk",
      enabled: false,
      pinnedVersion: CODEBUDDY_PINNED_CLI_VERSION,
      executable: "/opt/homebrew/bin/codebuddy",
      auth: { mode: "cli-login" },
      models: { default: "glm-5.3", allowed: ["glm-5.3"] },
    };
    mutate(backends["codebuddy"] as Record<string, unknown>);
  });
}

test("示例配置是 schemaVersion=3 的单 OpenCode 后端配置，默认 limits 被填充", () => {
  const result = validateConfigObject(configTemplate());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.sourceSchemaVersion, 3);
    assert.equal(result.config.schemaVersion, 3);
    assert.equal(result.config.defaultBackend, "opencode");
    const opencode = result.config.backends["opencode"];
    assert.ok(opencode && opencode.adapter === "opencode-http");
    assert.equal(opencode.pinnedVersion, "1.18.32");
    assert.deepEqual(opencode.modelProfiles["default"], {
      providerID: "minimax",
      modelID: "MiniMax-M3.1-Flash",
    });
    assert.equal(result.config.limits.activeRuns, 1);
    assert.equal(result.config.limits.waitTimeoutMs, 20_000);
    assert.equal(result.config.transport.stdio, true);
    assert.equal(result.config.transport.http.enabled, false);
  }
});

test("v2 配置在内存中规范化为仅含 opencode 的 v3 表达，不改写磁盘结构", () => {
  const v2 = {
    schemaVersion: 2,
    mode: "personal",
    backend: {
      adapter: "opencode-http",
      pinnedVersion: "1.18.32",
      modelProfiles: {
        default: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
      },
    },
    workspaces: [],
    limits: {},
    transport: {},
  };
  const result = validateConfigObject(v2);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.sourceSchemaVersion, 2);
    assert.equal(result.config.schemaVersion, 3);
    assert.equal(result.config.defaultBackend, "opencode");
    const opencode = result.config.backends["opencode"];
    assert.ok(opencode && opencode.adapter === "opencode-http");
    assert.equal(opencode.modelProfiles["default"]!.modelID, "MiniMax-M3.1-Flash");
    assert.ok(!("codebuddy" in result.config.backends));
  }
});

test("v2 的 `backend` 与 v3 的 `backends`/`defaultBackend` 混用被拒绝", () => {
  const mixed = withConfig((config) => {
    config["schemaVersion"] = 2;
    config["backend"] = { adapter: "opencode-http", pinnedVersion: "1.18.32", modelProfiles: { default: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } } };
  });
  const result = validateConfigObject(mixed);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.includes("不能同时出现")));
  }
});

test("未知 schemaVersion 与未知未来版本被拒绝", () => {
  for (const version of [1, 4, 99]) {
    const result = validateConfigObject(withConfig((config) => {
      config["schemaVersion"] = version;
    }));
    assert.equal(result.ok, false, `schemaVersion=${version} 应被拒绝`);
    if (!result.ok) assert.ok(result.issues.some((issue) => issue.includes("schemaVersion")));
  }
});

test("拒绝未知字段（防止夹带凭证或执行参数）", () => {
  const result = validateConfigObject(withConfig((config) => {
    config["apiKey"] = "sk-xxx";
  }));
  assert.equal(result.ok, false);
});

test("backends 键只接受三个固定 ID，别名/任意键被拒绝", () => {
  const aliased = withConfig((config) => {
    const backends = config["backends"] as Record<string, unknown>;
    backends["my-agent"] = backends["opencode"];
  });
  const result = validateConfigObject(aliased);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.includes("backends")));
});

test("defaultBackend 必须指向已配置且启用的后端", () => {
  const missing = validateConfigObject(withConfig((config) => {
    config["defaultBackend"] = "codebuddy";
  }));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.ok(missing.issues.some((issue) => issue.includes("defaultBackend")));

  // default 指向已配置但禁用的后端：拒绝。
  const disabledDefault = JSON.parse(JSON.stringify(withCodebuddy((entry) => {
    entry["enabled"] = false;
  }))) as Record<string, unknown>;
  disabledDefault["defaultBackend"] = "codebuddy";
  const result = validateConfigObject(disabledDefault);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.includes("禁用")));
})

test("CodeBuddy/Qoder 项接受原生单段模型 ID，拒绝双段/URL/路径/控制字符", () => {
  const valid = validateConfigObject(withCodebuddy());
  assert.equal(valid.ok, true, "合法的 codebuddy 项应通过");

  for (const bad of ["minimax/MiniMax-M3", "https://example.invalid/m", "/absolute/path", "glm 5.3", "glm\n5.3", " glm-5.3 "]) {
    const result = validateConfigObject(withCodebuddy((entry) => {
      (entry["models"] as Record<string, unknown>)["default"] = bad;
      (entry["models"] as Record<string, unknown>)["allowed"] = [bad];
    }));
    assert.equal(result.ok, false, `模型 ID ${JSON.stringify(bad)} 应被拒绝`);
  }

  const defaultNotInAllowed = validateConfigObject(withCodebuddy((entry) => {
    (entry["models"] as Record<string, unknown>)["allowed"] = ["glm-5.3"];
    (entry["models"] as Record<string, unknown>)["default"] = "glm-5.3-flash";
  }));
  assert.equal(defaultNotInAllowed.ok, false, "default 不在 allowed 内应被拒绝");

  const duplicated = validateConfigObject(withCodebuddy((entry) => {
    (entry["models"] as Record<string, unknown>)["allowed"] = ["glm-5.3", "glm-5.3"];
  }));
  assert.equal(duplicated.ok, false, "allowed 重复项应被拒绝");
});

test("新后端项不接受 OpenCode 的 provider 字段或凭证字段", () => {
  const withProvider = validateConfigObject(withCodebuddy((entry) => {
    entry["modelProfiles"] = { default: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } };
  }));
  assert.equal(withProvider.ok, false);

  const withToken = validateConfigObject(withCodebuddy((entry) => {
    entry["apiKey"] = "sk-xxx";
  }));
  assert.equal(withToken.ok, false);
});

test("认证只接受两种模式，credential-file 必须是绝对路径且不接受明文 token", () => {
  const fileAuth = validateConfigObject(withCodebuddy((entry) => {
    entry["auth"] = { mode: "credential-file", file: "/absolute/private/codebuddy-auth.json" };
  }));
  assert.equal(fileAuth.ok, true);

  const relative = validateConfigObject(withCodebuddy((entry) => {
    entry["auth"] = { mode: "credential-file", file: "relative/auth.json" };
  }));
  assert.equal(relative.ok, false);

  const inlineToken = validateConfigObject(withCodebuddy((entry) => {
    entry["auth"] = { mode: "credential-file", file: "/absolute/a.json", token: "sk-xxx" };
  }));
  assert.equal(inlineToken.ok, false);

  const unknownMode = validateConfigObject(withCodebuddy((entry) => {
    entry["auth"] = { mode: "env" };
  }));
  assert.equal(unknownMode.ok, false);
});

test("Qoder 项按自身 schema 校验，pinnedVersion 与基线锁定一致", () => {
  const result = validateConfigObject(withConfig((config) => {
    const backends = config["backends"] as Record<string, unknown>;
    backends["qoder"] = {
      adapter: "qoder-sdk",
      enabled: false,
      pinnedVersion: QODER_PINNED_CLI_VERSION,
      executable: "/opt/homebrew/bin/qodercli",
      auth: { mode: "credential-file", file: "/absolute/private/qoder-pat.json" },
      models: { default: "qoder-max", allowed: ["qoder-max", "qoder-flash"] },
    };
  }));
  assert.equal(result.ok, true);
  if (result.ok) {
    const qoder = result.config.backends["qoder"];
    assert.ok(qoder && qoder.adapter === "qoder-sdk");
  }

  const wrongPin = validateConfigObject(withConfig((config) => {
    const backends = config["backends"] as Record<string, unknown>;
    backends["qoder"] = {
      adapter: "qoder-sdk",
      enabled: false,
      pinnedVersion: "0.0.1",
      executable: "/opt/homebrew/bin/qodercli",
      auth: { mode: "cli-login" },
      models: { default: "qoder-max", allowed: ["qoder-max"] },
    };
  }));
  assert.equal(wrongPin.ok, false, "未锁定的 CLI 版本应被拒绝");
});

test("旧 adapter（zcode-acp）被明确拒绝，不做静默升级", () => {
  const oldAdapter = withConfig((config) => {
    opencodeOf(config)["adapter"] = "zcode-acp";
  });
  const result = validateConfigObject(oldAdapter);
  assert.equal(result.ok, false);
});

test("拒绝过宽的工作区根", () => {
  for (const root of ["/", homedir(), "/Users", `${tmpdir()}/proj`, "relative/path"]) {
    const result = validateConfigObject(withConfig((config) => {
      (config["workspaces"] as Array<Record<string, unknown>>)[0] = {
        id: "demo",
        root,
        profiles: ["review"],
      };
    }));
    assert.equal(result.ok, false, `root=${root} 应被拒绝`);
  }
});

test("checkWorkspaceRoot 的判定与错误文案", () => {
  assert.match(checkWorkspaceRoot("/") ?? "", /根目录/);
  assert.match(checkWorkspaceRoot(homedir()) ?? "", /主目录/);
  assert.match(checkWorkspaceRoot(`${tmpdir()}/x`) ?? "", /TMPDIR/);
  assert.match(checkWorkspaceRoot("rel/dir") ?? "", /绝对路径/);
  assert.equal(checkWorkspaceRoot("/opt/zb-demo"), null);
});

test("重复 workspace id 与重复 profile 被拒绝", () => {
  const duplicated = withConfig((config) => {
    config["workspaces"] = [
      { id: "demo", root: "/opt/zb-a", profiles: ["review"] },
      { id: "demo", root: "/opt/zb-b", profiles: ["review"] },
    ];
  });
  const result = validateConfigObject(duplicated);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.includes("重复的 id")));

  const doubled = withConfig((config) => {
    (config["workspaces"] as Array<Record<string, unknown>>)[0] = {
      id: "demo",
      root: "/opt/zb-a",
      profiles: ["review", "review"],
    };
  });
  const doubledResult = validateConfigObject(doubled);
  assert.equal(doubledResult.ok, false);
});

test("HTTP 只允许 loopback 绑定", () => {
  const result = validateConfigObject(withConfig((config) => {
    config["transport"] = { stdio: true, http: { enabled: true, bind: "0.0.0.0" } };
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.includes("loopback")));
});

test("OpenCode 版本必须与基线完全一致，不接受范围或未验证版本", () => {
  for (const pinnedVersion of ["^1.18.32", "~1.18.32", "1.18.33", "1.19.0", "latest"]) {
    const result = validateConfigObject(withConfig((config) => {
      opencodeOf(config)["pinnedVersion"] = pinnedVersion;
    }));
    assert.equal(result.ok, false, `pinnedVersion=${pinnedVersion} 应被拒绝`);
  }
});

test("modelProfiles 必须是受控 provider/model 映射，不能夹带 URL 或凭证", () => {
  const withoutDefault = withConfig((config) => {
    opencodeOf(config)["modelProfiles"] = {
      fast: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
    };
  });
  const missing = validateConfigObject(withoutDefault);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.ok(missing.issues.some((issue) => issue.includes("default")));

  const credential = withConfig((config) => {
    opencodeOf(config)["modelProfiles"] = {
      default: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash", apiKey: "sk-xxx" },
    };
  });
  assert.equal(validateConfigObject(credential).ok, false);

  const arbitraryUrl = withConfig((config) => {
    opencodeOf(config)["modelProfiles"] = {
      default: { providerID: "https://example.invalid", modelID: "MiniMax-M3.1-Flash" },
    };
  });
  assert.equal(validateConfigObject(arbitraryUrl).ok, false);
});

test("配置常量与样例保持一致", () => {
  const config = configTemplate();
  assert.equal(CONFIG_SCHEMA_VERSION, 3);
  assert.equal(config.schemaVersion, CONFIG_SCHEMA_VERSION);
  const opencode = config.backends["opencode"];
  assert.ok(opencode);
  assert.equal(opencode.adapter, OPENCODE_ADAPTER_ID);
  assert.equal(opencode.pinnedVersion, OPENCODE_PINNED_VERSION);
});
