#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { assertPrivate, ensurePrivateDir, loadConfig, readPrivateKey, resolvePaths, type Config, type Env, type Paths } from "./config.js";
import { openReadWrite } from "./db.js";
import { ApiError, DEFAULT_API_URL, EnableBankingClient } from "./enable-banking.js";
import { CliError, ExitCode } from "./errors.js";
import { loadSigningKey } from "./jwt.js";
import { acquireLock, lockedWrite, releaseLock } from "./lock.js";
import { backfillAccount, mapApiError, persistSession, type AccountResult, type SyncContext } from "./sync.js";

export interface Io {
  readonly env: Env;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Reads one line typed or pasted by the user. */
  readonly readLine: () => Promise<string>;
  readonly now?: () => Date;
}

const USAGE = `Usage: bank-pull <command> [options]

Commands:
  init --app-id <id> --key <path> --redirect-url <https-url> [--force]
                         write the config file (the key stays where it is)
  banks --country <CC> [--json]
                         list banks available through Enable Banking
  auth --bank <name> --country <CC> [--json]
                         open a bank consent, paste the redirect URL, then backfill
  revoke [--session <id>]
                         close the latest consent at the bank and forget it locally

Exit codes: 0 ok, 1 failure, 2 usage, 3 consent expired or closed,
4 bank rate limit, 5 another sync running, 6 unsafe file permissions.
`;

const DAY_SECONDS = 86_400;
const MAX_CONSENT_DAYS = 180;
const COUNTRY = /^[A-Z]{2}$/;

function parse<T extends NonNullable<ParseArgsConfig["options"]>>(args: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals: false }).values;
  } catch (error) {
    throw new CliError((error as Error).message, ExitCode.usage);
  }
}

function required(value: string | boolean | undefined, flag: string): string {
  if (typeof value !== "string" || value.length === 0) throw new CliError(`missing --${flag}`, ExitCode.usage);
  return value;
}

function country(value: string | boolean | undefined): string {
  const code = required(value, "country").toUpperCase();
  if (!COUNTRY.test(code)) throw new CliError(`--country must be a two-letter country code (got "${code}")`, ExitCode.usage);
  return code;
}

/** Loads the key through the permission gate; nothing is sent before this succeeds. The API URL override exists for the test fake. */
function client(config: Config, env: Env): EnableBankingClient {
  const privateKeyPem = readPrivateKey(config.keyPath);
  const override = env["BANK_PULL_API_URL"];
  try {
    return new EnableBankingClient({ appId: config.appId, privateKeyPem, baseUrl: override === undefined || override === "" ? DEFAULT_API_URL : override });
  } catch (error) {
    throw new CliError((error as Error).message);
  }
}

