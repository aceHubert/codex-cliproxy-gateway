import { rename, rm } from "node:fs/promises";

const CHANGELOG_HEADER = "# Changelog";
const decoder = new TextDecoder();

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stderr: "pipe" });

  if (result.exitCode !== 0) {
    throw new Error(decoder.decode(result.stderr).trim());
  }

  return decoder.decode(result.stdout).trim();
}

function hasReachableTag(): boolean {
  return Bun.spawnSync(
    ["git", "describe", "--abbrev=0", "--tags", "HEAD"],
    { stderr: "pipe" },
  ).exitCode === 0;
}

export function changelogArgs(firstCommit?: string): string[] {
  const args = ["bunx", "lerna-changelog", "--next-version-from-metadata"];
  return firstCommit ? [...args, `--from=${firstCommit}`] : args;
}

export function prependChangelog(current: string, release: string): string {
  const entry = release.trim();
  const content = current.trim();
  const body = content.startsWith(CHANGELOG_HEADER)
    ? content.slice(CHANGELOG_HEADER.length).trim()
    : content;

  if (!entry) {
    return `${CHANGELOG_HEADER}${body ? `\n\n${body}` : ""}\n`;
  }

  const heading = entry.split("\n", 1)[0] ?? "";
  if (body.startsWith(heading)) {
    const nextEntry = body.indexOf("\n## ", heading.length);
    const previous = nextEntry < 0 ? "" : body.slice(nextEntry + 1).trim();
    return `${CHANGELOG_HEADER}\n\n${entry}${previous ? `\n\n${previous}` : ""}\n`;
  }

  return `${CHANGELOG_HEADER}\n\n${entry}${body ? `\n\n${body}` : ""}\n`;
}

async function main(): Promise<void> {
  const firstCommit = hasReachableTag()
    ? undefined
    : git("rev-list", "--max-parents=0", "HEAD");
  const changelog = Bun.spawn(
    changelogArgs(firstCommit),
    {
      env: { ...Bun.env, FORCE_COLOR: "0" },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const release = await new Response(changelog.stdout).text();
  const exitCode = await changelog.exited;

  if (exitCode !== 0) {
    console.error(release.trim());
    globalThis.process.exit(exitCode);
  }

  const path = "CHANGELOG.md";
  const file = Bun.file(path);
  const current = await file.exists() ? await file.text() : "";
  const temporaryPath = `${path}.tmp-${globalThis.process.pid}`;

  try {
    await Bun.write(temporaryPath, prependChangelog(current, release));
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

if (import.meta.main) {
  await main();
}
