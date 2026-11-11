import fs, { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEAD_BYTES, HEAD_LINE_CAP, TAIL_BYTES, JsonlTail } from "../../src/main/readers/jsonl";
import { frameEnd, ZstdTail } from "../../src/main/readers/zstd";
import { appendZstd } from "../fixtures/logs";
import { mkTmpDir } from "../harness/wait";

afterEach(() => vi.restoreAllMocks());

const file = (name = "a.jsonl"): string => path.join(mkTmpDir(), name);
const compress = (text: string | Buffer): Buffer => zlib.zstdCompressSync(Buffer.from(text));

// 手写帧只用于边界扫描；raw 帧也供重写与跳过帧测试解压。
function rawFrame(text: string): Buffer {
  const bytes = Buffer.from(text), header = Buffer.alloc(9);
  header.writeUInt32LE(0xfd2fb528);
  header[4] = 0x20;
  header[5] = bytes.length;
  header.writeUIntLE((bytes.length << 3) | 1, 6, 3);
  return Buffer.concat([header, bytes]);
}

function skippable(payload = "metadata", variant = 0): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x184d2a50 + variant);
  header.writeUInt32LE(Buffer.byteLength(payload), 4);
  return Buffer.concat([header, Buffer.from(payload)]);
}

// 保持真实文件、stat、close 的行为，只限制一次系统读取返回的字节数。
function shortReads(maxBytes: number): void {
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation((async (buffer: Buffer, offset: number, length: number, position: number) =>
      read(buffer, offset, Math.min(length, maxBytes), position)) as typeof handle.read);
    return handle;
  });
}

// 真实关闭句柄后注入一次拒绝，既触发调用失败，也不泄漏测试文件句柄。
function failNextClose(): void {
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, "open").mockImplementationOnce(async (...args) => {
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementationOnce(async () => {
      await close();
      throw new Error("synthetic close failure");
    });
    return handle;
  });
}

describe.each([
  { name: "JSONL", create: (f: string) => new JsonlTail(f), encode: (bytes: Buffer) => bytes },
  { name: "zstd", create: (f: string) => new ZstdTail(f), encode: compress },
])("$name close 失败", ({ create, encode }) => {
  it("首读失败后重试交付全部未收到的行", async () => {
    const f = file(); writeFileSync(f, encode(Buffer.from("first\nsecond\npar")));
    const tail = create(f);
    failNextClose();
    await expect(tail.read()).rejects.toThrow("synthetic close failure");
    expect(await tail.read()).toEqual({ lines: ["first", "second"], reset: false });
    appendFileSync(f, encode(Buffer.from("tial\n")));
    expect(await tail.read()).toEqual({ lines: ["partial"], reset: false });
    expect(await tail.read()).toEqual({ lines: [], reset: false });
  });

  it("增量失败后重试保留原 UTF-8 半行及新残行", async () => {
    const f = file(), bytes = Buffer.from("测试\nnext");
    writeFileSync(f, encode(bytes.subarray(0, 2)));
    const tail = create(f);
    expect(await tail.read()).toEqual({ lines: [], reset: false });
    appendFileSync(f, encode(bytes.subarray(2)));
    failNextClose();
    await expect(tail.read()).rejects.toThrow("synthetic close failure");
    expect(await tail.read()).toEqual({ lines: ["测试"], reset: false });
    appendFileSync(f, encode(Buffer.from(" line\n")));
    expect(await tail.read()).toEqual({ lines: ["next line"], reset: false });
    expect(await tail.read()).toEqual({ lines: [], reset: false });
  });

  it("截断重读失败后重试仍交付 reset 和新行", async () => {
    const f = file(); writeFileSync(f, encode(Buffer.from("old\nlong pending line")));
    const tail = create(f); await tail.read();
    writeFileSync(f, encode(Buffer.from("new\n")));
    failNextClose();
    await expect(tail.read()).rejects.toThrow("synthetic close failure");
    expect(await tail.read()).toEqual({ lines: ["new"], reset: true });
    expect(await tail.read()).toEqual({ lines: [], reset: false });
  });
});

