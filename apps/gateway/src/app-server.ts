import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { dlopen } from "bun:ffi";

export interface ProcessIdentity {
  pid: number;
  owner: string;
  startedAt: string;
  executable: string;
  args: string[];
}

export type AppServerScan =
  | { status: "ok"; processes: ProcessIdentity[] }
  | { status: "unknown"; error: string };

export interface AppServerStopResult {
  pid: number;
  status: "stopped" | "surviving" | "failed";
}

interface StopRuntime {
  listProcesses: () => ProcessIdentity[];
  terminate: (pid: number) => void;
  wait: (milliseconds: number) => Promise<void>;
}

const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env",
  "-m", "--model", "--local-provider", "-p", "--profile", "-s", "--sandbox",
  "-C", "--cd", "--add-dir", "-a", "--ask-for-approval",
]);

const GLOBAL_FLAGS = new Set([
  "--strict-config", "--oss", "--approve-for-me",
  "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust",
  "--search", "--no-alt-screen", "-h", "--help", "-V", "--version",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function executableName(executable: string): string {
  return executable.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() || "";
}

function isCodexExecutable(executable: string): boolean {
  const name = executableName(executable);
  return name === "codex"
    || name === "codex.exe"
    || name === "codex.cmd"
    || /^codex-(?:aarch64|x86_64)-(?:apple-darwin|unknown-linux-(?:gnu|musl)|pc-windows-msvc)(?:\.exe)?$/.test(name);
}

export function isCodexAppServerProcess(processInfo: ProcessIdentity): boolean {
  const executable = executableName(processInfo.executable);
  if (executable === "codex-code-mode-host" || executable === "codex-code-mode-host.exe") return true;
  if (!isCodexExecutable(processInfo.executable) || processInfo.args.length < 2) return false;

  for (let index = 1; index < processInfo.args.length; index += 1) {
    const arg = processInfo.args[index];
    if (arg === "--") return processInfo.args[index + 1] === "app-server";
    if (!arg.startsWith("-")) return arg === "app-server";
    if (GLOBAL_FLAGS.has(arg)) continue;
    if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      if (index >= processInfo.args.length) return false;
      continue;
    }
    const option = arg.split("=", 1)[0];
    if (arg.includes("=") && GLOBAL_OPTIONS_WITH_VALUE.has(option)) continue;
    if (/^-[cmpsCa].+/.test(arg)) continue;
    return false;
  }
  return false;
}

function readCString(buffer: Buffer, offset: number): { value: string; next: number } {
  const end = buffer.indexOf(0, offset);
  if (end < 0) throw new Error("Unterminated process argument");
  return { value: buffer.toString("utf8", offset, end), next: end + 1 };
}

function openDarwinSystemLibrary() {
  return dlopen("/usr/lib/libSystem.B.dylib", {
    sysctl: {
      args: ["ptr", "uint32_t", "ptr", "ptr", "ptr", "uint64_t"],
      returns: "int",
    },
  });
}

type DarwinSysctl = ReturnType<typeof openDarwinSystemLibrary>["symbols"]["sysctl"];

function readDarwinArgs(pid: number, sysctl: DarwinSysctl): { executable: string; args: string[] } {
  const mib = new Int32Array([1, 49, pid]); // CTL_KERN, KERN_PROCARGS2, PID
  const size = new BigUint64Array(1);
  if (sysctl(mib, mib.length, null, size, null, 0n) !== 0) {
    throw new Error("Process argument size is unavailable");
  }
  const length = Number(size[0]);
  if (!Number.isSafeInteger(length) || length < 5 || length > 16 * 1024 * 1024) {
    throw new Error("Invalid process argument size");
  }
  const buffer = Buffer.alloc(length);
  if (sysctl(mib, mib.length, buffer, size, null, 0n) !== 0) {
    throw new Error("Process arguments are unavailable");
  }
  if (buffer.length < 5) throw new Error("Process arguments are unavailable");
  const argc = buffer.readInt32LE(0);
  if (argc < 1 || argc > 100_000) throw new Error("Invalid process argument count");

  const executable = readCString(buffer, 4);
  let offset = executable.next;
  while (offset < buffer.length && buffer[offset] === 0) offset += 1;
  const args: string[] = [];
  while (args.length < argc && offset < buffer.length) {
    const entry = readCString(buffer, offset);
    args.push(entry.value);
    offset = entry.next;
  }
  if (args.length !== argc) throw new Error("Incomplete process arguments");
  return { executable: executable.value, args };
}

function listDarwinProcesses(): ProcessIdentity[] {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Current user ID is unavailable");
  const output = execFileSync("/bin/ps", ["-ww", "-axo", "pid=,uid=,lstart=,command="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 16 * 1024 * 1024,
  });
  const processes: ProcessIdentity[] = [];
  const linePattern = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d{4})\s+(.+?)\s*$/;

  const library = openDarwinSystemLibrary();
  try {
    for (const line of output.split("\n")) {
      const match = line.match(linePattern);
      const invokedExecutable = match?.[4].trim().split(/\s+/, 1)[0] || "";
      if (!match || Number(match[2]) !== uid || (!isCodexExecutable(invokedExecutable)
        && !/^codex-code-mode-host(?:\.exe)?$/i.test(executableName(invokedExecutable)))) continue;
      try {
        const command = readDarwinArgs(Number(match[1]), library.symbols.sysctl);
        processes.push({
          pid: Number(match[1]),
          owner: match[2],
          startedAt: match[3],
          executable: command.executable,
          args: command.args,
        });
      } catch {
        // 身份读取不完整的 PID 不进入候选集，确保不会向它发送信号。
      }
    }
  } finally {
    library.close();
  }
  return processes;
}

