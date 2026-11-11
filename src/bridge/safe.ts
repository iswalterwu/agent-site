// 把可能抛出的函数包成"绝不抛出"的版本：同步抛错和异步 reject 都变成 fallback，错误交给 onError。
// 正常的同步返回值保持同步、不包成 Promise —— tool_call 处理函数靠这一点做到未暂停时零等待。

export function safe<A extends unknown[], R>(
  fn: (...a: A) => R | Promise<R>,
  fallback: R,
  onError?: (e: unknown) => void,
): (...a: A) => R | Promise<R> {
  const recover = (e: unknown): R => {
    try {
      onError?.(e);
    } catch {
      // 回报错误的回调自己出错，也不能让异常漏出去
    }
    return fallback;
  };
  return (...a) => {
    try {
      const out = fn(...a);
      return out instanceof Promise ? out.catch(recover) : out;
    } catch (e) {
      return recover(e);
    }
  };
}