it("对整个多帧文件解压只得到第一帧，所以必须按帧切分", () => {
  const f = file("s.zst");
  appendZstd(f, [{ n: 1 }]); appendZstd(f, [{ n: 2 }]);
  expect(zlib.zstdDecompressSync(readFileSync(f)).toString()).toBe('{"n":1}\n');
});

describe("frameEnd", () => {
  it("返回各帧结束位置，半个 magic 等待，错误 magic 抛错", () => {
    const a = compress('{"n":1}\n'), b = compress('{"n":2}\n');
    const both = Buffer.concat([a, b]);
    expect(frameEnd(both, 0)).toBe(a.length);
    expect(frameEnd(both, a.length)).toBe(both.length);
    expect(frameEnd(both.subarray(0, a.length + 3), a.length)).toBe(-1);
    expect(() => frameEnd(Buffer.from("not zstd at all"), 0)).toThrow();
  });

  it("帧头、块头、块内容和 checksum 任意截断都返回 -1", () => {
    const frame = zlib.zstdCompressSync(Buffer.from("hello\n"), {
      params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
    });
    for (let end = 0; end < frame.length; end++) {
      expect(frameEnd(frame.subarray(0, end), 0), `截断于 ${end}`).toBe(-1);
    }
    expect(frameEnd(frame, 0)).toBe(frame.length);
  });

  it.each([0, 1, 2, 3])("覆盖内容长度标志 %i 的单段/窗口头与字典长度", (fcsFlag) => {
    for (const single of [0, 1]) for (const dictFlag of [0, 1, 2, 3]) {
      const fields = 1 + (single ? 0 : 1) + [0, 1, 2, 4][dictFlag] + [single ? 1 : 0, 2, 4, 8][fcsFlag];
      const frame = Buffer.alloc(4 + fields + 3);
      frame.writeUInt32LE(0xfd2fb528);
      frame[4] = (fcsFlag << 6) | (single << 5) | dictFlag;
      frame[4 + fields] = 1; // 最后一块为长度 0 的 raw 块。
      expect(frameEnd(frame, 0)).toBe(frame.length);
      for (let end = 4; end < frame.length; end++) expect(frameEnd(frame.subarray(0, end), 0)).toBe(-1);
    }
  });

  it("多块帧中 RLE 只占一个字节，compressed 块占 size 字节", () => {
    // window header；非末 RLE 块（解出 100 字节）；末 compressed 块（3 字节）。
    const frame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0x22, 3, 0, 65, 0x1d, 0, 0, 1, 2, 3]);
    expect(frameEnd(frame, 0)).toBe(16);
    expect(frameEnd(frame.subarray(0, 15), 0)).toBe(-1);
  });

  it("保留块类型抛错，不当作未写完", () => {
    const frame = rawFrame(""); frame[6] = 7;
    expect(() => frameEnd(frame, 0)).toThrow();
  });

  it.each([0, 15])("可跳过帧 magic 变体 %i：完整、空 payload 与所有截断", (variant) => {
    const frame = skippable("meta", variant);
    expect(frameEnd(frame, 0)).toBe(12);
    for (let end = 0; end < frame.length; end++) expect(frameEnd(frame.subarray(0, end), 0)).toBe(-1);
    expect(frameEnd(skippable("", variant), 0)).toBe(8);
  });
});

