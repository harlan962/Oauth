export function normalizeSecret(value) {
  return value.replace(/\s/g, "").toUpperCase().replace(/=+$/, "");
}

export function validateAccount({ email, username, password, totp = "" }) {
  if (
    typeof email !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254
  )
    return "邮箱格式不正确";
  if (
    typeof username !== "string" ||
    !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username) ||
    username.includes("--")
  )
    return "GitHub 用户名格式不正确";
  if (
    typeof password !== "string" ||
    !password.trim() ||
    password.length > 1024
  )
    return "密码不能为空，且不得超过 1024 个字符";
  if (
    typeof totp !== "string" ||
    (totp &&
      (!/^[A-Z2-7]{16,128}$/.test(totp) ||
        ![0, 2, 4, 5, 7].includes(totp.length % 8)))
  )
    return "TOTP 需要有效的 Base32 密钥（非验证码），也可以留空";
  return null;
}

export function parseImport(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024)
    throw new Error("导入内容不得超过 1 MB");
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.filter((l) => l.trim()).length > 1000)
    throw new Error("每次最多导入 1000 行");
  const records = [],
    errors = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const parts = line.split("----");
    if (parts.length < 3 || parts.length > 4) {
      errors.push({
        line: index + 1,
        message: "需要 3 或 4 个字段，以 ---- 分隔",
      });
      return;
    }
    const record = {
      email: parts[0].trim(),
      password: parts[1],
      username: parts[2].trim(),
      totp: normalizeSecret(parts[3] || ""),
      line: index + 1,
    };
    const error = validateAccount(record);
    if (error) errors.push({ line: index + 1, message: error });
    else records.push(record);
  });
  return { records, errors };
}
