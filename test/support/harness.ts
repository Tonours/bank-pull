import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after } from "node:test";
import type { Env, Paths } from "../../src/config.js";
import { main } from "../../src/cli.js";
import { startFakeApi, type FakeApi } from "./fake-api.js";
import { BANK } from "./fixtures.js";
import { testKeyPair } from "./keys.js";
import { tempHome } from "./tmp.js";

export const APP_ID = "00000000-0000-4000-8000-000000000000";
export const REDIRECT = "https://localhost/bank-pull/callback";

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Harness {
  readonly api: FakeApi;
  /** Env for the CLI: temp config/data dirs and the loopback fake as API URL. */
  readonly env: Env;
  readonly paths: Paths;
  readonly keyPath: string;
  run(args: readonly string[], options?: { paste?: (api: FakeApi) => string; now?: Date }): Promise<CliRun>;
  /** Single-value query on a read-only connection (`SELECT ... AS v`). */
  value(sql: string, ...params: (string | number)[]): unknown;
}

const keys = testKeyPair();

/** A private temp home with a config and key, plus a fake API; never the real config, never the network. */
export async function harness(): Promise<Harness> {
  const { root, env: base, paths } = tempHome();
  const api = await startFakeApi(APP_ID, keys.publicKeyPem);
  after(() => api.close());
  const keyDir = join(root, "keys");
  mkdirSync(keyDir, { mode: 0o700 });
  const keyPath = join(keyDir, "private.key");
  writeFileSync(keyPath, keys.privateKeyPem, { mode: 0o600 });
  mkdirSync(paths.configDir, { mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ appId: APP_ID, keyPath, redirectUrl: REDIRECT }), { mode: 0o600 });
  const env: Env = { ...base, BANK_PULL_API_URL: api.url };
  api.state.aspsps = [{ ...BANK, psu_types: ["personal"], maximum_consent_validity: 15_552_000, beta: true }];
  return {
    api,
    env,
    paths,
    keyPath,
    async run(args, options = {}) {
      let stdout = "";
      let stderr = "";
      const { now, paste } = options;
      const code = await main(args, {
        env,
        stdout: (t) => (stdout += t),
        stderr: (t) => (stderr += t),
        readLine: async () => {
          if (paste === undefined) throw new Error("unexpected prompt");
          return paste(api);
        },
        ...(now === undefined ? {} : { now: () => now }),
      });
      return { code, stdout, stderr };
    },
    value(sql, ...params) {
      const db = new DatabaseSync(paths.dbFile, { readOnly: true });
      try {
        return (db.prepare(sql).get(...params) as { v: unknown } | undefined)?.v;
      } finally {
        db.close();
      }
    },
  };
}

/** The redirect URL the bank would send back for the latest POST /auth. */
export function callback(api: FakeApi, code = "code-1"): string {
  return `${REDIRECT}?state=${encodeURIComponent(api.state.authStates.at(-1) ?? "")}&code=${code}`;
}
