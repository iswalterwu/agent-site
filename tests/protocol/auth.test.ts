import { expect, it } from "vitest";
import { bridgeProof, newNonce, proofInput, proofMatches, siteProof } from "../../src/protocol/auth";

const nonces = { bridgeNonce: "B".repeat(43), siteNonce: "S".repeat(43) };
const secret = "0123456789abcdef".repeat(4);

it("随机数是 32 字节的 base64url，每次都不一样", () => {
  const a = newNonce();
  const b = newNonce();
  expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(a).not.toBe(b);
});

it("固件向量：输入串的拼接方式和 HMAC 的结果都不许变（两端各接一份错误实现也能对上，所以钉死值）", () => {
  expect(proofInput("site", nonces)).toBe(`site:${nonces.bridgeNonce}.${nonces.siteNonce}`);
  // HMAC-SHA256(key = secret, message = "site:BBB….SSS…")，base64url
  expect(siteProof(secret, nonces)).toBe("uzuMYzOxHSCm-HhG5t1h1JlAlh-XjbAsG4zAhD1Iqao");
  expect(bridgeProof(secret, nonces)).toBe("R23zUgEpRrGnTKNs3MSuRZyOqBeet8TFhSHxbIVBvcU");
});

it("两个方向的证明不一样：把一个方向的证明拿去冒充另一个方向，验不过", () => {
  expect(siteProof(secret, nonces)).not.toBe(bridgeProof(secret, nonces));
  expect(proofMatches(bridgeProof(secret, nonces), siteProof(secret, nonces))).toBe(false);
});

it("换了随机数或口令，证明就变（换 nonce 重放没用）", () => {
  const proof = siteProof(secret, nonces);
  expect(siteProof(secret, { ...nonces, siteNonce: "T".repeat(43) })).not.toBe(proof);
  expect(siteProof(secret, { ...nonces, bridgeNonce: "C".repeat(43) })).not.toBe(proof);
  expect(siteProof("another-secret", nonces)).not.toBe(proof);
});

it("proofMatches：相等才通过，长度不同、空串都不抛错", () => {
  const proof = siteProof(secret, nonces);
  expect(proofMatches(proof, proof)).toBe(true);
  expect(proofMatches(proof, `${proof}x`)).toBe(false);
  expect(proofMatches(proof, "")).toBe(false);
});
