import { strict as assert } from "node:assert";
import { chmodSync, existsSync, readdirSync, statSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { resolvePaths } from "../src/config.js";
import { openReadOnly, openReadWrite, SCHEMA_VERSION } from "../src/db.js";
import { CliError, ExitCode } from "../src/errors.js";
import { tempHome } from "./support/tmp.js";

const mode = (path: string): number => statSync(path).mode & 0o777;

test("openReadWrite creates a private data dir and DB, migrated to the current version", () => {
  const { paths } = tempHome();
  const db = openReadWrite(paths);
  const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(version.user_version, SCHEMA_VERSION);
  db.prepare("SELECT count(*) AS n FROM transactions").get();
  db.close();
  assert.equal(mode(paths.dataDir), 0o700);
  assert.equal(mode(paths.dbFile), 0o600);
  assert.deepEqual(readdirSync(paths.dataDir), ["bank-pull.db"]);
});

test("reopening is idempotent", () => {
  const { paths } = tempHome();
  openReadWrite(paths).close();
  const db = openReadWrite(paths);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
  db.close();
});

test("a loose DB file or data dir is refused before opening", () => {
  const { paths } = tempHome();
  openReadWrite(paths).close();
  chmodSync(paths.dbFile, 0o644);
  for (const open of [openReadWrite, openReadOnly]) {
    assert.throws(() => open(paths), (error: unknown) => error instanceof CliError && error.exitCode === ExitCode.permissions);
  }
  chmodSync(paths.dbFile, 0o600);
  chmodSync(paths.dataDir, 0o755);
  assert.throws(() => openReadOnly(paths), /chmod 700/);
  chmodSync(paths.dataDir, 0o700);
});

test("openReadOnly never creates a DB and cannot write", () => {
  const { paths } = tempHome();
  assert.throws(() => openReadOnly(paths), /does not exist/);
  assert.equal(existsSync(paths.dbFile), false);
  openReadWrite(paths).close();
  const db = openReadOnly(paths);
  assert.throws(() => db.exec("DELETE FROM transactions"), /readonly/);
  db.close();
});

test("openReadOnly refuses an unmigrated or newer DB", () => {
  const { paths } = tempHome();
  openReadWrite(paths).close();
  const raw = new DatabaseSync(paths.dbFile);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  raw.close();
  assert.throws(() => openReadOnly(paths), /newer than this bank-pull/);
  assert.throws(() => openReadWrite(paths), /newer than this bank-pull/);
  const reset = new DatabaseSync(paths.dbFile);
  reset.exec("PRAGMA user_version = 0");
  reset.close();
  assert.throws(() => openReadOnly(paths), /run "bank-pull sync" to migrate/);
});

test("a read-only open creates no file in the data dir, and works in a 0500 data dir", () => {
  const { paths } = tempHome();
  openReadWrite(paths).close();
  const before = readdirSync(paths.dataDir).sort();
  const db = openReadOnly(paths);
  db.prepare("SELECT count(*) AS n FROM transactions").get();
  assert.deepEqual(readdirSync(paths.dataDir).sort(), before);
  db.close();
  assert.deepEqual(readdirSync(paths.dataDir).sort(), before);
  chmodSync(paths.dataDir, 0o500);
  try {
    const locked = openReadOnly(paths);
    assert.ok(locked.prepare("SELECT count(*) AS n FROM accounts").get());
    locked.close();
  } finally {
    chmodSync(paths.dataDir, 0o700);
  }
  assert.deepEqual(readdirSync(paths.dataDir).sort(), before);
});

for (const suffix of ["-wal", "-shm", "-journal"]) {
  test(`a loose ${suffix} sidecar (0644) or a symlinked one is refused with exit 6`, () => {
    const { root, paths } = tempHome();
    openReadWrite(paths).close();
    const sidecar = paths.dbFile + suffix;
    writeFileSync(sidecar, "", { mode: 0o600 });
    chmodSync(sidecar, 0o644);
    for (const open of [openReadWrite, openReadOnly]) {
      assert.throws(
        () => open(paths),
        (error: unknown) => error instanceof CliError && error.exitCode === ExitCode.permissions && error.message.includes(`chmod 600 ${sidecar}`),
      );
    }
    chmodSync(sidecar, 0o600);
    openReadOnly(paths).close();
    unlinkSync(sidecar);
    symlinkSync(join(root, "missing"), sidecar);
    assert.throws(() => openReadOnly(paths), /is a symbolic link/);
  });
}

test("a data dir override with .. through a symlink gates the directory that is opened", () => {
  const { root, paths: own } = tempHome();
  // safe/data is private; shared/data is world-writable and holds a 0600 DB
  mkdirSync(join(root, "safe", "child"), { recursive: true, mode: 0o700 });
  openReadWrite({ ...own, dataDir: join(root, "safe", "data"), dbFile: join(root, "safe", "data", "bank-pull.db") }).close();
  const sharedData = join(root, "shared", "data");
  openReadWrite({ ...own, dataDir: sharedData, dbFile: join(sharedData, "bank-pull.db") }).close();
  chmodSync(sharedData, 0o777);
  symlinkSync(join(root, "safe", "child"), join(root, "shared", "link"));
  const paths = resolvePaths({ HOME: root, BANK_PULL_DATA_DIR: join(root, "shared", "link") + "/../data" });
  assert.equal(paths.dataDir, sharedData);
  for (const open of [openReadOnly, openReadWrite]) {
    assert.throws(() => open(paths), (error: unknown) => error instanceof CliError && error.exitCode === ExitCode.permissions && error.message.includes(`chmod 700 ${sharedData}`));
  }
  chmodSync(sharedData, 0o700);
});

test("openReadOnly refuses a WAL-format DB before SQLite can create sidecars", () => {
  const { paths } = tempHome();
  openReadWrite(paths).close();
  const raw = new DatabaseSync(paths.dbFile);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.close();
  const before = readdirSync(paths.dataDir).sort();
  assert.deepEqual(before, ["bank-pull.db"]);
  assert.throws(() => openReadOnly(paths), /is in WAL mode; run "bank-pull sync"/);
  assert.deepEqual(readdirSync(paths.dataDir).sort(), before);
  openReadWrite(paths).close();
  assert.deepEqual(readdirSync(paths.dataDir).sort(), before);
  openReadOnly(paths).close();
  assert.deepEqual(readdirSync(paths.dataDir).sort(), before);
});

test("an unreadable DB file maps to exit 6 naming the path", { skip: process.getuid?.() === 0 && "root bypasses mode bits" }, () => {
  const { paths } = tempHome();
  openReadWrite(paths).close();
  chmodSync(paths.dbFile, 0o200);
  try {
    assert.throws(() => openReadOnly(paths), (error: unknown) => error instanceof CliError && error.exitCode === ExitCode.permissions && error.message.includes(paths.dbFile));
  } finally {
    chmodSync(paths.dbFile, 0o600);
  }
});
