import { spawn } from "node:child_process";

export interface ProcessResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
}

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

export function commandString(command: string, args: string[]): string {
  return [command, ...args].map((part) => (/^[a-zA-Z0-9_./:@=-]+$/.test(part) ? part : JSON.stringify(part))).join(" ");
}

export async function runProcess(command: string, args: string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString("utf8");
      return Buffer.byteLength(next) > MAX_CAPTURE_BYTES ? next.slice(-MAX_CAPTURE_BYTES) : next;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", reject);
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
        }, options.timeoutMs)
      : undefined;
    timer?.unref();
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
    child.on("close", (exitCode) => {
      if (timer) clearTimeout(timer);
      resolve({ command: commandString(command, args), exitCode, stdout, stderr, timedOut });
    });
  });
}

export async function runShell(command: string, options: RunProcessOptions = {}): Promise<ProcessResult> {
  return runProcess("/bin/zsh", ["-lc", command], options);
}

export function assertSuccess(result: ProcessResult): void {
  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${result.command} failed${result.timedOut ? " (timed out)" : ""} with exit ${result.exitCode}\n${output}`);
  }
}
