import { promises as fs } from "node:fs";
import zlib from "node:zlib";
import { LineBytes, readRange, type TailRead } from "./jsonl";

const MAGIC = 0xfd2fb528;
const isSkippable = (magic: number): boolean => (magic & 0xfffffff0) === 0x184d2a50;

/** 只扫描帧边界，不解压；不完整帧要留在原偏移供下一次追加后重试。 */
export function frameEnd(buf: Buffer, start: number): number {
  if (start + 4 > buf.length) return -1;
  const magic = buf.readUInt32LE(start);
  if (isSkippable(magic)) {
    if (start + 8 > buf.length) return -1;
    const end = start + 8 + buf.readUInt32LE(start + 4);
    return end <= buf.length ? end : -1;
  }
  if (magic !== MAGIC) throw new Error("不是 zstd 帧头");
  if (start + 5 > buf.length) return -1;
  const d = buf[start + 4], single = (d >> 5) & 1;
  let cursor = start + 4 + 1 + (single ? 0 : 1) + [0, 1, 2, 4][d & 3] + [single ? 1 : 0, 2, 4, 8][d >> 6];
  if (cursor > buf.length) return -1;
  for (;;) {
    if (cursor + 3 > buf.length) return -1;
    const h = buf.readUIntLE(cursor, 3), type = (h >> 1) & 3;
    if (type === 3) throw new Error("zstd 保留块类型");
    cursor += 3 + (type === 1 ? 1 : h >>> 3);
    if (cursor > buf.length) return -1;
    if (h & 1) break;
  }
  if (d & 4) cursor += 4;
  return cursor <= buf.length ? cursor : -1;
}

export class ZstdTail {
  private offset = 0;
  private bytes = new LineBytes();

  constructor(private readonly file: string) {}

  async read(): Promise<TailRead> {
    const handle = await fs.open(this.file, "r");
    let next: TailRead & { bytes: LineBytes; offset: number };
    try {
      const { size } = await handle.stat();
      let reset = size < this.offset;
      for (;;) {
        const start = reset ? 0 : this.offset;
        const data = await readRange(handle, start, size);
        const bytes = reset ? new LineBytes() : this.bytes.copy();
        const lines: string[] = [];
        let cursor = 0, retry = false;
        while (cursor < data.length) {
          let end: number;
          try {
            end = frameEnd(data, cursor);
          } catch (error) {
            // 旧偏移落在新帧内部可能是文件重写；最多从头重试一次，真坏帧继续抛错。
            if (reset || start === 0) throw error;
            reset = true;
            retry = true;
            break;
          }
          if (end === -1) break;
          if (!isSkippable(data.readUInt32LE(cursor))) {
            for (const line of bytes.push(zlib.zstdDecompressSync(data.subarray(cursor, end)))) lines.push(line);
          }
          cursor = end;
        }
        if (retry) continue;
        next = { lines, reset, bytes, offset: start + cursor };
        break;
      }
    } finally {
      await handle.close();
    }
    // close 失败也不能跳过本次尚未交付的帧和行。
    this.offset = next.offset;
    this.bytes = next.bytes;
    return { lines: next.lines, reset: next.reset };
  }
}
