import assert from "node:assert/strict";
import test from "node:test";

import { changelogArgs, prependChangelog } from "../scripts/changelog.ts";

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
    "lerna-changelog",
    "--next-version-from-metadata",
    "--from=abc123",
  ]);
});