/** True when both paths name one existing inode (catches symlinked or hard-linked aliases). */
function sameFile(a: string, b: string): boolean {
  const left = statSync(a, { throwIfNoEntry: false });
  const right = statSync(b, { throwIfNoEntry: false });
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

function init(args: readonly string[], paths: Paths, io: Io): number {
  const values = parse(args, {
    "app-id": { type: "string" },
    key: { type: "string" },
    "redirect-url": { type: "string" },
    force: { type: "boolean" },
  });
  const appId = required(values["app-id"], "app-id");
  const keyPath = resolve(required(values.key, "key"));
  const redirectUrl = required(values["redirect-url"], "redirect-url");
  if (!URL.canParse(redirectUrl) || new URL(redirectUrl).protocol !== "https:") {
    throw new CliError("--redirect-url must be an https URL (Enable Banking only redirects to https)", ExitCode.usage);
  }
  if (keyPath === paths.configFile || sameFile(keyPath, paths.configFile)) {
    throw new CliError("--key must not be the config file itself", ExitCode.usage);
  }
  try {
    loadSigningKey(readPrivateKey(keyPath));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`${keyPath}: ${(error as Error).message}`);
  }
  ensurePrivateDir(paths.configDir);
  if (values.force === true) rmSync(paths.configFile, { force: true });
  try {
    writeFileSync(paths.configFile, `${JSON.stringify({ appId, keyPath, redirectUrl }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CliError(`${paths.configFile} exists; pass --force to overwrite`);
    throw error;
  }
  assertPrivate(paths.configFile, "file");
  openReadWrite(paths).close();
  io.stdout(`wrote ${paths.configFile}\ndatabase ready at ${paths.dbFile}\n`);
  return 0;
}

async function banks(args: readonly string[], paths: Paths, io: Io): Promise<number> {
  const values = parse(args, { country: { type: "string" }, json: { type: "boolean" } });
  const list = await client(loadConfig(paths), io.env).listAspsps(country(values.country), "personal");
  if (values.json === true) {
    io.stdout(`${JSON.stringify(list, null, 2)}\n`);
  } else {
    for (const bank of list) io.stdout(`${bank.name}${bank.beta === true ? " (beta)" : ""}\n`);
  }
  return 0;
}

/** Validates the pasted redirect URL against the configured callback and the expected state; returns the code. */
export function parseCallback(pasted: string, redirectUrl: string, state: string): string {
  const text = pasted.trim();
  if (!URL.canParse(text)) throw new CliError("the pasted text is not a URL; paste the full address of the redirect page");
  const url = new URL(text);
  const expected = new URL(redirectUrl);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new CliError(`the pasted URL does not start with the configured redirect URL ${expected.origin}${expected.pathname}`);
  }
  const error = url.searchParams.get("error");
  if (error !== null) {
    const description = url.searchParams.get("error_description");
    throw new CliError(`the bank returned an error: ${error}${description === null ? "" : ` (${description})`}`);
  }
  if (url.searchParams.get("state") !== state) {
    throw new CliError("the pasted URL belongs to another consent attempt (state mismatch); run auth again");
  }
  const code = url.searchParams.get("code");
  if (code === null || code === "") throw new CliError("the pasted URL carries no authorization code");
  return code;
}

/** Consent length: the bank's maximum, capped at 180 days, rounded down to whole days (to whole seconds under one day). */
export function consentValidUntil(now: Date, maximumSeconds: unknown): string {
  const cap = MAX_CONSENT_DAYS * DAY_SECONDS;
  const seconds = typeof maximumSeconds === "number" && Number.isFinite(maximumSeconds) && maximumSeconds > 0 ? Math.min(maximumSeconds, cap) : cap;
  const whole = seconds >= DAY_SECONDS ? Math.floor(seconds / DAY_SECONDS) * DAY_SECONDS : Math.floor(seconds);
  return new Date(now.getTime() + whole * 1000).toISOString();
}

function summarize(results: readonly AccountResult[], io: Io): void {
  for (const r of results) {
    const undated = r.skipped_undated > 0 ? `, ${r.skipped_undated} undated skipped` : "";
    io.stdout(`${r.name}: backfill, ${r.received_book} booked received, ${r.inserted} new, ${r.pending} pending${undated}\n`);
    for (const gap of r.gaps_added) io.stdout(`  warning: history gap recorded (${gap.kind}); older history may be shorter than the bank's window\n`);
  }
}

async function auth(args: readonly string[], paths: Paths, io: Io): Promise<number> {
  const values = parse(args, { bank: { type: "string" }, country: { type: "string" }, json: { type: "boolean" } });
  const bankName = required(values.bank, "bank");
  const countryCode = country(values.country);
  const config = loadConfig(paths);
  const api = client(config, io.env);
  const db = openReadWrite(paths);
  try {
    const now = io.now?.() ?? new Date();
    const aspsps = await api.listAspsps(countryCode, "personal");
    const aspsp = aspsps.find((a) => a.name === bankName);
    if (aspsp === undefined) {
      const names = aspsps.map((a) => a.name).filter((n) => n.toLowerCase().includes(bankName.toLowerCase()));
      throw new CliError(`no bank named "${bankName}" in ${countryCode}${names.length > 0 ? `; did you mean: ${names.join(", ")}` : ""}`);
    }
    const state = randomUUID();
    const { url } = await api.startAuth({
      aspsp: { name: aspsp.name, country: countryCode },
      validUntil: consentValidUntil(now, aspsp.maximum_consent_validity),
      state,
      redirectUrl: config.redirectUrl,
    });
    io.stderr(
      `Open this URL in a browser and approve the consent:\n\n  ${url}\n\n` +
        `The browser then lands on ${config.redirectUrl} (the page does not load, that is expected).\n` +
        "Copy the full address from the address bar and paste it here:\n",
    );
    const code = parseCallback(await io.readLine(), config.redirectUrl, state);
    const token = acquireLock(db, now);
    try {
      const session = await api.createSession(code);
      const ctx: SyncContext = { db, client: api, lockToken: token, now };
      const accounts = persistSession(ctx, session);
      io.stderr(`consent stored (session ${session.session_id}, ${accounts.length} account(s), valid until ${session.access.valid_until})\n`);
      const results: AccountResult[] = [];
      for (const acc of accounts) results.push(await backfillAccount(ctx, acc.id, acc.uid, acc.gaps));
      if (values.json === true) io.stdout(`${JSON.stringify({ session_id: session.session_id, accounts: results }, null, 2)}\n`);
      else summarize(results, io);
      return 0;
    } finally {
      releaseLock(db, token);
    }
  } finally {
    db.close();
  }
}

async function revoke(args: readonly string[], paths: Paths, io: Io): Promise<number> {
  const values = parse(args, { session: { type: "string" } });
  const api = client(loadConfig(paths), io.env);
  const db = openReadWrite(paths);
  let token: string | undefined;
  try {
    token = acquireLock(db, io.now?.() ?? new Date());
    const row = (
      typeof values.session === "string"
        ? db.prepare("SELECT id FROM sessions WHERE id = ?").get(values.session)
        : db.prepare("SELECT id FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT 1").get()
    ) as { id: string } | undefined;
    if (row === undefined) throw new CliError("no stored consent to revoke");
    let note = "closed at the bank";
    try {
      await api.deleteSession(row.id);
    } catch (error) {
      if (!(error instanceof ApiError && (error.code === "EXPIRED_SESSION" || error.code === "CLOSED_SESSION"))) throw error;
      note = `already ${error.code === "EXPIRED_SESSION" ? "expired" : "closed"} at the bank`;
    }
    lockedWrite(db, token, () => db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id));
    io.stdout(`revoked session ${row.id} (${note}); synced transactions stay in the database\n`);
    return 0;
  } finally {
    if (token !== undefined) releaseLock(db, token);
    db.close();
  }
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.stdout(USAGE);
    return 0;
  }
  try {
    const paths = resolvePaths(io.env);
    switch (command) {
      case "init":
        return init(rest, paths, io);
      case "banks":
        return await banks(rest, paths, io);
      case "auth":
        return await auth(rest, paths, io);
      case "revoke":
        return await revoke(rest, paths, io);
      default:
        io.stderr(`bank-pull: unknown command "${command}"\n${USAGE}`);
        return ExitCode.usage;
    }
  } catch (error) {
    const mapped = mapApiError(error);
    if (mapped instanceof CliError) {
      io.stderr(`bank-pull: ${mapped.message}\n`);
      return mapped.exitCode;
    }
    io.stderr(`bank-pull: ${(mapped as Error).stack ?? String(mapped)}\n`);
    return ExitCode.failure;
  }
}

function readStdinLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin });
  return new Promise((resolveLine, reject) => {
    rl.once("line", (line) => {
      resolveLine(line);
      rl.close();
    });
    rl.once("close", () => reject(new CliError("no input received on stdin")));
  });
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2), {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readLine: readStdinLine,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`bank-pull: ${String(error)}\n`);
      process.exitCode = ExitCode.failure;
    },
  );
}
