import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CliError, ExitCode } from "./errors.js";

export type Env = Readonly<Record<string, string | undefined>>;

export interface Paths {
  readonly configDir: string;
  readonly configFile: string;
  readonly dataDir: string;
  readonly dbFile: string;
}

export interface Config {
  readonly appId: string;
  readonly keyPath: string;
  readonly redirectUrl: string;
}

/** XDG base dirs: empty or relative values are invalid and treated as unset. */
function xdgBase(value: string | undefined, fallback: string): string {
  return value !== undefined && isAbsolute(value) ? value : fallback;
}

/**
 * Explicit overrides must be absolute; an empty value counts as unset. The value is normalized
 * (no `..`, `.` or trailing `/`) so the gated path and every path derived from it are the same string.
 */
function override(env: Env, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value === "") return undefined;
  if (!isAbsolute(value)) throw new CliError(`${name} must be an absolute path (got "${value}")`, ExitCode.usage);
  return resolve(value);
}

export function resolvePaths(env: Env): Paths {
  const home = xdgBase(env["HOME"], homedir());
  if (!isAbsolute(home)) throw new CliError("cannot resolve an absolute home directory; set HOME", ExitCode.usage);
  const configDir = override(env, "BANK_PULL_CONFIG_DIR") ?? join(xdgBase(env["XDG_CONFIG_HOME"], join(home, ".config")), "bank-pull");
  const dataDir = override(env, "BANK_PULL_DATA_DIR") ?? join(xdgBase(env["XDG_DATA_HOME"], join(home, ".local", "share")), "bank-pull");
  return { configDir, configFile: join(configDir, "config.json"), dataDir, dbFile: join(dataDir, "bank-pull.db") };
}

function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

/** Maps EACCES/EPERM to a permissions CliError naming the path; rethrows anything else. */
export function rethrowDenied(error: unknown, path: string): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") {
    throw new CliError(
      `${path}: permission denied (${code}); make it and its parent directories owned and traversable by the current user`,
      ExitCode.permissions,
    );
  }
  throw error;
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new CliError("bank-pull needs a POSIX platform to check file ownership (process.getuid is unavailable)", ExitCode.permissions);
  }
  return process.getuid();
}

/**
 * Refuses a path that is a symbolic link, of the wrong type, not owned by the current user,
 * or accessible by group/others. Symlinks are refused so the check always applies to the real object.
 */
export function assertPrivate(path: string, kind: "file" | "dir"): void {
  const uid = currentUid();
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CliError(`${path} does not exist`);
    rethrowDenied(error, path);
  }
  if (stats.isSymbolicLink()) {
    throw new CliError(`${path} is a symbolic link; point bank-pull at the real ${kind === "dir" ? "directory" : "file"}`, ExitCode.permissions);
  }
  if (kind === "dir" ? !stats.isDirectory() : !stats.isFile()) {
    throw new CliError(`${path} is not a ${kind === "dir" ? "directory" : "regular file"}`, ExitCode.permissions);
  }
  if (stats.uid !== uid) {
    throw new CliError(`${path} is not owned by the current user`, ExitCode.permissions);
  }
  if ((stats.mode & 0o077) !== 0) {
    const fix = kind === "dir" ? "chmod 700" : "chmod 600";
    throw new CliError(
      `${path} is accessible by group or others (mode ${octal(stats.mode)}); fix: ${fix} ${path}`,
      ExitCode.permissions,
    );
  }
}

/** Creates a directory with mode 0700 when missing, then checks it. */
export function ensurePrivateDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOTDIR") rethrowDenied(error, path);
  }
  assertPrivate(path, "dir");
}

/** Creates an empty file with mode 0600 when missing, then checks it. */
export function ensurePrivateFile(path: string): void {
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") rethrowDenied(error, path);
  }
  assertPrivate(path, "file");
}

export function readPrivate(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    rethrowDenied(error, path);
  }
}

function requireString(value: Record<string, unknown>, key: string, file: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new CliError(`${file}: "${key}" must be a non-empty string`);
  }
  return field;
}

export function loadConfig(paths: Paths): Config {
  assertPrivate(paths.configDir, "dir");
  assertPrivate(paths.configFile, "file");
  const text = readPrivate(paths.configFile);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliError(`${paths.configFile}: invalid JSON (${(error as Error).message})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`${paths.configFile}: expected a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  const redirectUrl = requireString(record, "redirectUrl", paths.configFile);
  if (!URL.canParse(redirectUrl) || new URL(redirectUrl).protocol !== "https:") {
    throw new CliError(`${paths.configFile}: "redirectUrl" must be an https URL`);
  }
  return {
    appId: requireString(record, "appId", paths.configFile),
    keyPath: requireString(record, "keyPath", paths.configFile),
    redirectUrl,
  };
}