describe("JsonlTail", () => {
  it("分段追加、半行、CRLF、空行与重复读取", async () => {
    const f = file(); writeFileSync(f, '\n\r\n{"n":1}\r\n{"n":');
    const tail = new JsonlTail(f);
    expect(await tail.read()).toEqual({ lines: ['{"n":1}'], reset: false });
    appendFileSync(f, '2}\n{"n":3}\n\n');
    expect(await tail.read()).toEqual({ lines: ['{"n":2}', '{"n":3}'], reset: false });
    expect(await tail.read()).toEqual({ lines: [], reset: false });
  });

  it("汉字字节跨追加边界仍拼回原样", async () => {
    const f = file(), bytes = Buffer.from('{"t":"测试"}\n');
    writeFileSync(f, bytes.subarray(0, 8)); const tail = new JsonlTail(f);
    expect((await tail.read()).lines).toEqual([]);
    appendFileSync(f, bytes.subarray(8));
    expect((await tail.read()).lines).toEqual(['{"t":"测试"}']);
  });

  it("文件变短时重读，清除旧残行", async () => {
    const f = file(); writeFileSync(f, '{"n":1}\n{"n":2}\n{"old":"半');
    const tail = new JsonlTail(f); await tail.read();
    writeFileSync(f, '{"m":1}\n');
    expect(await tail.read()).toEqual({ lines: ['{"m":1}'], reset: true });
    expect(await tail.read()).toEqual({ lines: [], reset: false });
  });

  it("空文件后追加、截断到零后再追加", async () => {
    const f = file(); writeFileSync(f, ""); const tail = new JsonlTail(f);
    expect(await tail.read()).toEqual({ lines: [], reset: false });
    appendFileSync(f, "a\npending");
    expect((await tail.read()).lines).toEqual(["a"]);
    writeFileSync(f, "");
    expect(await tail.read()).toEqual({ lines: [], reset: true });
    appendFileSync(f, "b\n");
    expect((await tail.read()).lines).toEqual(["b"]);
  });

  it("大文件首读保留跨过 head 边界的一整行，省略中间", async () => {
    const f = file();
    const head = ['{"h":1}', `{"h":"${"x".repeat(150)}"}`];
    const middle = Array.from({ length: 50 }, (_, i) => `{"m":${i}}`);
    writeFileSync(f, [...head, ...middle, '{"t":1}', '{"t":2}'].join("\n") + "\n");
    expect((await new JsonlTail(f, { headBytes: 100, tailBytes: 20 }).read()).lines)
      .toEqual([...head, '{"t":1}', '{"t":2}']);
  });

  it("默认窗口为 64 KiB + 512 KiB，并保留尾端残行", async () => {
    const f = file(), h = "h".repeat(HEAD_BYTES - 1), t = "t".repeat(TAIL_BYTES - 5);
    writeFileSync(f, `${h}\nskipped\n${t}\n半`);
    const tail = new JsonlTail(f);
    expect((await tail.read()).lines).toEqual([h, t]);
    appendFileSync(f, "行\n");
    expect((await tail.read()).lines).toEqual(["半行"]);
  });

  it("文件大小恰为 head + tail 时读全文件", async () => {
    const f = file(); writeFileSync(f, "a\nb\nc\nd\n");
    expect((await new JsonlTail(f, { headBytes: 4, tailBytes: 4 }).read()).lines).toEqual(["a", "b", "c", "d"]);
  });

  it.each([
    { text: "h\nskipped\nt1\nt2\n", tailBytes: 6, want: ["h", "t1", "t2"] },
    { text: "h\nskipped\nt1\nt2\n", tailBytes: 5, want: ["h", "t2"] },
    { text: "h\nskipped\nt1\nt2\n", tailBytes: 7, want: ["h", "t1", "t2"] },
    { text: "abcdef\nx\n", tailBytes: 5, want: ["abcdef", "x"] },
  ])("头尾窗口边界 $tailBytes：$text", async ({ text, tailBytes, want }) => {
    const f = file(); writeFileSync(f, text);
    expect((await new JsonlTail(f, { headBytes: 2, tailBytes }).read()).lines).toEqual(want);
  });

  it("头行延伸到 EOF 时残行保留且不重复", async () => {
    const f = file(); writeFileSync(f, "incomplete");
    const tail = new JsonlTail(f, { headBytes: 2, tailBytes: 3 });
    expect((await tail.read()).lines).toEqual([]);
    appendFileSync(f, " line\nnext\n");
    expect((await tail.read()).lines).toEqual(["incomplete line", "next"]);
  });

  it("尾窗全落在残行里时，跨后续读取一直丢弃到换行", async () => {
    const f = file(); writeFileSync(f, "h\nskipped\nunfinished");
    const tail = new JsonlTail(f, { headBytes: 2, tailBytes: 3 });
    expect((await tail.read()).lines).toEqual(["h"]);
    appendFileSync(f, " more"); expect((await tail.read()).lines).toEqual([]);
    appendFileSync(f, "\r\nnext\n"); expect((await tail.read()).lines).toEqual(["next"]);
  });

  it("HEAD_LINE_CAP 内结束的跨界行保留，超过 cap 的行丢弃", async () => {
    for (const extra of [0, 1]) {
      const f = file(), long = "x".repeat(HEAD_LINE_CAP - 3 + extra);
      writeFileSync(f, `h\n${long}\nskipped\ntail\n`);
      const tail = new JsonlTail(f, { headBytes: 4, tailBytes: 5 });
      expect((await tail.read()).lines).toEqual(extra === 0 ? ["h", long, "tail"] : ["h", "tail"]);
    }
  });

  it("超过 cap 且尚无换行的头行在后续追加中也不泄漏片段", async () => {
    const f = file(); writeFileSync(f, "x".repeat(HEAD_LINE_CAP + 10));
    const tail = new JsonlTail(f, { headBytes: 4, tailBytes: 4 });
    expect((await tail.read()).lines).toEqual([]);
    appendFileSync(f, "suffix\nnext\n");
    expect((await tail.read()).lines).toEqual(["next"]);
  });

  it("短系统读取仍读完头尾窗口及之后新增的字节", async () => {
    const f = file(); writeFileSync(f, "开头\nskipped\n尾部\n"); shortReads(2);
    const tail = new JsonlTail(f, { headBytes: 2, tailBytes: 7 });
    expect((await tail.read()).lines).toEqual(["开头", "尾部"]);
    appendFileSync(f, "追加\n"); expect((await tail.read()).lines).toEqual(["追加"]);
  });

  it("尾窗内大量短行不超过 JavaScript 函数参数上限", async () => {
    const f = file(); writeFileSync(f, `h\nskipped\n${"t\n".repeat(150_000)}`);
    const result = await new JsonlTail(f, { headBytes: 2, tailBytes: 300_000 }).read();
    expect(result.lines.length).toBe(150_001);
    expect(result.lines[0]).toBe("h");
    expect(result.lines.slice(1).every((line) => line === "t")).toBe(true);
  });
});

