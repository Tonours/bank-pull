import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { assertPrivate, readPrivate } from "./config.js";
import { CliError, ExitCode } from "./errors.js";

/** Enable Banking accepts up to 86400 s; tokens are minted per request, so 300 s is plenty. */
export const JWT_TTL_SECONDS = 300;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/** Parses the PEM once and refuses anything that is not an RSA private key (RS256 only). */
export function loadSigningKey(privateKeyPem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new Error("private key is not a valid PEM private key");
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error(`private key must be RSA for RS256 (got ${key.asymmetricKeyType ?? "unknown"})`);
  }
  return key;
}

/** Mints a short-lived RS256 JWT for the Enable Banking API; nothing is cached. */
export function signJwt(appId: string, key: KeyObject, nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: appId }));
  const payload = base64url(
    JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: nowSeconds, exp: nowSeconds + JWT_TTL_SECONDS }),
  );
  const input = `${header}.${payload}`;
  return `${input}.${base64url(sign("sha256", Buffer.from(input), key))}`;
}

/** Reads the private key only after its file and directory pass the permission gate. */
export function readPrivateKey(keyPath: string): string {
  if (!isAbsolute(keyPath)) throw new CliError(`keyPath must be an absolute path (got "${keyPath}")`, ExitCode.usage);
  const path = resolve(keyPath);
  assertPrivate(dirname(path), "dir");
  assertPrivate(path, "file");
  return readPrivate(path);
}
