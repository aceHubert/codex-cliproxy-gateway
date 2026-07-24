import os from "node:os";
import path from "node:path";
import type { ResolvedPaths } from "./types.ts";

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): ResolvedPaths {
  const home = env.HOME || os.homedir();
  const codexHome = env.CODEX_HOME || path.join(home, ".codex");
  const runtimeHome = path.join(home, ".codex-cliproxy-gateway");
  return {
    home,
    codexHome,
    runtimeHome,
    configToml: path.join(codexHome, "config.toml"),
    gatewayConfig: path.join(runtimeHome, "config.json"),
    stateFile: path.join(runtimeHome, "state.json"),
    catalogFile: path.join(codexHome, "cliproxy-catalog.json"),
    stdoutLog: path.join(runtimeHome, "gateway.log"),
    stderrLog: path.join(runtimeHome, "gateway.error.log"),
    launchAgent: path.join(home, "Library", "LaunchAgents", "codex-cliproxy-gateway.plist"),
  };
}
