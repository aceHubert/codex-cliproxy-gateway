/** 本机网关与 Web UI 的实例身份响应头。 */
export const INSTANCE_HEADER = "x-ccp-instance";

/** 端口已被其他进程占用时，禁止继续启动服务或把它认作目标实例。 */
export class InstanceHealthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceHealthError";
  }
}

/** HTTP 成功不足以证明归属；包括旧进程在内，无标记响应都需要先更新并重启。 */
export function assertHealthyInstance(response: Response, expectedMarker: string): void {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const marker = response.headers.get(INSTANCE_HEADER);
  if (marker === null) {
    throw new InstanceHealthError("Response has no codex-cliproxy instance marker; update/restart the target service and check port conflicts");
  }
  if (marker !== expectedMarker) {
    throw new InstanceHealthError("Response belongs to a different codex-cliproxy instance; check port conflicts between instances");
  }
}
