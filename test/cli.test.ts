import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("--help exits 0 and prints usage", () => {
  const run = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /Usage: bank-pull/);
});

test("unknown command exits 2", () => {
  const run = spawnSync(process.execPath, [cli, "nope"], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unknown command "nope"/);
});
