import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { assertPrivate, ensurePrivateDir, ensurePrivateFile, loadConfig, readPrivateKey, resolvePaths } from "../src/config.js";
import { CliError, ExitCode } from "../src/errors.js";
import { tempHome } from "./support/tmp.js";

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

const isRoot = process.getuid?.() === 0;

function exitCode(fn: () => unknown, code: number, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof CliError, String(error));
    assert.equal(error.exitCode, code);
    assert.match(error.message, pattern);
    return true;
  });
}

function permissionError(fn: () => unknown, path: string, fix: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, ExitCode.permissions);
    assert.ok(error.message.includes(path), error.message);
    assert.ok(error.message.includes(`${fix} ${path}`), error.message);
    return true;
  });
}

test("resolvePaths prefers explicit overrides, then XDG, then HOME", () => {
  assert.deepEqual(resolvePaths({ HOME: "/h" }), {
    configDir: "/h/.config/bank-pull",
    configFile: "/h/.config/bank-pull/config.json",
    dataDir: "/h/.local/share/bank-pull",
    dbFile: "/h/.local/share/bank-pull/bank-pull.db",
  });
  const xdg = resolvePaths({ HOME: "/h", XDG_CONFIG_HOME: "/c", XDG_DATA_HOME: "/d" });
  assert.equal(xdg.configDir, "/c/bank-pull");
  assert.equal(xdg.dataDir, "/d/bank-pull");
  const explicit = resolvePaths({ HOME: "/h", XDG_CONFIG_HOME: "/c", BANK_PULL_CONFIG_DIR: "/x", BANK_PULL_DATA_DIR: "/y" });
  assert.equal(explicit.configFile, "/x/config.json");
  assert.equal(explicit.dbFile, "/y/bank-pull.db");
});

test("ensurePrivateDir and ensurePrivateFile create 0700 / 0600", () => {
  const { root } = tempHome();
  const dir = join(root, "a", "b");
  ensurePrivateDir(dir);
  assert.equal(mode(dir), 0o700);
  const file = join(dir, "f");
  ensurePrivateFile(file);
  assert.equal(mode(file), 0o600);
  ensurePrivateFile(file);
  assert.equal(mode(file), 0o600);
});

for (const bad of [0o640, 0o644, 0o604, 0o660]) {
  test(`a file with mode ${bad.toString(8)} is refused with the chmod 600 fix`, () => {
    const { root } = tempHome();
    const file = join(root, "key.pem");
    writeFileSync(file, "x", { mode: 0o600 });
    chmodSync(file, bad);
    permissionError(() => assertPrivate(file, "file"), file, "chmod 600");
  });
}

for (const bad of [0o750, 0o755, 0o707]) {
  test(`a directory with mode ${bad.toString(8)} is refused with the chmod 700 fix`, () => {
    const { root } = tempHome();
    const dir = join(root, "d");
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, bad);
    permissionError(() => assertPrivate(dir, "dir"), dir, "chmod 700");
    permissionError(() => ensurePrivateDir(dir), dir, "chmod 700");
  });
}

test("mode 0600 file and 0700 dir pass", () => {
  const { root } = tempHome();
  const file = join(root, "ok");
  writeFileSync(file, "x", { mode: 0o600 });
  assert.doesNotThrow(() => assertPrivate(file, "file"));
  assert.doesNotThrow(() => assertPrivate(root, "dir"));
});

test("a directory where a file is expected is refused", () => {
  const { root } = tempHome();
  assert.throws(() => assertPrivate(root, "file"), /not a regular file/);
});

test("readPrivateKey refuses a 0644 key and never returns its content", () => {
  const { root } = tempHome();
  const key = join(root, "private.key");
  writeFileSync(key, "SECRET", { mode: 0o600 });
  assert.equal(readPrivateKey(key), "SECRET");
  chmodSync(key, 0o644);
  permissionError(() => readPrivateKey(key), key, "chmod 600");
  chmodSync(key, 0o600);
  chmodSync(root, 0o755);
  permissionError(() => readPrivateKey(key), root, "chmod 700");
  chmodSync(root, 0o700);
});

test("loadConfig checks permissions, then validates fields", () => {
  const { paths } = tempHome();
  ensurePrivateDir(paths.configDir);
  const write = (value: unknown): void => writeFileSync(paths.configFile, JSON.stringify(value), { mode: 0o600 });
  write({ appId: "app", keyPath: "/k", redirectUrl: "https://localhost/cb" });
  assert.deepEqual(loadConfig(paths), { appId: "app", keyPath: "/k", redirectUrl: "https://localhost/cb" });
  write({ appId: "app", keyPath: "/k", redirectUrl: "http://localhost/cb" });
  assert.throws(() => loadConfig(paths), /https URL/);
  write({ appId: "", keyPath: "/k", redirectUrl: "https://localhost/cb" });
  assert.throws(() => loadConfig(paths), /"appId"/);
  writeFileSync(paths.configFile, "{", { mode: 0o600 });
  assert.throws(() => loadConfig(paths), /invalid JSON/);
  chmodSync(paths.configFile, 0o644);
  permissionError(() => loadConfig(paths), paths.configFile, "chmod 600");
});

