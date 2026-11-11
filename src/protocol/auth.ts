// 握手用的随机数与证明：口令不上线，两端各用 HMAC-SHA256 证明自己知道口令。
// 协议层里唯一用 node:crypto 的地方；纯函数，不做 I/O，不碰文件。

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 字节随机数，base64url：43 个字符，不带填充 */
export const newNonce = (): string => randomBytes(32).toString("base64url");

/** 一次握手的两个随机数：桥接先生成的在前，工地后生成的在后 */
export interface Nonces { bridgeNonce: string; siteNonce: string }

/** 证明的一方：site 是工地（App），bridge 是 pi 扩展 */
export type ProofSide = "site" | "bridge";

/** proof 的输入串；方向标签在前，两个方向的证明因此不能互相顶替 */
export const proofInput = (side: ProofSide, nonces: Nonces): string => `${side}:${nonces.bridgeNonce}.${nonces.siteNonce}`;

/** 工地算给桥接看的证明 */
export const siteProof = (secret: string, nonces: Nonces): string => hmac(secret, proofInput("site", nonces));

/** 桥接算给工地看的证明 */
export const bridgeProof = (secret: string, nonces: Nonces): string => hmac(secret, proofInput("bridge", nonces));

const hmac = (secret: string, input: string): string => createHmac("sha256", secret).update(input).digest("base64url");

/** 常量时间比较；长度不同直接 false（timingSafeEqual 要求等长） */
export function proofMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
