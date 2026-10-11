import type { RequestBody } from "./types.ts";

/** 原始正文只读取一次；JSON 解析失败也缓存，避免再次消费请求流。 */
export class LazyRequestBody implements RequestBody {
  private raw?: Promise<Uint8Array>;
  private parsed?: Promise<unknown>;

  constructor(private readonly request: Request) {}

  bytes(): Promise<Uint8Array> {
    this.raw ??= this.request.arrayBuffer().then((buffer) => new Uint8Array(buffer));
    // 调用者修改字节副本不会损坏原始正文或后续 JSON 解析。
    return this.raw.then((bytes) => bytes.slice());
  }

  json(): Promise<unknown> {
    this.parsed ??= this.bytes().then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown);
    return this.parsed;
  }
}
