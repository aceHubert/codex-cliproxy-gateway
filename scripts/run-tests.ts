// 限制整轮测试时间，避免后台测试进程长期挂起。
const child = Bun.spawn([process.execPath, "test", ...process.argv.slice(2)], { stdout: "inherit", stderr: "inherit" });
const timer = setTimeout(() => { child.kill(); console.error("测试超过 60 秒，已终止。"); }, 60_000);
try { process.exitCode = await child.exited; } finally { clearTimeout(timer); }
export {};
