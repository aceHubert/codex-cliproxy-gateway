export const LOG_SIZE_UNITS = ["KB", "MB"] as const;
export type LogSizeUnit = typeof LOG_SIZE_UNITS[number];

/** 按 1024 进制拆分已有字节数，保留精度，避免保存其他字段时改变日志上限。 */
export function splitLogSize(bytes: number): { value: string; unit: LogSizeUnit } {
  if (bytes === 0) return { value: "0", unit: "MB" };
  const index = bytes < 1024 ** 2 ? 0 : 1;
  return { value: String(bytes / 1024 ** (index + 1)), unit: LOG_SIZE_UNITS[index] };
}

/** 零值直接提交数字 0，非零值提交带单位字符串；非法输入不进入保存流程。 */
export function parseLogSizeField(value: string, unit: LogSizeUnit): { bytes: number; payload: 0 | string } | null {
  if (!value.trim()) return null;
  const amount = Number(value);
  const index = LOG_SIZE_UNITS.indexOf(unit);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1024 || index < 0) return null;
  if (amount === 0) return { bytes: 0, payload: 0 };
  const normalized = String(amount);
  // 与服务端大小字符串语法一致，拒绝无法用普通十进制表达的极端数值。
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const bytes = Math.floor(amount * 1024 ** (index + 1));
  if (!Number.isSafeInteger(bytes)) return null;
  return { bytes, payload: `${normalized}${unit}` };
}

/** 请求日志保留数只接受 0～1000 的整数，清空输入也视为无效。 */
export function isValidRequestLogCount(value: string): boolean {
  return /^\d+$/.test(value.trim()) && Number(value) <= 1000;
}
