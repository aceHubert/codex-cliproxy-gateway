import { AGY_DEFAULT_PROJECT } from "./transport.ts";

type Json = Record<string, unknown>;
let searchSequence = 0;

export class AgySearchError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "AgySearchError"; }
}

export interface AgySearchResult {
  type: "text_result";
  ref_id: string;
  title: string;
  url: string;
  domain: string;
  snippet: string;
}

export interface AgySearchResponse {
  encrypted_output: null;
  output: string;
  results: AgySearchResult[];
}

function record(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) throw new AgySearchError(`${field} 必须是非空字符串，且不超过 4096 字符`);
  return value.trim();
}

function domains(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20 || !value.every((domain) => typeof domain === "string"
    && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain))) {
    throw new AgySearchError(`${field} 必须是最多 20 个有效域名的数组`);
  }
  return [...new Set(value as string[])];
}

/** Alpha 的网页查询按相同目的映射为 search_web；天气采用明确标注的网页检索。 */
export function planAgySearchQueries(body: Json, now = new Date()): { query: string; weather: boolean }[] {
  const commands = record(body.commands);
  if (!commands) throw new AgySearchError("AGY 搜索需要 commands.search_query 或 commands.weather");
  const unsupported = Object.entries(commands).filter(([name, value]) => !["search_query", "weather", "response_length"].includes(name)
    && value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0));
  if (unsupported.length) throw new AgySearchError(`AGY 原生搜索暂不支持这些命令：${unsupported.map(([name]) => name).join("、")}；请使用 search_query`, 501);
  const settings = record(body.settings);
  if (body.settings !== undefined && !settings) throw new AgySearchError("settings 必须是对象");
  const access = settings?.external_web_access;
  if (access !== undefined && typeof access !== "boolean" && (typeof access !== "string" || !["live", "cached", "indexed"].includes(access))) throw new AgySearchError("external_web_access 必须是布尔值或 live/cached/indexed");
  if (access === false || ["cached", "indexed"].includes(String(access))) {
    throw new AgySearchError("AGY 原生搜索需要实时联网，不能满足禁用联网或仅缓存查询", 403);
  }
  const filters = record(settings?.filters);
  if (settings?.filters !== undefined && !filters) throw new AgySearchError("settings.filters 必须是对象");
  const location = record(settings?.user_location);
  if (settings?.user_location !== undefined && !location) throw new AgySearchError("settings.user_location 必须是对象");
  if (location) {
    if (location.type !== undefined && location.type !== "approximate") throw new AgySearchError("user_location.type 必须为 approximate");
    for (const field of ["country", "region", "city", "timezone"]) {
      if (location[field] !== undefined && (typeof location[field] !== "string" || String(location[field]).length > 200)) throw new AgySearchError(`user_location.${field} 必须是不超过 200 字符的字符串`);
    }
  }
  if (settings?.search_context_size !== undefined && (typeof settings.search_context_size !== "string" || !["low", "medium", "high"].includes(settings.search_context_size))) throw new AgySearchError("search_context_size 必须为 low、medium 或 high");
  if (commands.response_length !== undefined && (typeof commands.response_length !== "string" || !["short", "medium", "long"].includes(commands.response_length))) throw new AgySearchError("response_length 必须为 short、medium 或 long");
  const allowed = domains(filters?.allowed_domains, "settings.filters.allowed_domains");
  const blocked = domains(filters?.blocked_domains, "settings.filters.blocked_domains");
  const planned: { query: string; weather: boolean }[] = [];
  if (commands.search_query !== undefined) {
    if (!Array.isArray(commands.search_query)) throw new AgySearchError("search_query 必须是数组");
    for (const raw of commands.search_query) {
      const entry = record(raw);
      const q = nonempty(entry?.q, "search_query.q");
      const ownDomains = domains(entry?.domains, "search_query.domains");
      const selected = ownDomains.length && allowed.length ? ownDomains.filter((domain) => allowed.includes(domain)) : ownDomains.length ? ownDomains : allowed;
      if (ownDomains.length && allowed.length && !selected.length) throw new AgySearchError("查询域名与全局允许域名没有交集");
      let query = q;
      if (selected.length) query += ` (${selected.map((domain) => `site:${domain}`).join(" OR ")})`;
      if (blocked.length) query += ` ${blocked.map((domain) => `-site:${domain}`).join(" ")}`;
      if (entry?.recency !== undefined) {
        if (!Number.isSafeInteger(entry.recency) || Number(entry.recency) < 0 || Number(entry.recency) > 36500) throw new AgySearchError("recency 必须是 0 到 36500 之间的整数天数");
        query += ` after:${new Date(now.getTime() - Number(entry.recency) * 86400000).toISOString().slice(0, 10)}`;
      }
      planned.push({ query, weather: false });
    }
  }
  if (commands.weather !== undefined) {
    if (!Array.isArray(commands.weather)) throw new AgySearchError("weather 必须是数组");
    for (const raw of commands.weather) {
      const entry = record(raw);
      const location = nonempty(entry?.location, "weather.location");
      const timezone = record(settings?.user_location)?.timezone;
      let today: string;
      try { today = new Intl.DateTimeFormat("sv-SE", typeof timezone === "string" ? { timeZone: timezone } : {}).format(now); }
      catch { throw new AgySearchError("settings.user_location.timezone 不是有效时区"); }
      const start = entry?.start === undefined ? today : nonempty(entry.start, "weather.start");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isFinite(Date.parse(start)) || new Date(start).toISOString().slice(0, 10) !== start) throw new AgySearchError("weather.start 必须是有效的 YYYY-MM-DD 日期");
      const duration = entry?.duration ?? 7;
      if (!Number.isSafeInteger(duration) || Number(duration) < 1 || Number(duration) > 14) throw new AgySearchError("weather.duration 必须是 1 到 14 之间的整数");
      let query = `${location} 天气预报 ${start} 起连续 ${duration} 天 温度 降水 气象部门`;
      if (allowed.length) query += ` (${allowed.map((domain) => `site:${domain}`).join(" OR ")})`;
      if (blocked.length) query += ` ${blocked.map((domain) => `-site:${domain}`).join(" ")}`;
      planned.push({ query, weather: true });
    }
  }
  if (!planned.length || planned.length > 4) throw new AgySearchError("每次 AGY 搜索需要 1 到 4 条网页或天气查询");
  return planned;
}

