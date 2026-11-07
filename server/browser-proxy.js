import { AppError } from "./store.js";

// Accept provider URLs, but separate credentials before storage/public responses.
export function normalizeBrowserProxy(value, previous = null) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("浏览器代理配置无效");
  let url, inlineUsername, inlinePassword;
  try {
    if (typeof value.server !== "string" || value.server.length > 2000)
      throw new Error();
    url = new URL(value.server.trim());
    if (
      !["http:", "https:", "socks5:"].includes(url.protocol) ||
      !url.hostname ||
      url.search ||
      url.hash ||
      (url.pathname && url.pathname !== "/")
    )
      throw new Error();
    inlineUsername = decodeURIComponent(url.username);
    inlinePassword = decodeURIComponent(url.password);
  } catch {
    throw new AppError(
      "请输入有效的 HTTP、HTTPS 或 SOCKS5 代理链接；不支持路径或查询参数，密码中的特殊字符请使用 URL 编码",
    );
  }
  const server = `${url.protocol}//${url.host}`;
  const inline = !!url.username || !!url.password;
  if (inline && (value.username || value.password))
    throw new AppError("请使用完整代理链接，不要重复提供认证信息");
  const credentials = inline ? { username: inlineUsername, password: inlinePassword } : value;
  for (const field of ["username", "password"]) {
    if (
      credentials[field] !== undefined &&
      (typeof credentials[field] !== "string" ||
        credentials[field].length > 1024 ||
        /[\x00-\x1f\x7f]/.test(credentials[field]))
    )
      throw new AppError("代理用户名或密码格式无效");
  }
  const username = credentials.username || "";
  let password = credentials.password || "";
  if (
    !inline && !password &&
    username &&
    previous?.server === server &&
    previous.username === username
  )
    password = previous.password || "";
  if (url.protocol === "socks5:" && (Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 255))
    throw new AppError("SOCKS5 用户名和密码分别不能超过 255 字节");
  if (url.protocol === "socks5:" && !url.port)
    throw new AppError("SOCKS5 代理链接需要填写端口");
  if (!!username !== !!password)
    throw new AppError(
      "请同时填写代理用户名和密码；更换代理地址或用户名后需重新填写密码",
    );
  return { server, username, password };
}

export function publicBrowserProxy(proxy) {
  return proxy
    ? {
        server: proxy.server,
        username: proxy.username,
        hasPassword: !!proxy.password,
      }
    : null;
}
