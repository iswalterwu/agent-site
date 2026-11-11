import { expect, it } from "vitest";
import { redact } from "../../src/core/redact";

const AWS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const SECRETS: [string, string][] = [
  ["key=sk-proj-AbC123xyz456DEF789", "key=sk-***"],
  ["token ghp_1234567890abcdefABCDEF1234567890abcd ok", "token ghp_*** ok"],
  ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc", "Authorization: Bearer ***"],
  ["AKIAIOSFODNN7EXAMPLE", "AKIA***"],
  ["sha 3a34ac8f1e2d3c4b5a69788776655443322110ff", "sha ***"],
  ["blob QWxhZGRpbjpvcGVuIHNlc2FtZQ4hZ2VuZXJhdGVkS2V5MTIzNA==", "blob ***"],
  // E17：AWS 秘密访问密钥（带 `/`）、0x 开头的十六进制、小写 bearer
  [`export AWS_SECRET_ACCESS_KEY=${AWS_KEY}`, "export AWS_SECRET_ACCESS_KEY=***"],
  [`aws_secret_access_key = ${AWS_KEY}`, "aws_secret_access_key = ***"],
  [`aws configure set aws_secret_access_key ${AWS_KEY}`, "aws configure set aws_secret_access_key ***"],
  [`aws_secret_access_key "${AWS_KEY}"`, `aws_secret_access_key "***"`],
  [`aws_secret_access_key '${AWS_KEY}'`, `aws_secret_access_key '***'`],
  [`"SecretAccessKey": "${AWS_KEY}"`, `"SecretAccessKey": "***"`],
  [`MY_AWS_SECRET_ACCESS_KEY=${AWS_KEY}`, "MY_AWS_SECRET_ACCESS_KEY=***"],
  [`privkey 0x${"0123456789abcdef".repeat(4)}`, "privkey ***"],
  ["authorization: bearer eyJhbGciOiJIUzI1NiJ9.e30.abc", "authorization: bearer ***"],
  // 分隔符可以连着写 `==`；值末尾的 base64 填充一起遮
  [`aws_secret_access_key==${AWS_KEY}`, "aws_secret_access_key==***"],
  [`aws_secret_access_key: ${AWS_KEY}==`, "aws_secret_access_key: ***"],
];
// 不像密钥的值不动：短单词、普通说法
const NOT_SECRETS: string[] = [
  "Bearer of bad news",
  "bearer abc",
  "aws_secret_access_key 短值",
  // 换行之后的值不算这个键的值（空白只认同一行）
  `aws_secret_access_key
${"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}`,
];
const MIXED: [string, string][] = [
  ["sk-proj-AbC123xyz456DEF789 和 ghp_1234567890abcdefABCDEF1234567890abcd", "sk-*** 和 ghp_***"],
  ["密钥sk-proj-AbC123xyz456DEF789已作废，sha 3a34ac8f1e2d3c4b5a69788776655443322110ff", "密钥sk-***已作废，sha ***"],
  // 名字后面的值超过 40 个字符、第 40 个字符是 `/`、后面接十六进制长串：整段值一遍遮完，不被第 5 条拆开
  ["aws_secret_access_key abcdefghijklmnopqrstuvwxyz0123456789ABC/0123456789abcdef0123456789abcdef",
    "aws_secret_access_key ***"],
];

it.each(SECRETS)("遮住 %s", (input, output) => expect(redact(input)).toBe(output));
it.each(NOT_SECRETS)("不像密钥就不遮：%s", (input) => expect(redact(input)).toBe(input));
it.each([
  "01a1a4e3-0233-720d-ab54-91658988078c",
  "D:/work/example/specs/agent-dock/plan.md",
  "提交 3a34ac8：记录计划",
  "skeleton sketch",
  "看 plan.md",
  // 40 个字符以上、但只占数字 / 大写 / 小写中的两类，第 6 条不遮
  "2026-11-04-agent-site-p2-engine-review-round-two",
  "createAgentSiteEngineSnapshotFromWorkflowState",
  "AGENT_SITE_P2_ENGINE_TASK_09_FIX_ROUND_01",
])("不误伤 %s", (input) => expect(redact(input)).toBe(input));
it.each(MIXED)("一行几个密钥、贴着中文的密钥、超长的值都遮住：%s", (input, output) => expect(redact(input)).toBe(output));

it.each([...SECRETS, ...MIXED])("再脱敏一次结果不变（E1）：%s", (input) => {
  const once = redact(input);
  expect(redact(once)).toBe(once);
});

const longWord = "skeleton".repeat(4096);
const words = "skeleton sketch ".repeat(2048);
const bearerSpaces = `Bearer${" ".repeat(200_000)}'`;
const hexThenG = `${"a".repeat(200_000)}g`;
const akiaRun = `AKIA${"A".repeat(200_000)}`;
const runsOf39 = `${"xY7".repeat(13)}.`.repeat(5000);
const LONG_INPUTS: [string, string, string][] = [
  ["十六进制、base64 样和单词长串（约 200 KB）",
    `${"0123456789abcdef".repeat(4096)} ${"QWxhZGRp4bjp+cGVu9==".repeat(3277)} ${longWord} ${words}`,
    `*** *** ${longWord} ${words}`],
  ["Bearer 后面 20 万个空格再接引号", bearerSpaces, bearerSpaces],
  ["20 万个十六进制字符后紧跟 g", hexThenG, hexThenG],
  ["AKIA 后面 20 万个大写字母", akiaRun, akiaRun],
  ["secret_access_key= 后面 20 万字符的 AWS 密钥字母长串（带 `/`）",
    `secret_access_key=${"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".repeat(5000)}`, "secret_access_key=***"],
  ["反复出现 39 个字符一段的混合串", runsOf39, runsOf39],
];
it.each(LONG_INPUTS)("长输入 200 ms 内处理完：%s", (_name, input, output) => {
  const start = performance.now();
  const out = redact(input);
  const elapsed = performance.now() - start;
  expect(out).toBe(output);
  expect(elapsed).toBeLessThan(200);
});
