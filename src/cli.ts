#!/usr/bin/env node
const USAGE = `Usage: bank-pull <command> [options]

Commands are added slice by slice; run with --help to list them.
`;

export function main(argv: readonly string[]): number {
  const [command] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  process.stderr.write(`bank-pull: unknown command "${command}"\n${USAGE}`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
