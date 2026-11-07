import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, EyeOff, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";
import { Modal } from "./components";
import { api, setReauthToken, type ApiFailure } from "./api";

/**
 * Step-up prompt for the endpoints that return plaintext passwords and TOTP
 * seeds. The grant lasts five minutes and is bound to the current session, so
 * it cannot be reused from another browser.
 */
export function ReauthPrompt({
  onCancel,
  onGranted,
}: {
  onCancel: () => void;
  onGranted: () => void;
}) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [reveal, setReveal] = useState(false);
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);

  useEffect(() => {
    let live = true;
    api<{ totpEnabled?: boolean }>("/auth/status")
      .then(state => live && setTotpEnabled(!!state.totpEnabled))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const grant = await api<{ token: string }>("/auth/reauth", "POST", {
        password,
        ...(totpEnabled ? { code } : {}),
      });
      setReauthToken(grant.token);
      onGranted();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    } finally {
      pending.current = false;
    }
  }

  return (
    <Modal
      title="确认身份"
      subtitle="明文密码与 TOTP 密钥需要重新验证后才能查看"
      className="reauth-prompt"
      onClose={onCancel}
    >
      <form onSubmit={submit}>
        <div className="modal-body reauth-body">
          <p className="reauth-hint">
            <ShieldCheck size={15} />
            确认后 5 分钟内可查看或导出，仅在当前窗口有效。
          </p>
          <label className="field">
            登录密码
            <span className="input-actions">
              <input
                type={reveal ? "text" : "password"}
                autoComplete="current-password"
                required
                maxLength={128}
                value={password}
                disabled={busy}
                onChange={event => setPassword(event.target.value)}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={reveal ? "隐藏密码" : "显示密码"}
                aria-pressed={reveal}
                title={reveal ? "隐藏密码" : "显示密码"}
                onClick={() => setReveal(value => !value)}
              >
                {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </span>
          </label>
          {totpEnabled && (
            <label className="field">
              验证码
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                maxLength={6}
                pattern="[0-9]{6}"
                placeholder="6 位动态验证码"
                value={code}
                disabled={busy}
                onChange={event => setCode(event.target.value.replace(/\D/g, ""))}
              />
            </label>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={busy} data-autofocus>
            {busy ? <RefreshCw size={16} className="spin" /> : <LockKeyhole size={16} />}
            <span>{busy ? "验证中…" : "确认"}</span>
          </button>
        </footer>
      </form>
    </Modal>
  );
}

type Waiter = { resolve: () => void; reject: (error: Error) => void };

/**
 * Wraps a credential call: if the server answers REAUTH_REQUIRED, the prompt
 * opens and the same action is replayed once the user confirms. Callers keep
 * writing `await gate.ensure(() => api(...))` and need no other changes.
 */
export function useReauthGate() {
  const [open, setOpen] = useState(false);
  const waiter = useRef<Waiter | null>(null);

  const ensure = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (failure) {
      if ((failure as ApiFailure).code !== "REAUTH_REQUIRED") throw failure;
      await new Promise<void>((resolve, reject) => {
        waiter.current = { resolve, reject };
        setOpen(true);
      });
      return action();
    }
  }, []);

  const finish = (confirmed: boolean) => {
    setOpen(false);
    const pending = waiter.current;
    waiter.current = null;
    if (!pending) return;
    if (confirmed) pending.resolve();
    else pending.reject(new Error("已取消"));
  };

  const element = open ? (
    <ReauthPrompt onCancel={() => finish(false)} onGranted={() => finish(true)} />
  ) : null;

  return { ensure, element };
}
