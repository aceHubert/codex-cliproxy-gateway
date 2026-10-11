import type { ModelMatch } from "./types.ts";

type Token = { kind: "literal"; value: string } | { kind: "segment" | "any"; repeat: boolean };

export interface CompiledModelPattern {
  pattern: string;
  priority: 1 | 2 | 3;
  match(model: string): ModelMatch | undefined;
  readonly tokens: readonly Token[];
}

export function compileModelPattern(pattern: string): CompiledModelPattern {
  if (!pattern || pattern.trim() !== pattern) throw new Error(`无效模型模式：${JSON.stringify(pattern)}`);
  const prefix = pattern.endsWith("/*") ? pattern.slice(0, -1) : undefined;
  if (prefix === undefined && pattern.includes("*")) throw new Error(`通配模型模式必须以 /* 结尾：${pattern}`);
  if (prefix !== undefined && (prefix === "/" || prefix.split("/").slice(0, -1).some((part) => !part))) {
    throw new Error(`模型模式包含空前缀段：${pattern}`);
  }
  const priority = prefix === undefined ? 3 : prefix.includes("*") ? 1 : 2;
  const tokens: Token[] = [];
  for (const char of prefix ?? pattern) {
    tokens.push(char === "*" ? { kind: "segment", repeat: true } : { kind: "literal", value: char });
  }
  if (prefix !== undefined) tokens.push({ kind: "any", repeat: false }, { kind: "any", repeat: true });
  const segments = prefix?.slice(0, -1).split("/");
  return {
    pattern,
    priority,
    tokens,
    match(model) {
      if (prefix === undefined) return model === pattern ? { model, matchedPattern: pattern, matchedPrefix: "" } : undefined;
      const actual = model.split("/");
      if (actual.length <= segments!.length || !segments!.every((segment, index) => matchSegment(segment, actual[index]))) return undefined;
      const matchedPrefix = `${actual.slice(0, segments!.length).join("/")}/`;
      return model.length > matchedPrefix.length ? { model, matchedPattern: pattern, matchedPrefix } : undefined;
    },
  };
}

/** 有限状态匹配避免多个通配符导致正则回溯放大请求耗时。 */
function matchSegment(pattern: string, value: string): boolean {
  const tokens = [...pattern];
  let states = new Set<number>([0]);
  const expand = () => {
    for (const state of states) if (tokens[state] === "*") states.add(state + 1);
  };
  expand();
  for (const char of value) {
    const next = new Set<number>();
    for (const state of states) {
      if (tokens[state] === "*") next.add(state);
      else if (tokens[state] === char) next.add(state + 1);
    }
    states = next;
    expand();
    if (!states.size) return false;
  }
  return states.has(tokens.length);
}

/** 计算两个模式自动机的交集是否非空，完整判定重叠而非挑选样例。 */
export function modelPatternsOverlap(left: CompiledModelPattern, right: CompiledModelPattern): boolean {
  const alphabet = new Set<string>(["/"]);
  for (const token of [...left.tokens, ...right.tokens]) if (token.kind === "literal") alphabet.add(token.value);
  // 其它非 / 字符属于同一等价类，只需一个代表字符。
  let other = "\u0000";
  while (alphabet.has(other)) other = String.fromCodePoint(other.codePointAt(0)! + 1);
  alphabet.add(other);
  const pending: Array<[number, number]> = [[0, 0]];
  const visited = new Set<string>();
  for (let offset = 0; offset < pending.length; offset++) {
    const [a, b] = pending[offset];
    const key = `${a}:${b}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (a === left.tokens.length && b === right.tokens.length) return true;
    const first = left.tokens[a];
    const second = right.tokens[b];
    if (first && first.kind !== "literal" && first.repeat) pending.push([a + 1, b]);
    if (second && second.kind !== "literal" && second.repeat) pending.push([a, b + 1]);
    if (!first || !second) continue;
    for (const char of alphabet) {
      if (accepts(first, char) && accepts(second, char)) {
        pending.push([first.kind !== "literal" && first.repeat ? a : a + 1, second.kind !== "literal" && second.repeat ? b : b + 1]);
      }
    }
  }
  return false;
}

function accepts(token: Token, char: string): boolean {
  return token.kind === "literal" ? token.value === char : token.kind === "any" || char !== "/";
}
