import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "./host-test.ts";

import {
  changelogArgs,
  fixedReleaseVersion,
  prependChangelog,
  stageChangelog,
} from "../scripts/changelog.ts";

test("changelog prepends each release once", () => {
  const release = "## v0.2.5 (2026-09-04)\n\n* Add release tooling";
  const previous = "# Changelog\n\n## v0.2.4 (2026-08-01)\n\n* Initial release\n";
  const expected = `# Changelog\n\n${release}\n\n## v0.2.4 (2026-08-01)\n\n* Initial release\n`;

  assert.equal(prependChangelog(previous, release), expected);
  assert.equal(prependChangelog(expected, release), expected);

  const corrected = release.replace("Add", "Improve");
  assert.equal(
    prependChangelog(expected, corrected),
    expected.replace(release, corrected),
  );
});

test("changelog starts at the first commit when the repository has no tags", () => {
  assert.deepEqual(changelogArgs("abc123"), [
    "bunx",
    "--no-install",
    "lerna-changelog",
    "--next-version-from-metadata",
    "--from=abc123",
  ]);
});

test("private root changelog uses the updated Lerna fixed product version", () => {
  const version = fixedReleaseVersion({ version: "0.10.1" });
  assert.deepEqual(changelogArgs("abc123", version), [
    "bunx", "--no-install", "lerna-changelog", "--next-version=v0.10.1", "--from=abc123",
  ]);
  assert.equal(fixedReleaseVersion({ version: "0.10.1-beta.1" }), "0.10.1-beta.1");
  assert.throws(() => fixedReleaseVersion({ version: "independent" }), /fixed/);
});

test("changelog stages CHANGELOG.md so lerna commits it with the release", async () => {
  const decoder = new TextDecoder();
  const dir = await mkdtemp(join(tmpdir(), "changelog-stage-"));

  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.equal(result.exitCode, 0, decoder.decode(result.stderr).trim());
    return decoder.decode(result.stdout).trim();
  };

  try {
    git("init", "--quiet");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    await writeFile(join(dir, "CHANGELOG.md"), "# Changelog\n");
    git("add", "CHANGELOG.md");
    git("commit", "--quiet", "-m", "init");

    await writeFile(
      join(dir, "CHANGELOG.md"),
      "# Changelog\n\n## v0.7.1 (2026-09-21)\n\n* Fix release",
    );
    stageChangelog(dir);

    assert.equal(git("diff", "--cached", "--name-only"), "CHANGELOG.md");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
