#!/usr/bin/env bun
import { formatErrorLog, runCli } from "./cli.ts";

// Bun 默认把未捕获异常裸打 stderr（无时间戳）并直接退出进程；而网关的错误多为
// 客户端中断触发的流清理噪音，退出会中断所有在途请求。这里接管后统一带时间戳
// 记录并继续服务，真正的致命故障（OOM、段错误等）无法被捕获，仍由 launchd
// KeepAlive 兜底。
process.on("uncaughtException", (error) => {
  console.error(formatErrorLog(error, new Date(), { label: "uncaughtException", stack: true }));
});
process.on("unhandledRejection", (reason) => {
  console.error(formatErrorLog(reason, new Date(), { label: "unhandledRejection", stack: true }));
});

runCli(process.argv.slice(2)).catch((error) => {
  console.error(formatErrorLog(error));
  process.exitCode = 1;
});
