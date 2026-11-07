import { useContext, useRef, useState } from "react";
import { LogOut, UserRound } from "lucide-react";
import { AuthContext, type AuthState } from "./auth-context";
import { api } from "./api";
import { Modal, useDiscardConfirmation } from "./components";

export function AdminSession() {
  const auth = useContext(AuthContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  if (!auth) return null;
  return (
    <div className="admin-session">
      <span className="admin-name">
        <UserRound size={14} />
        {auth.state.username}
      </span>
      <button
        className="icon-button"
        aria-label="退出登录"
        title="退出登录"
        disabled={busy}
        onClick={async () => {
          if (pending.current) return;
          pending.current = true;
          setBusy(true);
          setError("");
          try {
            await api("/auth/logout", "POST", {});
            auth.install({ initialized: true, authenticated: false });
          } catch (e) {
            setError((e as Error).message);
            await auth.refresh();
          } finally {
            pending.current = false;
            setBusy(false);
          }
        }}
      >
        <LogOut size={16} />
      </button>
      {error && (
        <span role="alert" className="inline-error">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Shared with the security centre so password changes live next to the rest of
 * the login settings instead of occupying its own icon in the top bar.
 */
export function PasswordEditor({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (value: AuthState) => void;
}) {
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const { close, confirmation: discard } = useDiscardConfirmation(
    !!(currentPassword || newPassword || confirmation),
    busy,
    onClose,
  );
  return (
    <>
      <Modal title="修改登录密码" className="password-editor" onClose={close}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (pending.current) return;
            setError("");
            if (newPassword !== confirmation) {
              setError("两次输入的新密码不一致");
              return;
            }
            pending.current = true;
            setBusy(true);
            try {
              onSaved(
                await api<AuthState>("/auth/password", "POST", {
                  currentPassword,
                  newPassword,
                }),
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              pending.current = false;
              setBusy(false);
            }
          }}
        >
          <div className="modal-body">
            <label className="field">
              当前密码
              <input
                data-autofocus
                required
                type="password"
                autoComplete="current-password"
                maxLength={128}
                value={currentPassword}
                disabled={busy}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </label>
            <label className="field">
              新密码
              <input
                required
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                value={newPassword}
                disabled={busy}
                onChange={(e) => setNew(e.target.value)}
              />
            </label>
            <label className="field">
              确认新密码
              <input
                required
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                value={confirmation}
                disabled={busy}
                onChange={(e) => setConfirmation(e.target.value)}
              />
            </label>
            <p className="auth-field-help">12–128 个字符。保存后，其他登录会话会失效。</p>
            {error && (
              <p role="alert" className="inline-error">
                {error}
              </p>
            )}
          </div>
          <footer className="modal-footer">
            <button type="button" className="button" disabled={busy} onClick={close}>
              取消
            </button>
            <button className="button primary" disabled={busy}>
              {busy ? "保存中…" : "保存密码"}
            </button>
          </footer>
        </form>
      </Modal>
      {discard}
    </>
  );
}