describe("ZstdTail", () => {
  it("更长重写的 close 失败后重试仍交付 reset 和新行", async () => {
    const f = file("s.zst"); writeFileSync(f, rawFrame("old\npending"));
    const tail = new ZstdTail(f); await tail.read();
    const line = "new".repeat(40);
    writeFileSync(f, rawFrame(`${line}\n`));
    failNextClose();
    await expect(tail.read()).rejects.toThrow("synthetic close failure");
    expect(await tail.read()).toEqual({ lines: [line], reset: true });
    expect(await tail.read()).toEqual({ lines: [], reset: false });
  });

  it("首读全部帧，逐帧追加；半帧补齐后只出一次", async () => {
    const f = file("s.zst"); appendZstd(f, [{ n: 1 }]); appendZstd(f, [{ n: 2 }]);
    const tail = new ZstdTail(f);
    expect(await tail.read()).toEqual({ lines: ['{"n":1}', '{"n":2}'], reset: false });
    const frame = compress('{"n":3}\n');
    appendFileSync(f, frame.subarray(0, 5));
    expect(await tail.read()).toEqual({ lines: [], reset: false });
    expect(await tail.read()).toEqual({ lines: [], reset: false });
    appendFileSync(f, frame.subarray(5));
    expect(await tail.read()).toEqual({ lines: ['{"n":3}'], reset: false });
    expect(await tail.read()).toEqual({ lines: [], reset: false });
  });

  it("一行、一个汉字跨帧且跨两次 read，CRLF 和空行也正常", async () => {
    const f = file("s.zst"), bytes = Buffer.from('\r\n{"t":"测试"}\r\n\n');
    writeFileSync(f, compress(bytes.subarray(0, 10)));
    const tail = new ZstdTail(f); expect((await tail.read()).lines).toEqual([]);
    appendFileSync(f, compress(bytes.subarray(10)));
    expect((await tail.read()).lines).toEqual(['{"t":"测试"}']);
    expect((await new ZstdTail(f).read()).lines).toEqual(['{"t":"测试"}']);
  });

  it("截断时从头重读并清除旧 UTF-8 残字节", async () => {
    const f = file("s.zst");
    writeFileSync(f, compress(Buffer.concat([Buffer.from('{"n":1}\n{"n":2}\n{"n":3}\n'), Buffer.from("测").subarray(0, 2)])));
    const tail = new ZstdTail(f); await tail.read();
    writeFileSync(f, compress('{"m":1}\n'));
    expect(await tail.read()).toEqual({ lines: ['{"m":1}'], reset: true });
  });

  it("更长重写在旧偏移不是帧头时重读，并清除旧残行", async () => {
    const f = file("s.zst"); writeFileSync(f, rawFrame("old\npending"));
    const tail = new ZstdTail(f); await tail.read();
    const line = "new".repeat(40);
    writeFileSync(f, rawFrame(`${line}\n`));
    expect(await tail.read()).toEqual({ lines: [line], reset: true });
    expect(await tail.read()).toEqual({ lines: [], reset: false });
  });

  it("每个字节依次追加：header、block、checksum 未齐不前移", async () => {
    const f = file("s.zst"); writeFileSync(f, ""); const tail = new ZstdTail(f);
    expect(await tail.read()).toEqual({ lines: [], reset: false });
    const frame = zlib.zstdCompressSync(Buffer.from("done\n"), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
    for (let i = 0; i < frame.length; i++) {
      appendFileSync(f, frame.subarray(i, i + 1));
      expect(await tail.read()).toEqual({ lines: i === frame.length - 1 ? ["done"] : [], reset: false });
    }
  });

  it("跳过元数据帧，半个跳过帧继续等待，前后行字节仍相连", async () => {
    const f = file("s.zst"), skip = skippable("metadata", 15);
    writeFileSync(f, Buffer.concat([skippable(""), compress("first\npar"), skip.subarray(0, 9)]));
    const tail = new ZstdTail(f);
    expect((await tail.read()).lines).toEqual(["first"]);
    appendFileSync(f, Buffer.concat([skip.subarray(9), compress("tial\nlast\n")]));
    expect(await tail.read()).toEqual({ lines: ["partial", "last"], reset: false });
  });

  it("短系统读取仍拿到所有帧", async () => {
    const f = file("s.zst"); appendZstd(f, [{ n: 1 }]); appendZstd(f, [{ n: 2 }]); shortReads(2);
    expect((await new ZstdTail(f).read()).lines).toEqual(['{"n":1}', '{"n":2}']);
  });

  it("首读保留一个帧中的全部大量短行", async () => {
    const f = file("s.zst"); writeFileSync(f, compress("x\n".repeat(150_000)));
    const result = await new ZstdTail(f).read();
    expect(result.lines.length).toBe(150_000);
    expect(result.lines.every((line) => line === "x")).toBe(true);
  });

  it("从零也无法读取的坏帧报错，不无限重试", async () => {
    const f = file("s.zst"); writeFileSync(f, rawFrame("old\n"));
    const tail = new ZstdTail(f); await tail.read();
    writeFileSync(f, "not zstd ".repeat(20));
    await expect(tail.read()).rejects.toThrow();
  });
});
