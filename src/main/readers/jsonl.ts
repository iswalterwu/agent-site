import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export interface TailRead { lines: string[]; reset: boolean }
export const HEAD_BYTES = 65_536;
export const TAIL_BYTES = 524_288;
export const HEAD_LINE_CAP = 1_048_576;

export class JsonlTail {
  private offset = 0;
  private started = false;
  private bytes = new LineBytes();
  private readonly headBytes: number;
  private readonly tailBytes: number;

  constructor(private readonly file: string, opts: { headBytes?: number; tailBytes?: number } = {}) {
    this.headBytes = opts.headBytes ?? HEAD_BYTES;
    this.tailBytes = opts.tailBytes ?? TAIL_BYTES;
  }

  async read(): Promise<TailRead> {
    const handle = await fs.open(this.file, "r");
    let next: { lines: string[]; bytes: LineBytes; offset: number };
    let reset: boolean;
    try {
      const { size } = await handle.stat();
      reset = size < this.offset;
      if (!this.started || reset) {
        next = await this.readFirst(handle, size);
      } else {
        const data = await readRange(handle, this.offset, size);
        const bytes = this.bytes.copy();
        next = { lines: bytes.push(data), bytes, offset: this.offset + data.length };
      }
    } finally {
      await handle.close();
    }
    // close 也属于本次读取；失败时保留旧状态，让重试交付尚未返回的行。
    this.bytes = next.bytes;
    this.offset = next.offset;
    this.started = true;
    return { lines: next.lines, reset };
  }

  private async readFirst(handle: FileHandle, size: number): Promise<{ lines: string[]; bytes: LineBytes; offset: number }> {
    let bytes = new LineBytes();
    if (size <= this.headBytes + this.tailBytes) {
      const data = await readRange(handle, 0, size);
      return { lines: bytes.push(data), bytes, offset: data.length };
    }

    const headLimit = Math.min(this.headBytes, HEAD_LINE_CAP, size);
    const head = await readRange(handle, 0, headLimit);
    const lines = bytes.push(head);
    let headEnd = head.length;
    let atBoundary = headEnd === 0 || head[headEnd - 1] === 10;
    if (headEnd < headLimit) return { lines, bytes, offset: headEnd };

    // 跨 headBytes 的行只延伸到第一个换行；HEAD_LINE_CAP 是绝对文件偏移。
    while (!atBoundary && headEnd < Math.min(size, HEAD_LINE_CAP)) {
      const more = await readRange(handle, headEnd, Math.min(headEnd + HEAD_BYTES, size, HEAD_LINE_CAP));
      if (more.length === 0) return { lines, bytes, offset: headEnd };
      const newline = more.indexOf(10);
      const used = newline < 0 ? more : more.subarray(0, newline + 1);
      for (const line of bytes.push(used)) lines.push(line);
      headEnd += used.length;
      atBoundary = newline >= 0;
    }
    // 超限行的后半截也不能作为一条记录；即使到下次追加才出现换行也要丢掉。
    if (!atBoundary && headEnd >= HEAD_LINE_CAP) bytes = new LineBytes(Buffer.alloc(0), true);

    const tailStart = Math.max(size - this.tailBytes, headEnd);
    if (tailStart > headEnd) {
      const previous = await readRange(handle, tailStart - 1, tailStart);
      bytes = new LineBytes(Buffer.alloc(0), previous[0] !== 10);
    }
    const tail = await readRange(handle, tailStart, size);
    for (const line of bytes.push(tail)) lines.push(line);
    return { lines, bytes, offset: tailStart + tail.length };
  }
}

/** 读取器内部共用：短 read 继续读取；遇到实际 EOF 时只返回已经读到的字节。 */
export async function readRange(handle: FileHandle, start: number, end: number): Promise<Buffer> {
  const data = Buffer.alloc(end - start);
  let used = 0;
  while (used < data.length) {
    const { bytesRead } = await handle.read(data, used, data.length - used, start + used);
    if (bytesRead === 0) break;
    used += bytesRead;
  }
  return data.subarray(0, used);
}

/** 读取器内部共用：半行只存字节，完整换行后才解码，避免切断 UTF-8。 */
export class LineBytes {
  constructor(private pending: Buffer = Buffer.alloc(0), private skipping = false) {}

  copy(): LineBytes { return new LineBytes(this.pending, this.skipping); }

  push(data: Buffer): string[] {
    if (this.skipping) {
      const newline = data.indexOf(10);
      if (newline < 0) return [];
      data = data.subarray(newline + 1);
      this.skipping = false;
    }
    const joined = this.pending.length ? Buffer.concat([this.pending, data]) : data;
    const lines: string[] = [];
    let start = 0;
    for (let end = joined.indexOf(10); end >= 0; end = joined.indexOf(10, start)) {
      const contentEnd = end > start && joined[end - 1] === 13 ? end - 1 : end;
      if (contentEnd > start) lines.push(joined.toString("utf8", start, contentEnd));
      start = end + 1;
    }
    // 拷贝残行，避免小残行一直持有整个大文件/帧的内存。
    this.pending = Buffer.from(joined.subarray(start));
    return lines;
  }
}