function listLinuxProcesses(): ProcessIdentity[] {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Current user ID is unavailable");
  const entries = fs.readdirSync("/proc", { withFileTypes: true });
  const processes: ProcessIdentity[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const root = `/proc/${entry.name}`;
    try {
      const status = fs.readFileSync(`${root}/status`, "utf8");
      const owner = status.match(/^Uid:\s+(\d+)/m)?.[1];
      if (owner !== String(uid)) continue;
      const executable = fs.readlinkSync(`${root}/exe`);
      if (!isCodexExecutable(executable)
        && !/^codex-code-mode-host(?:\.exe)?$/i.test(executableName(executable))) continue;
      const args = fs.readFileSync(`${root}/cmdline`).toString("utf8").split("\0").filter(Boolean);
      const stat = fs.readFileSync(`${root}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const startedAt = fields[19];
      if (!startedAt || args.length === 0) continue;
      processes.push({ pid: Number(entry.name), owner, startedAt, executable, args });
    } catch {
      // 进程退出或身份不可读时跳过，后续也不会向该 PID 发送信号。
    }
  }
  return processes;
}

export function parseWindowsCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let index = 0;
  while (index < commandLine.length) {
    while (/\s/.test(commandLine[index] ?? "")) index += 1;
    if (index >= commandLine.length) break;
    let value = "";
    let quoted = false;
    while (index < commandLine.length && (quoted || !/\s/.test(commandLine[index]))) {
      let slashes = 0;
      while (commandLine[index] === "\\") {
        slashes += 1;
        index += 1;
      }
      if (commandLine[index] === '"') {
        value += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 0) quoted = !quoted;
        else value += '"';
        index += 1;
      } else {
        value += "\\".repeat(slashes);
        if (index < commandLine.length) value += commandLine[index++];
      }
    }
    args.push(value);
  }
  return args;
}

function windowsSystemPath(...segments: string[]): string {
  const systemRoot = process.env.SystemRoot || process.env.windir;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error("Windows system root is unavailable");
  return path.win32.join(systemRoot, ...segments);
}

function listWindowsProcesses(): ProcessIdentity[] {
  const powershell = windowsSystemPath("System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$rows = Get-CimInstance Win32_Process | ForEach-Object {
  $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue
  if ($owner.ReturnValue -eq 0) {
    $name = "$($owner.Domain)\\$($owner.User)"
    if ($name -ieq $me -and $_.ExecutablePath -and $_.CommandLine -and $_.CreationDate) {
      [PSCustomObject]@{
        pid = $_.ProcessId
        owner = $name
        startedAt = $_.CreationDate.ToUniversalTime().Ticks.ToString()
        executable = $_.ExecutablePath
        commandLine = $_.CommandLine
      }
    }
  }
}
ConvertTo-Json -InputObject @($rows) -Compress
`;
  const output = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const rows = JSON.parse(output || "[]") as Array<{
    pid: number;
    owner: string;
    startedAt: string;
    executable: string;
    commandLine: string;
  }>;
  return rows.map((row) => ({
    pid: row.pid,
    owner: row.owner,
    startedAt: row.startedAt,
    executable: row.executable,
    args: parseWindowsCommandLine(row.commandLine),
  }));
}

function listSystemProcesses(): ProcessIdentity[] {
  if (process.platform === "darwin") return listDarwinProcesses();
  if (process.platform === "linux") return listLinuxProcesses();
  if (process.platform === "win32") return listWindowsProcesses();
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function terminateSystemProcess(pid: number): void {
  if (process.platform !== "win32") {
    process.kill(pid, "SIGTERM");
    return;
  }
  try {
    const taskkill = windowsSystemPath("System32", "taskkill.exe");
    if (!fs.existsSync(taskkill)) throw new Error("taskkill.exe not found");
    execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    process.kill(pid, "SIGTERM");
  }
}

const SYSTEM_RUNTIME: StopRuntime = {
  listProcesses: listSystemProcesses,
  terminate: terminateSystemProcess,
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export function scanCodexAppServers(
  listProcesses: () => ProcessIdentity[] = listSystemProcesses,
): AppServerScan {
  try {
    return { status: "ok", processes: listProcesses().filter(isCodexAppServerProcess) };
  } catch (error) {
    return { status: "unknown", error: errorMessage(error) };
  }
}

function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid
    && left.owner === right.owner
    && left.startedAt === right.startedAt
    && left.executable === right.executable
    && JSON.stringify(left.args) === JSON.stringify(right.args);
}

export async function stopCodexAppServers(
  runtime: StopRuntime = SYSTEM_RUNTIME,
): Promise<{ scan: "ok" | "unknown"; results: AppServerStopResult[]; error?: string }> {
  const initial = scanCodexAppServers(runtime.listProcesses);
  if (initial.status === "unknown") return { scan: "unknown", results: [], error: initial.error };
  if (initial.processes.length === 0) return { scan: "ok", results: [] };

  const current = scanCodexAppServers(runtime.listProcesses);
  if (current.status === "unknown") {
    return {
      scan: "unknown",
      results: initial.processes.map(({ pid }) => ({ pid, status: "failed" })),
      error: current.error,
    };
  }

  const currentByPid = new Map(current.processes.map((entry) => [entry.pid, entry]));
  const results = new Map<number, AppServerStopResult>();
  const signaled: ProcessIdentity[] = [];
  for (const candidate of initial.processes) {
    const revalidated = currentByPid.get(candidate.pid);
    if (!revalidated || !sameIdentity(candidate, revalidated)) {
      results.set(candidate.pid, { pid: candidate.pid, status: "failed" });
      continue;
    }
    try {
      runtime.terminate(candidate.pid);
      signaled.push(candidate);
    } catch {
      results.set(candidate.pid, { pid: candidate.pid, status: "failed" });
    }
  }

  if (signaled.length > 0) await runtime.wait(2_000);
  if (signaled.length === 0) {
    return { scan: "ok", results: initial.processes.map(({ pid }) => results.get(pid)!) };
  }
  const final = scanCodexAppServers(runtime.listProcesses);
  if (final.status === "unknown") {
    for (const candidate of signaled) results.set(candidate.pid, { pid: candidate.pid, status: "failed" });
    return { scan: "unknown", results: initial.processes.map(({ pid }) => results.get(pid)!), error: final.error };
  }

  const finalByPid = new Map(final.processes.map((entry) => [entry.pid, entry]));
  for (const candidate of signaled) {
    const survivor = finalByPid.get(candidate.pid);
    results.set(candidate.pid, {
      pid: candidate.pid,
      status: survivor && sameIdentity(candidate, survivor) ? "surviving" : "stopped",
    });
  }
  return { scan: "ok", results: initial.processes.map(({ pid }) => results.get(pid)!) };
}