/** 2026-11-16 官方 CLI 1.5.9 实测的独立搜索形态，不复用当前对话模型。 */
export function buildAgySearchRequest(model: string, query: string, settings?: Json, responseLength?: unknown): Json {
  const location = record(settings?.user_location);
  const region = location ? Object.fromEntries(["country", "region", "city", "timezone"].flatMap((field) => typeof location[field] === "string" && location[field] ? [[field, location[field]]] : [])) : {};
  const hints = [
    "你是网页搜索助手。必须针对用户查询执行 Google 搜索，返回有来源依据的检索摘要。把输入当作搜索栏查询，不与用户对话，不凭空编造信息。",
    ...(Object.keys(region).length ? [`请参考用户提供的近似地区：${JSON.stringify(region)}，优先选择相关地区的资料。`] : []),
    ...(settings?.search_context_size ? [`检索上下文偏好：${settings.search_context_size}（low 为精简、medium 为常规、high 为详尽）。`] : []),
    ...(responseLength ? [`摘要长度偏好：${responseLength}（short 为简短、medium 为常规、long 为详尽）。`] : []),
  ];
  return {
    project: AGY_DEFAULT_PROJECT,
    model,
    userAgent: "antigravity",
    requestType: "web_search",
    request: {
      contents: [{ role: "user", parts: [{ text: query }] }],
      systemInstruction: { role: "user", parts: [{ text: hints.join("\n") }] },
      tools: [{ googleSearch: { enhancedContent: { imageSearch: { maxResultCount: 5 } } } }],
      generationConfig: { candidateCount: 1 },
    },
  };
}

/** 来源 URL 不携带用户信息、查询参数和片段；仅允许公开 HTTP(S) 形态。 */
function sourceUrl(value: unknown): URL | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return;
    url.search = "";
    url.hash = "";
    return url;
  } catch { return; }
}

