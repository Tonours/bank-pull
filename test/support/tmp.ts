import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import type { Env, Paths } from "../../src/config.js";
import { resolvePaths } from "../../src/config.js";

/** A private temporary home (mode 0700) removed after the test file; never the real ~/.config. */
export function tempHome(): { root: string; env: Env; paths: Paths } {
  const root = mkdtempSync(join(tmpdir(), "bank-pull-test-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const env: Env = {
    HOME: root,
    BANK_PULL_CONFIG_DIR: join(root, "config"),
    BANK_PULL_DATA_DIR: join(root, "data"),
  };
  return { root, env, paths: resolvePaths(env) };
}
