/** Statements the guarded read path must refuse; shared by the CLI `query` and MCP `query_sql` tests. */
export function refusedSql(dataDir: string): string[] {
  return [
    "DELETE FROM transactions",
    "UPDATE transactions SET category = 'x'",
    "INSERT INTO sync_lock VALUES (1, 1, 't', 'now')",
    "ATTACH DATABASE ':memory:' AS m",
    `ATTACH DATABASE '${dataDir}/evil.db' AS m`,
    `VACUUM INTO '${dataDir}/copy.db'`,
    "VACUUM",
    "CREATE TEMP TABLE t (x)",
    "CREATE TEMP VIEW v AS SELECT 1",
    "PRAGMA writable_schema = 1",
    "PRAGMA user_version = 99",
    "PRAGMA table_info(transactions)",
    "SELECT * FROM pragma_table_info('transactions')",
    "SELECT load_extension('/tmp/x')",
    "SELECT 1; DELETE FROM transactions",
    "SELECT 1;DELETE FROM transactions",
    "SELECT 1; /* c */ ATTACH ':memory:' AS m",
    "SELECT ';'; SELECT 2",
    "SELECT \"a;\"\"\" FROM (SELECT 1 AS \"a;\"\"\"); SELECT 2",
    "SELECT [x;] FROM (SELECT 1 AS [x;]); SELECT 2",
    "BEGIN",
    "   ",
    "-- only a comment",
  ];
}
