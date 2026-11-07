import { useState } from "react";
import { Plus, Eye, EyeOff } from "lucide-react";
import { Modal, useDiscardConfirmation } from "./components";
import { api } from "./api";
import { emptyOrganization, type Account, type OrganizationData } from "./types";
import { OrganizationFields } from "./Organization";

export function CreateAccount({
  onClose,
  onCreated,
  organization = emptyOrganization,
}: {
  organization?: OrganizationData;
  onClose: () => void;
  onCreated: (account: Account) => void;
}) {
  const [form, setForm] = useState({
    email: "",
    username: "",
    password: "",
    totp: "",
    notes: "",
  });
  const [show, setShow] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [groupId, setGroupId] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const { close, confirmation } = useDiscardConfirmation(
    Object.values(form).some(Boolean) || !!groupId || !!tagIds.length,
    busy,
    onClose,
  );
  return (
    <>
      <Modal
        title="新增账号"
        subtitle="填写一个账号的资料；多个账号可使用批量导入。"
        onClose={close}
        wide
      >
        <form
          className="create-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              onCreated(await api<Account>("/accounts", "POST", {...form, groupId: groupId || null, tagIds}));
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="modal-body">
            <OrganizationFields data={organization} groupId={groupId} tagIds={tagIds} onGroup={setGroupId} onTags={setTagIds} disabled={busy}/>
            <div className="editor-grid">
              <label className="field">
                邮箱 *
                <input
                  type="email"
                  required
                  maxLength={254}
                  disabled={busy}
                  autoComplete="email"
                  value={form.email}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, email: e.target.value }))
                  }
                  placeholder="name@example.com"
                />
              </label>
              <label className="field">
                GitHub 用户名 *
                <input
                  required
                  maxLength={39}
                  disabled={busy}
                  autoComplete="username"
                  value={form.username}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, username: e.target.value }))
                  }
                  placeholder="GitHub 用户名"
                />
              </label>
              <div className="field">
                <label htmlFor="new-password">密码 *</label>
                <div className="input-actions">
                  <input
                    id="new-password"
                    type={show ? "text" : "password"}
                    required
                    maxLength={1024}
                    disabled={busy}
                    autoComplete="new-password"
                    value={form.password}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, password: e.target.value }))
                    }
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={show ? "隐藏新账号密码" : "显示新账号密码"}
                    onClick={() => setShow(!show)}
                  >
                    {show ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <label className="field">
                TOTP 密钥（选填）
                <input
                  type="password"
                  disabled={busy}
                  autoComplete="new-password"
                  maxLength={256}
                  value={form.totp}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, totp: e.target.value }))
                  }
                  placeholder="没有密钥可留空"
                />
              </label>
            </div>
            <label className="field">
              备注
              <textarea
                rows={3}
                maxLength={2000}
                disabled={busy}
                value={form.notes}
                onChange={(e) =>
                  setForm((f) => ({ ...f, notes: e.target.value }))
                }
                placeholder="账号来源、用途等"
              />
            </label>
            <p className="muted small">
              新增后可以单独检查活性，或在列表中检查全部账号。
            </p>
            {error && (
              <p role="alert" className="inline-error">
                {error}
              </p>
            )}
          </div>
          <footer className="modal-footer">
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={close}
            >
              取消
            </button>
            <button className="button primary" type="submit" disabled={busy}>
              <Plus size={16} />
              {busy ? "正在保存…" : "保存账号"}
            </button>
          </footer>
        </form>
      </Modal>
      {confirmation}
    </>
  );
}
