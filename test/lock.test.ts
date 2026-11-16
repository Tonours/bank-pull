import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { openReadWrite } from "../src/db.js";
import { CliError, ExitCode } from "../src/errors.js";
import { acquireLock, lockedWrite, releaseLock } from "../src/lock.js";
import { tempHome } from "./support/tmp.js";

const locked = (error: unknown): boolean => error instanceof CliError && error.exitCode === ExitCode.locked;

function deadPid(): number {
  const run = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(run.stdout);
}

test("a held lock is refused; a released one can be taken again", () => {
  const db = openReadWrite(tempHome().paths);
  const token = acquireLock(db, new Date());
  assert.throws(() => acquireLock(db, new Date()), locked);
  releaseLock(db, "not-mine");
  assert.throws(() => acquireLock(db, new Date()), locked);
  releaseLock(db, token);
  releaseLock(db, acquireLock(db, new Date()));
  db.close();
});

test("a dead holder is reclaimed; a live holder is never reclaimed, whatever its age", () => {
  const db = openReadWrite(tempHome().paths);
  const insert = db.prepare("INSERT OR REPLACE INTO sync_lock (id, pid, token, started_at) VALUES (1, ?, 'old', '2000-01-01T00:00:00Z')");
  insert.run(process.pid);
  assert.throws(() => acquireLock(db, new Date()), locked);
  insert.run(deadPid());
  const token = acquireLock(db, new Date());
  assert.notEqual(token, "old");
  db.close();
});

test("a write with a stale token aborts and rolls back", () => {
  const db = openReadWrite(tempHome().paths);
  const token = acquireLock(db, new Date());
  db.prepare("UPDATE sync_lock SET token = 'thief'").run();
  assert.throws(
    () => lockedWrite(db, token, () => db.prepare("INSERT INTO sessions (id, aspsp_name, aspsp_country, valid_until, created_at) VALUES ('x', 'b', 'FR', 'v', 'c')").run()),
    locked,
  );
  assert.equal((db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n, 0);
  db.close();
});
