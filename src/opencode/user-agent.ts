import {
  OPENCODE_ZEN_CLIENT_CHANNEL,
  OPENCODE_ZEN_CLIENT_NAME,
  OPENCODE_ZEN_CLIENT_VERSION,
} from "./fingerprint.ts";

/**
 * 官方客户端 UA 的版本获取（`opencode/<channel>/<version>/<clientName>`）。
 *
 * 门禁按 UA 解析客户端版本，官方版本持续滚动（beta-19086 → beta-19271 → GA 2.0.26 …），
 * 静态快照在上游收紧版本校验时会集体 403。这里在运行时按 npm dist-tag 取当前渠道
 * 版本（GA 线为 `@opencode/cli` 的 `latest` 标签，bin 即 opencode2），失败一律回退
 * fingerprint-data.json 的快照值——拉取失败的行为与改造前完全一致，不会比快照更差。
 *
 * 保守边界：渠道段优先取版本串的预发布段（`0.0.0-beta-19271` → `beta`），无预发布段
 * 的正式版则取标签名（`latest` 标签的 `2.0.26` → `latest`，与 GA 客户端一致）；且只接受
 * 与快照同渠道的构建，跨渠道（如 latest 标签被切到 beta 构建）保持快照不猜。
 */

/** 官方客户端包（bin 为 opencode2）与其渠道标签：GA 线在 `@opencode/cli` 的 `latest`。 */
export const OPENCODE_ZEN_CLIENT_NPM_PACKAGE = "@opencode/cli";
export const OPENCODE_ZEN_CLIENT_DIST_TAG = "latest";
export const OPENCODE_ZEN_CLIENT_VERSION_URL =
  `https://registry.npmjs.org/-/package/${OPENCODE_ZEN_CLIENT_NPM_PACKAGE}/dist-tags`;

/** 官方版本号形状：`<semver>` 或 `<semver>-<channel>-<build>`；拒绝畸形与异常响应。 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-([a-z][a-z0-9]*(?:-[a-z0-9]+)*))?$/i;

/** 默认 6 小时：beta 构建滚动发布，一天 4 次足够跟上，也不给 npm 添压力。 */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/** 组装四段式 UA（渠道段与版本段分离，便于按渠道裁剪）。 */
export function opencodeZenUserAgent(version: string, channel: string): string {
  return `opencode/${channel}/${version}/${OPENCODE_ZEN_CLIENT_NAME}`;
}

/** 解析结果：版本号与其自带渠道段（渠道从版本串读出，不由标签名推断）。 */
export interface OpencodeZenClientVersion {
  version: string;
  channel: string;
}

/**
 * 从 npm dist-tags 响应取目标标签的版本号与渠道段。渠道段优先取版本串的预发布段
 * （`0.0.0-beta-19271` → `beta`）；无预发布段的正式版（`2.0.26`）回落到标签名
 * （`latest` 标签 → `latest`），与 GA 客户端 `opencode/latest/<version>/cli` 一致。
 */
export function parseOpencodeZenClientVersion(payload: unknown, distTag = OPENCODE_ZEN_CLIENT_DIST_TAG): OpencodeZenClientVersion | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const raw = (payload as Record<string, unknown>)[distTag];
  if (typeof raw !== "string") return undefined;
  const version = raw.trim();
  const match = VERSION_PATTERN.exec(version);
  if (!match) return undefined;
  const channel = match[1]?.split("-")[0]?.toLowerCase() ?? distTag.toLowerCase();
  return { version, channel };
}

export interface OpencodeZenUserAgentStore {
  /** 当前 UA：取到动态版本用它，否则回退快照。同步返回，转发路径零等待。 */
  current(): string;
  /** 按 TTL 拉取最新版本；失败静默保留现值（TTL 内不重试）。 */
  refresh(): Promise<void>;
}

export interface OpencodeZenUserAgentOptions {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  url?: string;
  distTag?: string;
  /** UA 渠道段（缺省与 distTag 同值，均为官方 beta 渠道）。 */
  channel?: string;
  ttlMs?: number;
  now?: () => number;
  /** 快照回退值（缺省取 fingerprint-data.json 的客户端版本与渠道）。 */
  snapshotVersion?: string;
  snapshotChannel?: string;
}

export function createOpencodeZenUserAgentStore(options: OpencodeZenUserAgentOptions): OpencodeZenUserAgentStore {
  const url = options.url ?? OPENCODE_ZEN_CLIENT_VERSION_URL;
  const distTag = options.distTag ?? OPENCODE_ZEN_CLIENT_DIST_TAG;
  const channel = options.channel ?? OPENCODE_ZEN_CLIENT_CHANNEL;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const snapshot = opencodeZenUserAgent(
    options.snapshotVersion ?? OPENCODE_ZEN_CLIENT_VERSION,
    options.snapshotChannel ?? OPENCODE_ZEN_CLIENT_CHANNEL,
  );
  let resolved: string | undefined;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  return {
    current(): string {
      return resolved ?? snapshot;
    },
    async refresh(): Promise<void> {
      if (now() - lastAttempt < ttlMs) return;
      lastAttempt = now();
      try {
        const response = await options.fetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) return;
        const parsed = parseOpencodeZenClientVersion(await response.json(), distTag);
        // 只接受与快照同渠道的构建：跨渠道（如 beta 标签被切到 dev 构建）不猜，保持快照。
        if (parsed && parsed.channel === channel) resolved = opencodeZenUserAgent(parsed.version, parsed.channel);
      } catch {
        // 拉取失败保留现值（快照或上次成功的动态值），TTL 过后再试。
      }
    },
  };
}