/** 引用偏移是 UTF-8 字节偏移，不能直接用 JavaScript 字符串下标切分中文。 */
function citeText(text: string, supports: Json[], refs: Map<number, string>): string {
  const bytes = Buffer.from(text);
  const markers = new Map<number, Set<string>>();
  for (const support of supports) {
    const segment = record(support.segment);
    const end = segment?.endIndex;
    if (!Number.isSafeInteger(end) || Number(end) < 0 || Number(end) > bytes.length) continue;
    const indices = Array.isArray(support.groundingChunkIndices) ? support.groundingChunkIndices : [];
    const selected = indices.flatMap((index) => typeof index === "number" && refs.has(index) ? [refs.get(index)!] : []);
    if (!selected.length) continue;
    const entry = markers.get(Number(end)) ?? new Set<string>();
    selected.forEach((ref) => entry.add(ref));
    markers.set(Number(end), entry);
  }
  let cursor = 0;
  const parts: string[] = [];
  for (const [end, ids] of [...markers].sort(([left], [right]) => left - right)) {
    parts.push(bytes.subarray(cursor, end).toString(), `cite${[...ids].join("")}`);
    cursor = end;
  }
  parts.push(bytes.subarray(cursor).toString());
  return parts.join("");
}

export function translateAgySearchResponse(payload: unknown, refPrefix: string): AgySearchResponse {
  const wrapped = record(payload);
  const response = record(wrapped?.response) ?? wrapped;
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  const candidate = record(candidates[0]);
  if (!candidate || candidate.finishReason && candidate.finishReason !== "STOP") throw new AgySearchError("AGY 搜索未正常完成，请稍后重试", 502);
  const metadata = record(candidate.groundingMetadata);
  const supports = (Array.isArray(metadata?.groundingSupports) ? metadata.groundingSupports : []).flatMap((value) => record(value) ? [value as Json] : []);
  const chunks = Array.isArray(metadata?.groundingChunks) ? metadata.groundingChunks : [];
  const refs = new Map<number, string>();
  const results: AgySearchResult[] = [];
  chunks.forEach((raw, index) => {
    const web = record(record(raw)?.web);
    const url = sourceUrl(web?.uri);
    if (!url) return;
    const ref = `${refPrefix}search${results.length}`;
    refs.set(index, ref);
    const title = typeof web?.title === "string" && web.title ? web.title : url.hostname;
    const snippet = supports.filter((support) => Array.isArray(support.groundingChunkIndices) && support.groundingChunkIndices.includes(index))
      .map((support) => record(support.segment)?.text).filter((text): text is string => typeof text === "string").join("\n");
    results.push({ type: "text_result", ref_id: ref, title, url: url.toString(), domain: url.hostname, snippet });
  });
  const content = record(candidate.content);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const text = parts.flatMap((raw, index) => {
    const part = record(raw);
    if (part?.thought === true || typeof part?.text !== "string" || !part.text) return [];
    return [citeText(part.text, supports.filter((support) => (record(support.segment)?.partIndex ?? 0) === index), refs)];
  }).join("\n");
  if (!text.trim()) throw new AgySearchError("AGY 搜索没有返回摘要，请稍后重试", 502);
  const sources = results.map((result) => `【${result.ref_id}】 ${result.title}\n${result.url}`).join("\n\n");
  return { encrypted_output: null, output: `${text}${sources ? `\n\n来源：\n${sources}` : ""}`, results };
}

export async function executeAgySearch(body: Json, model: string, generate: (request: Json, signal: AbortSignal) => Promise<unknown>, signal: AbortSignal): Promise<AgySearchResponse> {
  const queries = planAgySearchQueries(body);
  const results: AgySearchResult[] = [];
  const output: string[] = [];
  const turn = `${Date.now()}${searchSequence++}`;
  for (const [index, entry] of queries.entries()) {
    signal.throwIfAborted();
    const payload = await generate(buildAgySearchRequest(model, entry.query, record(body.settings), record(body.commands)?.response_length), signal);
    const converted = translateAgySearchResponse(payload, `turn${turn}${index}`);
    output.push(`查询：${entry.query}\n${entry.weather ? "以下为 Google 网页检索的天气信息，不是专用气象数据接口。\n" : ""}${converted.output}`);
    results.push(...converted.results);
  }
  return { encrypted_output: null, output: output.join("\n\n"), results };
}