test("resolvePaths ignores empty or relative XDG values", () => {
  for (const bad of ["", "rel/dir", "./x"]) {
    const paths = resolvePaths({ HOME: "/h", XDG_CONFIG_HOME: bad, XDG_DATA_HOME: bad });
    assert.equal(paths.configDir, "/h/.config/bank-pull");
    assert.equal(paths.dataDir, "/h/.local/share/bank-pull");
  }
});

test("resolvePaths requires absolute BANK_PULL_* overrides and treats empty as unset", () => {
  exitCode(() => resolvePaths({ HOME: "/h", BANK_PULL_CONFIG_DIR: "rel" }), ExitCode.usage, /BANK_PULL_CONFIG_DIR must be an absolute path/);
  exitCode(() => resolvePaths({ HOME: "/h", BANK_PULL_DATA_DIR: "./data" }), ExitCode.usage, /BANK_PULL_DATA_DIR must be an absolute path/);
  const empty = resolvePaths({ HOME: "/h", BANK_PULL_CONFIG_DIR: "", BANK_PULL_DATA_DIR: "" });
  assert.equal(empty.configDir, "/h/.config/bank-pull");
  assert.equal(empty.dataDir, "/h/.local/share/bank-pull");
});

test("symlinked key, key dir, config file and config dir are refused before any read", () => {
  const { root, paths } = tempHome();
  const shared = join(root, "shared");
  mkdirSync(shared, { mode: 0o700 });
  chmodSync(shared, 0o777);
  writeFileSync(join(shared, "key.pem"), "SECRET", { mode: 0o600 });
  const priv = join(root, "private");
  mkdirSync(priv, { mode: 0o700 });
  const keyLink = join(priv, "key.pem");
  symlinkSync(join(shared, "key.pem"), keyLink);
  exitCode(() => readPrivateKey(keyLink), ExitCode.permissions, /key\.pem is a symbolic link/);
  const dirLink = join(root, "dirlink");
  symlinkSync(priv, dirLink);
  writeFileSync(join(priv, "real.pem"), "SECRET", { mode: 0o600 });
  exitCode(() => readPrivateKey(join(dirLink, "real.pem")), ExitCode.permissions, /dirlink is a symbolic link/);

  ensurePrivateDir(paths.configDir);
  writeFileSync(join(shared, "config.json"), "{}", { mode: 0o600 });
  symlinkSync(join(shared, "config.json"), paths.configFile);
  exitCode(() => loadConfig(paths), ExitCode.permissions, /config\.json is a symbolic link/);
  exitCode(() => ensurePrivateFile(paths.configFile), ExitCode.permissions, /is a symbolic link/);
  const linkedConfigDir = { ...paths, configDir: join(root, "cfglink"), configFile: join(root, "cfglink", "config.json") };
  symlinkSync(paths.configDir, linkedConfigDir.configDir);
  exitCode(() => loadConfig(linkedConfigDir), ExitCode.permissions, /cfglink is a symbolic link/);
  exitCode(() => ensurePrivateDir(linkedConfigDir.configDir), ExitCode.permissions, /is a symbolic link/);
});

test("readPrivateKey refuses a relative keyPath", () => {
  exitCode(() => readPrivateKey("key.pem"), ExitCode.usage, /keyPath must be an absolute path/);
});

test("ensurePrivateDir on an existing regular file is refused with exit 6", () => {
  const { root } = tempHome();
  const file = join(root, "f");
  writeFileSync(file, "x", { mode: 0o600 });
  exitCode(() => ensurePrivateDir(file), ExitCode.permissions, /is not a directory/);
});

test("EACCES from stat, mkdir and read maps to exit 6 naming the path", { skip: isRoot && "root bypasses mode bits" }, () => {
  const { root, paths } = tempHome();
  const locked = join(root, "locked");
  mkdirSync(join(locked, "inner"), { recursive: true, mode: 0o700 });
  chmodSync(locked, 0o000);
  try {
    exitCode(() => assertPrivate(join(locked, "inner"), "dir"), ExitCode.permissions, /locked\/inner: permission denied \(EACCES\)/);
    exitCode(() => ensurePrivateDir(join(locked, "new")), ExitCode.permissions, /permission denied/);
  } finally {
    chmodSync(locked, 0o700);
  }
  ensurePrivateDir(paths.configDir);
  writeFileSync(paths.configFile, "{}", { mode: 0o200 });
  exitCode(() => loadConfig(paths), ExitCode.permissions, /config\.json: permission denied/);
});

test("the gate fails closed when process.getuid is unavailable", () => {
  const { root } = tempHome();
  const original = Object.getOwnPropertyDescriptor(process, "getuid");
  Object.defineProperty(process, "getuid", { value: undefined, configurable: true, writable: true });
  try {
    exitCode(() => assertPrivate(root, "dir"), ExitCode.permissions, /POSIX platform/);
  } finally {
    if (original) Object.defineProperty(process, "getuid", original);
  }
});

test("overrides are normalized so derived paths match the gated directory", () => {
  const paths = resolvePaths({ HOME: "/h", BANK_PULL_CONFIG_DIR: "/a/link/../c/", BANK_PULL_DATA_DIR: "/a/./d//" });
  assert.equal(paths.configDir, "/a/c");
  assert.equal(paths.configFile, "/a/c/config.json");
  assert.equal(paths.dataDir, "/a/d");
});
