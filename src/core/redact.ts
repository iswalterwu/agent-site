// 脱敏：显示前遮住像密钥的片段（spec 第 7 节）。规则按计划 Task 9 的顺序逐条替换，E17 补了三处：
// bearer 不分大小写，只遮够长、字符像 token 的值；secret_access_key 一类名字后面 40 个字符以上的整段值（AWS 秘密访问密钥，可能带 `/`）；0x 开头的十六进制。
// 气泡和卡片详情先脱敏再截断，快照再对显示文本脱敏一次（E1），所以结果再脱敏一次必须不变；每条正则都是线性时间。
// 已知边界：十六进制长串紧贴字母、数字或下划线时不遮（如 secret_<hex>、<hex>g）；
// 路径里有一段 40 个以上字符、同时含数字和大小写字母时整段遮住（多遮，方向安全）。

export function redact(text: string): string {
  return text
    // bearer 只遮像 token 的值：够长且带数字或 token 分隔符，普通单词和字面量不动，免得把「bearer of …」这类话也遮了
    .replace(/\b(bearer)[ \t]+([A-Za-z0-9._~+/-]{8,}=*)/gi,
      (all: string, name: string, value: string) => /[0-9._~+/=-]/.test(value) ? `${name} ***` : all)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, "$1***")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***")
    // AWS 秘密访问密钥（E17）：名字后面隔 `=`、`:`（可以连着写 `==`）或同一行的空白，引号可有可无；
    // 整段值连末尾的 base64 填充一起遮，不留尾巴给后两条拆。
    // 放在第 5、6 条之前：那两条会把带 `/` 的密钥拆成几段，只遮掉其中一段
    .replace(/((?:aws_)?secret_?access_?key)(["']?[ \t]*[=:]+[ \t]*["']?|[ \t]+["']?)([A-Za-z0-9/+]{40,}={0,2})/gi, "$1$2***")
    .replace(/\b(?:0x)?[0-9a-fA-F]{32,}\b/g, "***")
    // 字符集里没有 `/`，路径按段计算；UUID 只有 36 个字符，够不到 40
    .replace(/[A-Za-z0-9+_=-]{40,}/g, maskMixedRun);
}

/** 第 6 条：长串里同时有数字、大写和小写字母才遮住，全小写的长单词、纯数字之类不动 */
function maskMixedRun(run: string): string {
  return /\d/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run) ? "***" : run;
}
