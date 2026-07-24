import fs from "node:fs";
import path from "node:path";

const TABLE_RE = /^\s*\[/;
const ASSIGN_RE = /^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)(.*?)(\r?\n)?$/;

function encodeTomlString(value: string): string {
  return JSON.stringify(value);
}

function rootRange(lines: string[]): number {
  const end = lines.findIndex((line) => TABLE_RE.test(line));
  return end === -1 ? lines.length : end;
}

function findRootKey(lines: string[], key: string): number {
  const end = rootRange(lines);
  const matches = [];
  for (let i = 0; i < end; i += 1) {
    const match = lines[i].match(ASSIGN_RE);
    if (match?.[2] === key) matches.push(i);
  }
  if (matches.length > 1) {
    throw new Error(`Duplicate root-level TOML key: ${key}`);
  }
  return matches[0] ?? -1;
}

function splitComment(value: string): string {
  let basic = false;
  let literal = false;
  let escaped = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (basic && char === "\\") {
      escaped = true;
      continue;
    }
    if (!literal && char === '"') {
      basic = !basic;
      continue;
    }
    if (!basic && char === "'") {
      literal = !literal;
      continue;
    }
    if (!basic && !literal && char === "#") {
      return value.slice(i);
    }
  }
  return "";
}

export function patchRootToml(source: string, updates: Record<string, string>): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = source.endsWith("\n");
  const lines = source.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) ?? [];

  for (const [key, value] of Object.entries(updates)) {
    const index = findRootKey(lines, key);
    const encoded = encodeTomlString(value);
    if (index >= 0) {
      const match = lines[index].match(ASSIGN_RE);
      if (!match) throw new Error(`Unable to parse TOML assignment: ${key}`);
      const comment = splitComment(match[4]);
      const ending = match[5] || "";
      lines[index] = `${match[1]}${key}${match[3]}${encoded}${comment ? ` ${comment}` : ""}${ending}`;
    } else {
      const insertAt = rootRange(lines);
      if (insertAt > 0 && !lines[insertAt - 1].endsWith("\n")) {
        lines[insertAt - 1] += newline;
      }
      lines.splice(insertAt, 0, `${key} = ${encoded}${newline}`);
    }
  }

  let result = lines.join("");
  if (!hadFinalNewline && source.length > 0 && result.endsWith(newline)) {
    result = result.slice(0, -newline.length);
  }
  return result;
}

export function restoreRootTomlKeys(current: string, backup: string, keys: string[]): string {
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const lines = current.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) ?? [];
  const backupLines = backup.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) ?? [];

  for (const key of keys) {
    const currentIndex = findRootKey(lines, key);
    const backupIndex = findRootKey(backupLines, key);
    if (backupIndex < 0) {
      if (currentIndex >= 0) lines.splice(currentIndex, 1);
      continue;
    }

    const originalLine = backupLines[backupIndex];
    if (currentIndex >= 0) {
      lines[currentIndex] = originalLine;
    } else {
      const insertAt = rootRange(lines);
      if (insertAt > 0 && !lines[insertAt - 1].endsWith("\n")) lines[insertAt - 1] += newline;
      lines.splice(insertAt, 0, originalLine.endsWith("\n") ? originalLine : `${originalLine}${newline}`);
    }
  }
  return lines.join("");
}

export function readRootTomlString(source: string, key: string): string | undefined {
  const lines = source.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) ?? [];
  const index = findRootKey(lines, key);
  if (index < 0) return undefined;
  const match = lines[index].match(ASSIGN_RE);
  if (!match) return undefined;
  const raw = match[4].trim();
  const jsonString = raw.match(/^"(?:[^"\\]|\\.)*"/)?.[0];
  if (!jsonString) return undefined;
  try {
    return JSON.parse(jsonString);
  } catch {
    return undefined;
  }
}

export function atomicWrite(file: string, contents: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, contents, { mode });
  fs.renameSync(temp, file);
}
