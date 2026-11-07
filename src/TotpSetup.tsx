import { useEffect, useRef, useState } from "react";
import { Check, Copy, KeyRound, RefreshCw, ShieldCheck, ShieldOff } from "lucide-react";
import { Modal } from "./components";
import { api } from "./api";
import { QrCode } from "./QrCode";

const groups = (value: string, size: number) =>
  (value.match(new RegExp(`.{1,${size}}`, "g")) || []).join(" ");

/**
 * Enable or disable the optional second factor. Enabling is staged: the secret
 * is only written as "enabled" after a working code proves the app is set up,
 * so an interrupted setup can never lock the operator out.
 */
export function TotpSetup({
  enabled,
  onClose,
  onChanged,
}: {
  enabled: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [stage, setStage] = useState<"loading" | "scan" | "codes" | "disable">(
    "loading",
  );
  const [secret, setSecret] = useState("");
  const [uri, setUri] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const pending = useRef(false);

  useEffect(() => {
    if (enabled) {
      setStage("disable");
      return;
    }
    let live = true;
    api<{ secret: string; uri: string }>("/auth/totp/setup", "POST")
      .then(result => {
        if (!live) return;
        setSecret(result.secret);
        setUri(result.uri);
        setStage("scan");
      })
      .catch(failure => {
        if (!live) return;
        setError((failure as Error).message);
        setStage("scan");
      });
    return () => {
      live = false;
    };
  }, [enabled]);

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(""), 1600);
    } catch {
      setError("复制失败，请手动选中后复制");
    }
  }

  async function confirm() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (stage === "disable") {
        await api("/auth/totp/disable", "POST", { password, code: code.trim() });
        onChanged();
        onClose();
        return;
      }
      const result = await api<{ recoveryCodes: string[] }>(
        "/auth/totp/enable",
        "POST",
        { code: code.trim() },
      );
      setCodes(result.recoveryCodes);
      setStage("codes");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  if (stage === "codes")
    return (
      <Modal
        title="两步验证已启用"
        subtitle="请立刻保存这些恢复码，离开后无法再次查看"
        className="totp-setup"
        onClose={() => {
          onChanged();
          onClose();
        }}
      >
        <div className="modal-body totp-body">
          <p className="totp-note">
            <ShieldCheck size={15} />
            手机丢失或换机时，每个恢复码可代替一次动态码登录。
          </p>
          <ul className="totp-codes">
            {codes.map(item => (
              <li key={item}>{groups(item, 5)}</li>
            ))}
          </ul>
          <button
            type="button"
            className="button"
            onClick={() => void copy(codes.join("\n"), "恢复码")}
          >
            {copied === "恢复码" ? <Check size={16} /> : <Copy size={16} />}
            {copied === "恢复码" ? "已复制" : "复制全部恢复码"}
          </button>
        </div>
        <footer className="modal-footer">
          <button
            type="button"
            className="button primary"
            onClick={() => {
              onChanged();
              onClose();
            }}
          >
            我已保存
          </button>
        </footer>
      </Modal>
    );

  return (
    <Modal
      title={enabled ? "关闭两步验证" : "启用两步验证"}
      subtitle={
        enabled
          ? "关闭后登录只需要密码"
          : "用验证器 App 扫描或手动添加下面的密钥"
      }
      className="totp-setup"
      onClose={onClose}
    >
      <form
        onSubmit={event => {
          event.preventDefault();
          void confirm();
        }}
      >
        <div className="modal-body totp-body">
          {stage === "loading" && <p role="status">正在生成密钥…</p>}
          {!enabled && stage !== "loading" && (
            <>
              <div className="totp-pair">
                <div className="totp-scan">
                  <QrCode value={uri} size={168} />
                  <span className="totp-scan-hint">用验证器 App 扫码</span>
                </div>
                <div className="totp-manual">
                  <span className="totp-secret-label">或手动输入密钥</span>
                  <div className="totp-secret">
                    <code>{groups(secret, 4) || "—"}</code>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="复制密钥"
                      title="复制密钥"
                      onClick={() => void copy(secret, "密钥")}
                    >
                      {copied === "密钥" ? <Check size={16} /> : <Copy size={16} />}
                    </button>
                  </div>
                  <p className="totp-hint">
                    Google Authenticator、1Password、Microsoft Authenticator 等选择「手动输入」，
                    账号名可填 <code>Account Desk</code>。
                  </p>
                </div>
              </div>
              <details className="totp-uri">
                <summary>这个 otpauth 链接是什么？</summary>
                <p>
                  它是验证器 App 通用的配置格式：二维码里画的就是这段文字，扫码等于把它读进去。
                  链接里的 <code>secret</code> 就是密钥本身，拿到它等于拿到第二因素，不要发到聊天工具或截图外传。
                  只能复制文本的环境（例如远程终端里的验证器）可以复制整段粘进去，效果与扫码相同。
                </p>
                <button
                  type="button"
                  className="security-action"
                  onClick={() => void copy(uri, "链接")}
                >
                  {copied === "链接" ? <Check size={13} /> : <Copy size={13} />}
                  {copied === "链接" ? "已复制" : "复制链接"}
                </button>
              </details>
            </>
          )}
          {enabled && (
            <p className="totp-hint">
              关闭后登录只校验密码。如果要继续保留保护，请直接关闭此窗口。
            </p>
          )}
          {enabled && (
            <label className="field">
              登录密码
              <input
                type="password"
                required
                autoComplete="current-password"
                maxLength={128}
                value={password}
                disabled={busy}
                onChange={event => setPassword(event.target.value)}
              />
            </label>
          )}
          <label className="field">
            {enabled ? "当前动态验证码或恢复码" : "验证器显示的 6 位数字"}
            <input
              required
              spellCheck={false}
              autoComplete="one-time-code"
              inputMode={enabled ? "text" : "numeric"}
              maxLength={12}
              placeholder="6 位动态码"
              value={code}
              disabled={busy}
              onChange={event => setCode(event.target.value)}
            />
          </label>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={busy || stage === "loading"}>
            {busy ? <RefreshCw size={16} className="spin" /> : enabled ? <ShieldOff size={16} /> : <KeyRound size={16} />}
            <span>{busy ? "处理中…" : enabled ? "确认关闭" : "验证并启用"}</span>
          </button>
        </footer>
      </form>
    </Modal>
  );
}
