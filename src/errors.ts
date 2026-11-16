export const ExitCode = {
  failure: 1,
  usage: 2,
  consent: 3,
  rateLimit: 4,
  locked: 5,
  permissions: 6,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class CliError extends Error {
  readonly exitCode: ExitCodeValue;

  constructor(message: string, exitCode: ExitCodeValue = ExitCode.failure) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}
