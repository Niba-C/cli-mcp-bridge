/**
 * 极简参数解析。不引第三方 CLI 库：命令面很小，且要保证「未知参数即失败」
 * （配置文件/命令行的宽松解析是安全事故的常见来源）。
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface ParsedArgs {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}

const BOOLEAN_FLAGS = new Set(["json", "force", "help", "default", "available", "online"]);
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      if (token.startsWith("-")) throw new UsageError(`不支持的短参数 ${token}`);
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      const key = body.slice(0, eq);
      if (BOOLEAN_FLAGS.has(key)) throw new UsageError(`--${key} 不接受取值`);
      flags[key] = body.slice(eq + 1);
      continue;
    }

    if (BOOLEAN_FLAGS.has(body)) {
      flags[body] = true;
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`--${body} 需要一个取值`);
    }
    flags[body] = value;
    index += 1;
  }

  return { positional, flags };
}

export function requireString(flags: ParsedArgs["flags"], key: string): string {
  const value = flags[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new UsageError(`缺少必填参数 --${key}`);
  }
  return value;
}

export function optionalString(flags: ParsedArgs["flags"], key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

export function optionalInt(flags: ParsedArgs["flags"], key: string): number | undefined {
  const value = optionalString(flags, key);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`--${key} 必须是整数`);
  return Number.parseInt(value, 10);
}

/**
 * 未知参数一律报错。注释里承诺的「未知参数即失败」必须落到代码上，
 * 否则拼错的 --dry-run 会被静默忽略，变成一次真实执行。
 * `--json` 对所有命令都合法。
 */
export function assertKnownFlags(flags: ParsedArgs["flags"], allowed: readonly string[]): void {
  const allowedSet = new Set(["json", ...allowed]);
  for (const key of Object.keys(flags)) {
    if (!allowedSet.has(key)) throw new UsageError(`未知参数 --${key}`);
  }
}
