# bank-pull

bank-pull copies your own bank transactions into a SQLite file on your machine, so
you and your agents can query them offline, spending per category, a merchant's
history, the balance of every account. It reads them through
[Enable Banking](https://enablebanking.com), the PSD2 account information API, and
ships a CLI and an MCP server.

- **Read-only towards the bank.** It calls account information endpoints only, never
  payments.
- **Free for personal use.** An Enable Banking application in restricted mode sees
  only the accounts you link to it yourself.
- **Local.** Transactions live in one SQLite file. The MCP server reads that file and
  never touches the network or your key.

See [SECURITY.md](SECURITY.md) for what is stored, where, and what the MCP server can do.

## Prerequisites

- Node.js 24.10 or newer (`node:sqlite` with `DatabaseSync#setAuthorizer`)
- Linux or macOS. bank-pull checks file ownership and modes with POSIX calls and
  refuses to run where they are missing, so Windows is not supported.
- An Enable Banking account

## Set up an Enable Banking application

You do this once, in the Enable Banking control panel. Labels in the panel may change,
the steps stay the same.

1. Sign up at [enablebanking.com](https://enablebanking.com) and open the control panel.
2. Create a key pair for the application. Either let the control panel generate it in
   your browser and save the private key it gives you, or generate one yourself and
   upload the certificate:

   ```sh
   mkdir -m 700 -p ~/.config/bank-pull
   cd ~/.config/bank-pull
   openssl req -new -x509 -newkey rsa:4096 -nodes -days 3650 -subj "/CN=bank-pull" \
     -keyout private.key -out public.crt
   chmod 600 private.key
   ```

   The key is an RSA private key in PEM format, because bank-pull signs with RS256.
   bank-pull reads it only from a directory at mode `700`, with the file at mode `600`.
3. Register a new application in the **production** environment, with the account
   information service and this redirect URL:

   ```
   https://localhost/bank-pull/callback
   ```

   Enable Banking only redirects to `https://` addresses. Nothing listens there: after
   the consent, your browser lands on that address, the page does not load, and you
   copy the URL from the address bar.
4. Activate the application in restricted mode with **Activate by linking accounts**,
   and link every account you want bank-pull to see, bank by bank. The API removes
   the accounts you did not link, so a consent on an unlinked bank returns no account.
   Restricted mode is limited to your personal accounts (see the Enable Banking terms).
5. Copy the application id shown in the control panel.

## Install from a clone

bank-pull is not published to npm. You build it from a clone:

```sh
git clone https://github.com/Tonours/bank-pull.git
cd bank-pull
npm ci
npm run build
chmod +x dist/cli.js
mkdir -p ~/.local/bin
ln -s "$PWD/dist/cli.js" ~/.local/bin/bank-pull   # ~/.local/bin must be on your PATH
bank-pull --help
```

Without the link, run `node /path/to/bank-pull/dist/cli.js` wherever this README says
`bank-pull`. To update, run `git pull && npm ci && npm run build`.

## Connect your first bank

```sh
# Write the config file and create the database. The key is not copied.
bank-pull init --app-id <application-id> --key ~/.config/bank-pull/private.key \
  --redirect-url https://localhost/bank-pull/callback

# Find the exact bank name for your country (two-letter code).
bank-pull banks --country FR

# Open a consent, approve it at your bank, paste the redirect URL back.
bank-pull auth --bank "<bank name as listed>" --country FR
```

`auth` prints a bank URL. Open it, log in at your bank and approve. The browser then
lands on `https://localhost/bank-pull/callback?...` and shows an error page. Copy the
full address from the address bar and paste it into the terminal. bank-pull checks
that the pasted URL matches the configured redirect URL and this consent attempt
(`state`), refuses it when the bank returned an error or no code, then stores the
consent and backfills the longest history the bank serves.

> [!WARNING]
> Paste the redirect URL right after approving. Banks usually serve the full history
> only for a short time after the consent, about one hour according to Enable Banking,
> then often 90 days only. History you miss then cannot be fetched later.

## What you have now

A local database with every linked account of that bank, its balances and the longest
history the bank agreed to serve. From then on:

```sh
bank-pull sync      # fetch new transactions and balances
bank-pull status    # offline: last sync, consent expiry, warnings
```

## Add more banks

Each bank needs its own consent. Link that bank's accounts in the control panel first,
then run one `auth` per bank:

```sh
bank-pull auth --bank "Boursorama Banque" --country FR
bank-pull auth --bank "PayPal" --country FR
```

`sync` then covers every account of every bank with a valid consent. A failing
account, an expired consent, a rate limit, a bank error, does not stop the others. It
is reported on stderr and in the `failures` array of `sync --json`, and the exit code
is that failure's code, or 1 when failures have different codes. `revoke --bank <name>`
closes the latest consent of one bank only.

## Troubleshooting

**`consent stored (... 0 account(s) ...)`.** The bank's accounts are not linked to
your application. Link them in the control panel, then run
`bank-pull revoke --bank "<name>"` and `bank-pull auth` again. `auth` prints a warning
in this case.

**`no bank named ...`.** Use the name exactly as `bank-pull banks` prints it. A
trailing `(beta)` is accepted.

**Exit 4 on `sync`.** The bank's rate limit is reached. Rows already fetched are kept,
try again in about 6 hours.

**Exit 6.** A file or directory has unsafe permissions, the wrong owner, or is a
symbolic link. The message names the path, and the `chmod` fix for a mode problem.

## Commands

Every command except `init`, `banks`, `auth`, `revoke` and `sync` works offline and
never reads the config file or the key. `--json` prints machine-readable output.

| Command | What it does |
| --- | --- |
| `init --app-id <id> --key <path> --redirect-url <https-url> [--force]` | Validates the key, writes `config.json` (mode `600`), creates the database. `--force` overwrites an existing config. |
| `banks --country <CC> [--json]` | Lists the banks available for personal accounts in that country, with `(beta)` when Enable Banking flags them. |
| `auth --bank <name> --country <CC> [--json]` | Opens a consent (the bank's maximum, at most 180 days), takes the pasted redirect URL, stores the session and backfills every account. |
| `sync [--json]` | Fetches new transactions and balances for every account with a valid consent. One failing account does not stop the others. |
| `status [--json]` | Per account, synced-through date, booked and pending counts, consent expiry, history gaps and warnings. |
| `accounts [--json]` | Accounts with their latest balances per type and currency. |
| `transactions [filters] [--json]` | Transactions, newest first. Filters: `--account <id>`, `--from`/`--to YYYY-MM-DD`, `--text <s>` (label, counterparty or note), `--category <c>` (`""` = uncategorized), `--status BOOK\|PDNG\|HOLD\|SCHD\|OTHR\|pending`, `--min-amount`/`--max-amount <n>` (signed decimal, write negatives as `--max-amount=-12.30`), `--limit <n>` (default 100, max 5000). |
| `query "<SELECT ...>" [--max-rows <n>] [--json]` | Runs one read-only SQL statement on the database (default 500 rows, max 5000). Writes, `ATTACH`, `PRAGMA`, `VACUUM` and a second statement are refused. |
| `categorize --id <n> [--category <c>] [--note <text>] [--json]` | Sets the category and/or note of one booked transaction. An empty value clears it, an omitted one is kept. |
| `revoke [--session <id> \| --bank <name>]` | Closes the latest consent, the given one, or the latest of that bank, at the bank and forgets it locally. Synced transactions stay. |
| `mcp` | Starts the stdio MCP server. |

Amounts are signed decimal strings in the transaction currency, debits negative. JSON
output also carries `amount_minor`, the exact integer in minor units.

## Examples

```sh
bank-pull transactions --from 2026-10-01 --to 2026-10-31 --text grocery
bank-pull query "SELECT currency, category, sum(amount_minor) AS total_minor FROM transactions
  WHERE status = 'BOOK' AND booking_date >= '2026-01-01' GROUP BY currency, category ORDER BY total_minor"
bank-pull categorize --id 42 --category groceries --note "weekly shop"
```

Tables for `query` are `accounts`, `balances`, `transactions`, `sessions` and
`session_accounts`. In `transactions`, `amount_minor` is a signed integer in minor
units of `currency`, so you sum per currency, and `remittance` is the label.

## MCP server

`bank-pull mcp` serves six tools over stdio, `list_accounts`, `get_balances`,
`search_transactions`, `query_sql`, `sync_status` and `set_category`. `set_category`
is the only write, the category and note of one booked transaction. The server reads
the local database only: data is as fresh as your last `bank-pull sync`, and the
server cannot sync.

The client configuration is in [examples/mcp.json](examples/mcp.json). If your MCP
client does not inherit your shell `PATH`, use the absolute path of the `bank-pull`
link, or `node` plus the path to `dist/cli.js`. With Claude Code:

```sh
claude mcp add bank-pull -- bank-pull mcp
```

> [!WARNING]
> Transaction labels and counterparty names are written by whoever sends you money or
> charges you. The tool descriptions tell the agent to treat them as data, but don't
> give an agent that reads your transactions tools it should not use on a stranger's
> instructions.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | OK |
| 1 | Failure, message on stderr |
| 2 | Usage error, a bad flag or value, a refused query |
| 3 | Consent expired or closed, run `bank-pull auth` again |
| 4 | Bank rate limit reached, rows already fetched are kept, try again in about 6 hours |
| 5 | Another `sync`, `auth` or `revoke` is running |
| 6 | Unsafe file permissions, ownership, symbolic link or access denied. The message names the path, and the `chmod` fix for a mode problem. |

## Files and environment

| Path | Content | Mode |
| --- | --- | --- |
| `~/.config/bank-pull/` | Config directory | `700` |
| `~/.config/bank-pull/config.json` | `appId`, `keyPath`, `redirectUrl` | `600` |
| Your key (`keyPath`) | RSA private key, never copied | `600`, in a `700` directory |
| `~/.local/share/bank-pull/` | Data directory | `700` |
| `~/.local/share/bank-pull/bank-pull.db` | SQLite database | `600` |

bank-pull creates its directories and files with these modes. It refuses to run when
one of them, or a `-journal`, `-wal` or `-shm` file next to the database, is a symbolic
link, owned by another user, or open to group or others.

| Variable | Effect |
| --- | --- |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME` | Standard base directories, used only when absolute. |
| `BANK_PULL_CONFIG_DIR` | Config directory instead of `$XDG_CONFIG_HOME/bank-pull`. Must be absolute. |
| `BANK_PULL_DATA_DIR` | Data directory instead of `$XDG_DATA_HOME/bank-pull`. Must be absolute. |
| `BANK_PULL_API_URL` | Test only, the API base URL (unset or empty = `https://api.enablebanking.com`). Any other value must be a loopback host, `localhost`, `127.0.0.1` or `[::1]`, else the command fails. |

## Scheduling

Banks often allow only 4 background fetches per account per day, and they count them
differently. Per account, a sync makes one request per page of transactions, a quiet
account usually fits in one, plus one for balances. Start with one scheduled sync a
day, and move to two only if your bank does not rate-limit you. A rate-limited sync
exits 4 and loses nothing, retry about 6 hours later.

The systemd user units in [examples/systemd/](examples/systemd/) run once a day at 07:00:

```sh
mkdir -p ~/.config/systemd/user
cp examples/systemd/bank-pull-sync.service examples/systemd/bank-pull-sync.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now bank-pull-sync.timer
systemctl --user list-timers bank-pull-sync.timer
journalctl --user -u bank-pull-sync.service   # last runs
```

The service runs with `PATH=%h/.local/bin:/usr/local/bin:/usr/bin`. If `command -v node`
points elsewhere, nvm, fnm, asdf, add that directory to the `Environment=PATH=` line,
or a scheduled run exits 127. A failed run, an expired consent or a rate limit, shows
as a failed unit with the exit code.

> [!WARNING]
> `sync` prints each new transaction, its date, amount and label, so its log is a copy
> of bank data. See [SECURITY.md](SECURITY.md#copies-outside-the-database).

With cron instead, `node` must be on cron's `PATH`, and `umask 077` keeps the log private:

```
0 7 * * * umask 077; mkdir -p "$HOME/.local/state" && "$HOME/.local/bin/bank-pull" sync >> "$HOME/.local/state/bank-pull-sync.log" 2>&1
```

## Limitations

- **Consent lasts at most 180 days**, less if the bank says so. `sync` and `status` warn
  14 days before expiry. Run `bank-pull auth` again then: accounts are matched across
  consents and history is kept. After expiry, `sync` exits 3.
- **Background fetches are limited**, often 4 per day per account. A rate-limited `sync`
  exits 4 with no retry, and rows already fetched stay stored.
- **History depth is the bank's choice.** The first `auth` backfill asks for the longest
  period the bank serves, from about 90 days to more than a year depending on the bank.
  Nothing older can be fetched. Later syncs fetch from 10 days before the last synced
  date. After more than 80 days without a sync, the bank may no longer serve the
  missing days: bank-pull asks for what it can get and records a history gap, shown by
  `status`.
- **Pending transactions are a snapshot.** Non-booked rows (`PDNG`, `HOLD`, ...) are
  replaced on every complete sync, and categories apply to booked rows only. Booked
  rows with no date and no reference are skipped and counted in `status`.
- **Restricted mode** sees only the accounts you linked in the Enable Banking control
  panel, and is meant for personal use. Enable Banking may change this offer.
- **Clear-text storage.** bank-pull does not encrypt the database, so use full-disk
  encryption.

## Development

```sh
npm ci
npm run typecheck
npm run build
npm test        # uses a local fake Enable Banking API and synthetic data only
```

## License

[MIT](LICENSE)
