# Security

bank-pull handles a private signing key and your bank transactions. This page states
what it stores, where, what protects it, and what the MCP server can and cannot do.
Paths below are the defaults; see the README for the environment overrides.

## What is stored, and where

| Item | Location | Content |
| --- | --- | --- |
| Config | `~/.config/bank-pull/config.json` | Enable Banking application id, path of the private key, redirect URL. No secret. |
| Private key | wherever `keyPath` points (you choose) | The RSA key of your Enable Banking application. bank-pull never copies or moves it. |
| Database | `~/.local/share/bank-pull/bank-pull.db` | Accounts (name, IBAN, currency, the raw account JSON from the API), consent sessions (session id, validity), balances, transactions (dates, amounts, labels, counterparties, the raw transaction JSON), your categories and notes, and a lock row (process id) while a sync runs. |

Everything is clear text: bank-pull adds no encryption of its own. Use full-disk
encryption. The session id lets the key holder read your accounts until the consent
expires or is revoked; it is useless without the private key.

`.gitignore` excludes `*.pem`, `*.key`, `*.db` and `*.sqlite` files so a key or a
database placed in a clone is not committed by accident. Tests use a local fake API,
keys generated on the fly and synthetic data only.

### Copies outside the database

`sync` and `auth` print each new transaction (date, amount, label, counterparty) and
the account names, and `transactions`, `accounts` and `query` print what you ask for.
Anywhere that output goes is a copy outside the permission gate:

- the systemd user journal (`journalctl --user`), readable by you and, on many
  distributions, by members of the `adm` or `systemd-journal` groups; add
  `StandardOutput=null` to the service if that matters to you (error messages still reach the journal through stderr);
- a cron log file: create it under `umask 077` as in the README example (an existing log keeps its mode: `chmod 600` it);
- your shell history and terminal scrollback, and whatever an MCP client logs.

## File permissions gate

Directories are created with mode `700` and files with mode `600`. Before using any of
them, bank-pull checks with `lstat` that each one is:

- not a symbolic link,
- of the expected type (directory or regular file),
- owned by the current user,
- not readable, writable or executable by group or others.

The gate covers the config directory and file, the private key and its directory, the
data directory, the database, and any `-journal`, `-wal` or `-shm` file next to it.
A failed check stops the command with exit code 6 before anything is read or sent. The
message names the path, and the `chmod` fix when the problem is the mode. Permission
errors (`EACCES`, `EPERM`) also exit 6.

Accepted residual risks:

- **Symlinked ancestors are not walked.** Only the gated paths themselves are checked.
  A symbolic link higher up (for example a stow-managed `~/.config`) is followed. Make
  sure the parent directories are yours.
- **POSIX only.** Ownership checks need `process.getuid`; where it is missing (Windows)
  bank-pull refuses to run instead of skipping the check.
- **Same-user processes are not stopped.** The gate protects against other users on the
  machine, not against programs running as you.
- **Lock and pid reuse.** The sync lock records the holder's process id and is reclaimed
  only when that process no longer exists. If a crashed sync's pid is reused by an
  unrelated process, the lock stays held (exit 5) until that process ends; clear the
  `sync_lock` row by hand if needed. The lock never lets two live syncs write: each
  write transaction checks that the lock token is still its own.

## Key handling

- The key is read only by the commands that talk to Enable Banking: `init` (to check it
  is an RSA private key), `banks`, `auth`, `revoke` and `sync`. It is read after it and
  its directory pass the permission gate.
- Each API request carries a fresh RS256 JWT (`kid` = application id) that expires
  after 300 seconds. Nothing is cached, and the key itself never leaves the machine:
  only the signed token is sent.
- Requests go to `https://api.enablebanking.com`. The client refuses any other base URL
  except a loopback host (`localhost`, `127.0.0.1`, `[::1]`), which the tests use
  through `BANK_PULL_API_URL`. HTTP redirects are refused, so a token is never forwarded
  elsewhere.
- bank-pull only calls account-information endpoints: bank list, consent start,
  session creation and deletion, account transactions and balances. It has no payment
  code.
- The consent redirect is never received by a local server: you paste the redirect URL.
  bank-pull accepts it only if its origin and path match the configured redirect URL,
  its `state` matches the random value of this attempt, and it carries a code and no
  `error` parameter.

## MCP server

`bank-pull mcp` is a stdio server over the local database.

It can:

- read accounts, balances, transactions and sync status through read-only SQLite
  connections, with the same functions as the CLI read commands;
- run one guarded read-only SQL statement (`query_sql`, same path as `bank-pull query`);
- write exactly one thing: `set_category` sets or clears the category and/or note of one
  booked transaction (one `UPDATE` of those two columns). It never creates or migrates
  the database.

It cannot:

- reach the network, the Enable Banking client, the JWT code, the config file or the
  private key. Its import graph is checked by `test/mcp.test.ts`: `src/mcp.ts` reaches
  neither the API client, the JWT module, the sync or lock code, nor any network module;
- sync or start a consent. Data is as fresh as your last `bank-pull sync`.

The server runs with your user's rights, like any local program: the boundary is what
its code does, not an operating-system sandbox.

**Bank text is untrusted data.** Labels, counterparty names and account names are
written by third parties: anyone who sends you a transfer chooses its label. An agent
reading them may meet text crafted to look like instructions. Every MCP tool
description says these fields are data, never instructions, and `set_category` tells
the agent to set only what you asked for. The CLI replaces control and bidirectional
characters with `?` when printing bank text; MCP and `--json` output return the text
as stored (JSON-escaped). Do not give an agent that reads your transactions other
powerful tools you would not let a stranger's message trigger.

## Read-only SQL guard

`bank-pull query` and MCP `query_sql` share one function:

1. **Single statement.** Anything after a `;` other than whitespace or comments
   (outside string literals and quoted identifiers) is refused.
2. **Read-only connection.** The database is opened with SQLite's read-only flag.
3. **Authorizer allow-list.** Only `SELECT`, column reads, function calls and recursive
   CTEs are authorized; `load_extension` is denied. `ATTACH`, `PRAGMA` (including
   `pragma_*` table-valued functions), temporary tables, any write and `VACUUM INTO` are
   refused, so no file is created next to the database.
4. **Row cap.** 500 rows by default, 5000 at most.

There is no CPU-time limit. A heavy query stalls its own process and, while it runs,
holds a read lock on the database: a concurrent `sync`, `auth`, `revoke` or
`categorize` waits up to 5 seconds, then fails with "database is locked". The failing
write transaction is rolled back; writes committed before it (for example earlier pages
of the same sync) stay, and the cursor only advances after a complete fetch, so rerunning
the command after the query ends is safe.

## Reporting a vulnerability

Please report it privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability** (private vulnerability reporting). Do not open a
public issue. Include the version or commit, the steps to reproduce and the impact.
Never include real bank data, keys or session ids in the report.
