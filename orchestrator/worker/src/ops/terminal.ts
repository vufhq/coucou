// What a command the computer refuses is reported as. The commands themselves
// run in the computer's runner (ops/shell.ts), never in the worker: terminal.run,
// which started a program here as the worker's own user, is retired.

export class CommandError extends Error {}
