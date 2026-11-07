import { useEffect, useState } from "react";
import {
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  RefreshCw,
  Trash2,
  Save,
  Pencil,
  Check,
  X,
  ShieldCheck,
} from "lucide-react";
import {
  Modal,
  Status,
  ConfirmDialog,
  useDiscardConfirmation,
} from "./components";
import { useReauthGate } from "./ReauthPrompt";
import { api } from "./api";
import { PatBadge } from "./AccountCategories";
import { PatMetadata } from "./PatConfig";
import { accountTime, fullAccountTime } from './account-columns-model';
import {
  eligible,
  workbuddyOutcomeLabel,
  type Account,
  type Secrets,
  type OrganizationData,
  emptyOrganization,
} from "./types";

type SecretKey = "password" | "totp";
export function AccountDetail({
  account,
  checking,
  waiting = false,
  onClose,
  onUpdate,
  onSelect,
  onCheck,
  onTrash,
  notify,
  mode = "view",
  organization = emptyOrganization,
  onOrganize,
  onTask,
}: {
  onTask?: () => void;
  organization?: OrganizationData;
  onOrganize?: () => void;
  account: Account;
  checking: boolean;
  waiting?: boolean;
  onClose: () => void;
  onUpdate: () => Promise<void>;
  onSelect: (account: Account) => void;
  onCheck: (id: string) => Promise<void>;
  onTrash: (id: string) => void;
  notify: (message: string) => void;
  mode?: "view" | "edit";
}) {
  const isEdit = mode === "edit";
  const [form, setForm] = useState({
    email: account.email,
    username: account.username,
    notes: account.notes,
    password: "",
    totp: "",
  });
  const [editing, setEditing] = useState({ password: false, totp: false });
  const [visible, setVisible] = useState({ password: false, totp: false });
  const [secrets, setSecrets] = useState<Secrets | null>(null);
  const gate = useReauthGate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [now, setNow] = useState(Date.now());
  const [releasing, setReleasing] = useState(false);
  const dirty =
    isEdit &&
    (form.email !== account.email ||
      form.username !== account.username ||
      form.notes !== account.notes ||
      editing.password ||
      editing.totp);
  const { close, confirmation } = useDiscardConfirmation(dirty, busy, onClose);
  useEffect(() => {
    if (!secrets && !visible.password && !visible.totp) return;
    const hide = () => {
      setSecrets(null);
      setVisible({ password: false, totp: false });
    };
    const timer = setTimeout(hide, 30000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const onVisibility = () => {
      if (document.hidden) hide();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [secrets, visible.password, visible.totp]);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(""), 4000);
    return () => clearTimeout(timer);
  }, [feedback]);
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      await action();
    } catch (e) {
      const message = (e as Error).message;
      // Cancelling the step-up prompt is a deliberate choice, not an error.
      if (message && message !== "已取消") setError(message);
    } finally {
      setBusy(false);
    }
  }
  const read = () =>
    gate.ensure(() => api<Secrets>(`/accounts/${account.id}/secrets`, "POST"));
  function update(key: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  async function copy(key: "email" | "username" | SecretKey, label: string) {
    await act(async () => {
      const value =
        key === "email" || key === "username"
          ? isEdit
            ? form[key]
            : account[key]
          : editing[key]
            ? form[key]
            : (await read())[key];
      if (!value) throw new Error(`${label}为空，没有可复制的内容`);
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        throw new Error(
          "复制失败，请允许浏览器使用剪贴板，或显示内容后手动复制",
        );
      }
      setFeedback(`${label}已复制`);
    });
  }
  async function editSecret(key: SecretKey) {
    if (editing[key]) {
      setEditing((e) => ({ ...e, [key]: false }));
      update(key, "");
      setVisible((v) => ({ ...v, [key]: false }));
      return;
    }
    await act(async () => {
      const value = await read();
      update(key, value[key]);
      setEditing((e) => ({ ...e, [key]: true }));
    });
  }
  async function toggleSecret(key: SecretKey) {
    if (visible[key]) {
      setVisible((v) => ({ ...v, [key]: false }));
      return;
    }
    await act(async () => {
      if (!editing[key]) {
        setSecrets(await read());
        setNow(Date.now());
      }
      setVisible((v) => ({ ...v, [key]: true }));
    });
  }
  const seconds = secrets?.otp
    ? Math.max(0, Math.ceil((secrets.otp.expiresAt - now) / 1000))
    : 0;
  const task = account.taskSummary;
  const owner = task?.owner || (account.patDedicated ? 'pat' : account.selectedAt ? 'other' : 'unassigned');
  const ownerLabel = { unassigned: '未分配', workbuddy: 'WorkBuddy2api', pat: 'PAT 专用', other: '其他已分配' }[owner];
  const tags = organization.tags.filter(tag => account.tagIds?.includes(tag.id));
  return (
    <>
      <Modal
        title={isEdit ? "编辑账号" : "账号详情"}
        subtitle={
          isEdit
            ? "修改账号资料后保存；关闭前会提醒未保存的内容。"
            : undefined
        }
        onClose={close}
        className={`account-modal ${isEdit ? "account-edit-modal" : "account-view-modal"}`}
      >
        <div className="modal-body account-modal-body">
          <div className="account-overview">
            <div className="detail-identity">
              <div className="avatar large">
                {account.username.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <h3>{account.username}</h3>
                <a
                  href={`https://github.com/${account.username}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub 公开资料
                  <ExternalLink size={13} />
                </a>
              </div>
            </div>
            <div className="detail-status">
              {isEdit && <Status account={account} />}
              <PatBadge account={account} />
            </div>
          </div>
          <form
            id="account-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!isEdit || busy || !dirty) return;
              act(async () => {
                if (editing.password && !form.password.trim())
                  throw new Error("密码不能为空；不想修改时请点击“取消修改”");
                const row = await api<Account>(
                  `/accounts/${account.id}`,
                  "PATCH",
                  {
                    email: form.email,
                    username: form.username,
                    notes: form.notes,
                    ...(editing.password ? { password: form.password } : {}),
                    ...(editing.totp ? { totp: form.totp } : {}),
                  },
                );
                setForm({
                  email: row.email,
                  username: row.username,
                  notes: row.notes,
                  password: "",
                  totp: "",
                });
                setEditing({ password: false, totp: false });
                setVisible({ password: false, totp: false });
                setSecrets(null);
                await onUpdate();
                setFeedback("账号修改已保存");
                notify("账号修改已保存");
              });
            }}
          >
            <section className="editor-section detail-credentials" aria-label="账号与凭据">
              <div className="section-label">
                <h3>账号与凭据</h3>
                <span>显示的凭据会在 30 秒后隐藏</span>
              </div>
              <div className="editor-grid">
                {(
                  [
                    { key: "email", label: "邮箱", type: "email" },
                    { key: "username", label: "GitHub 用户名", type: "text" },
                  ] as const
                ).map((field) => (
                  <div className="editable-field" key={field.key}>
                    <label htmlFor={`detail-${field.key}`}>{field.label}</label>
                    <div className="input-actions">
                      <input
                        id={`detail-${field.key}`}
                        type={field.type}
                        required
                        value={isEdit ? form[field.key] : account[field.key]}
                        readOnly={!isEdit}
                        disabled={busy}
                        autoComplete={
                          field.key === "username" ? "username" : "email"
                        }
                        maxLength={field.key === "email" ? 254 : 39}
                        onChange={(e) => update(field.key, e.target.value)}
                      />
                      <button
                        type="button"
                        className="icon-button"
                        disabled={busy}
                        aria-label={`复制${field.label}`}
                        title={`复制${field.label}`}
                        onClick={() => copy(field.key, field.label)}
                      >
                        <Copy size={16} />
                      </button>
                    </div>
                  </div>
                ))}
                {(
                  [
                    { key: "password", label: "密码" },
                    { key: "totp", label: "TOTP 密钥" },
                  ] as const
                ).map((field) => (
                  <div
                    className={`editable-field ${editing[field.key] ? "editing" : ""}`}
                    key={field.key}
                  >
                    <div className="field-title">
                      <label htmlFor={`detail-${field.key}`}>
                        {field.label}
                      </label>
                      {isEdit && (
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() => editSecret(field.key)}
                        >
                          {editing[field.key] ? (
                            <X size={12} />
                          ) : (
                            <Pencil size={12} />
                          )}{" "}
                          {editing[field.key]
                            ? `取消修改${field.label}`
                            : `修改${field.label}`}
                        </button>
                      )}
                    </div>
                    <div className="input-actions">
                      <input
                        id={`detail-${field.key}`}
                        type={visible[field.key] ? "text" : "password"}
                        readOnly={!editing[field.key]}
                        disabled={busy}
                        value={
                          editing[field.key]
                            ? form[field.key]
                            : visible[field.key] && secrets
                              ? secrets[field.key]
                              : field.key === "totp" && !account.hasTotp
                                ? ""
                                : "••••••••••••"
                        }
                        autoComplete="new-password"
                        placeholder={
                          field.key === "totp" ? "未设置 TOTP 密钥" : ""
                        }
                        maxLength={field.key === "password" ? 1024 : 256}
                        onChange={(e) => update(field.key, e.target.value)}
                      />
                      <button
                        type="button"
                        className="icon-button"
                        disabled={busy}
                        aria-label={`${visible[field.key] ? "隐藏" : "显示"}${field.label}`}
                        title={`${visible[field.key] ? "隐藏" : "显示"}${field.label}`}
                        onClick={() => toggleSecret(field.key)}
                      >
                        {visible[field.key] ? (
                          <EyeOff size={16} />
                        ) : (
                          <Eye size={16} />
                        )}
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        disabled={
                          busy ||
                          (field.key === "totp" &&
                            !account.hasTotp &&
                            !editing.totp)
                        }
                        aria-label={`复制${field.label}`}
                        title={`复制${field.label}`}
                        onClick={() => copy(field.key, field.label)}
                      >
                        <Copy size={16} />
                      </button>
                    </div>
                    {editing[field.key] && <small>
                      {field.key === "totp"
                          ? "填入新密钥；留空并保存会移除已有密钥。"
                          : "修改后点击“保存修改”生效。"}
                    </small>}
                  </div>
                ))}
              </div>
              {!isEdit && (
                  <div className="detail-otp" aria-label="两步验证码">
                    <div className="section-label">
                      <h3>两步验证码</h3>
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy || !account.hasTotp}
                        onClick={() =>
                          act(async () => {
                            setSecrets(await read());
                            setNow(Date.now());
                          })
                        }
                      >
                        {secrets?.otp ? "刷新验证码" : "获取验证码"}
                      </button>
                    </div>
                    {secrets?.otp ? (
                      <div className="otp">
                        <strong>{seconds ? secrets.otp.code : "已过期"}</strong>
                        <span>{seconds ? `${seconds} 秒` : "点击刷新"}</span>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="复制验证码"
                          disabled={busy || seconds === 0}
                          onClick={() =>
                            act(async () => {
                              try {
                                await navigator.clipboard.writeText(secrets.otp!.code);
                              } catch {
                                throw new Error("复制失败，请允许浏览器使用剪贴板，或手动复制验证码");
                              }
                              setFeedback("验证码已复制");
                            })
                          }
                        >
                          <Copy size={16} />
                        </button>
                      </div>
                    ) : (
                      <p className="muted small">
                        {account.hasTotp
                          ? "点击获取当前验证码"
                          : "未设置 TOTP 密钥"}
                      </p>
                    )}
                  </div>
              )}
            </section>
            <div className="detail-secondary">
              {!isEdit && (
                <section className="detail-check" aria-label="活性检查">
                  <div className="detail-check-summary">
                    <div className="detail-check-title"><ShieldCheck size={16}/><h3>活性检查</h3><Status account={account}/></div>
                    <small title={fullAccountTime(account.checkedAt)}>最近检查：{accountTime(account.checkedAt)}</small>
                    <button type="button" className="button small-button" disabled={busy || checking}
                      onClick={() => act(async () => { await onCheck(account.id); setFeedback("检查任务已启动，结果将自动更新"); })}>
                      <RefreshCw size={14} className={checking && !waiting ? "spin" : ""}/>
                      {waiting ? "等待额度恢复" : checking ? "队列检查中" : "检查此账号"}
                    </button>
                  </div>
                  <p className="detail-check-message">{account.checkMessage || "仅检测 GitHub 公开状态，不代表没有登录限制或风控。"}</p>
                </section>
              )}
              <div className={`detail-metadata ${!isEdit && !account.notes ? 'without-notes' : ''}`}>
                <section className="editor-section account-organization-detail">
                  <div className="section-label"><h3>分组与标签</h3>{onOrganize && <button type="button" className="text-button" disabled={busy || dirty} title={dirty ? '请先保存账号修改' : undefined} onClick={onOrganize}>整理分类</button>}</div>
                  <div className="detail-classification"><span className="detail-group">{organization.groups.find(g=>g.id===account.groupId)?.name || '未分组'}</span>{tags.map(tag=><span className={`user-tag tag-${tag.color || 'blue'}`} key={tag.id}>{tag.name}</span>)}</div>
                </section>
                {(isEdit || account.notes) && <section className="editor-section detail-notes">
                  <h3>备注</h3>
                  {isEdit ? <div className="field"><textarea aria-label="备注" rows={3} maxLength={2000} disabled={busy} value={form.notes} onChange={e=>update("notes",e.target.value)} placeholder="账号来源、用途，或需要留意的情况"/></div> : <p className="readonly-notes">{account.notes}</p>}
                </section>}
              </div>
            </div>
          </form>
          {!isEdit && account.patDedicated ? <section className="editor-section pat-detail"><h3>PAT 专用 · 只读信息</h3>{account.pat ? <PatMetadata record={account.pat}/> : <p>专用用途保留，暂无可展示的 PAT 记录。</p>}<p className="muted small">PAT 专用只代表账号用途，不代表已取得 Token。补充、继续与停用请前往侧栏「PAT 管理」。</p></section> : null}
          {!isEdit && <section className="detail-task" aria-label="任务归属">
            <div className="detail-task-main">
              <div className="detail-task-identity"><h3>任务归属</h3><strong>{ownerLabel}</strong>{task?.label && task.label !== ownerLabel && <span>{task.label}</span>}</div>
              <div className="detail-task-actions">
                {onTask && (owner === 'pat' || task?.workbuddyJobId) && <button type="button" className="text-button" onClick={onTask}>查看对应任务<ExternalLink size={13}/></button>}
                {account.selectedAt ? <button type="button" className="button small-button" disabled={busy} onClick={()=>setReleasing(true)}>释放标记</button>
                  : !account.patDedicated && <button type="button" className="button small-button" disabled={busy || !eligible(account)} title="需已保存 TOTP 密钥、最近 24 小时公开可访问且尚未选用" onClick={()=>onSelect(account)}>选用此账号</button>}
              </div>
            </div>
            {account.selectedAt && <p className="detail-task-description">{account.purpose || "未填写用途"} · {accountTime(account.selectedAt)}（北京时间）</p>}
            {task?.message && owner !== 'unassigned' && (owner !== 'other' || task.state === 'unknown') && <p className="detail-task-description">{task.message}</p>}
            {task?.conflict && <p className="inline-warning">用途存在冲突，请核对关联及占用记录。</p>}
            {account.workbuddyResult && <div className="detail-workbuddy-result"><strong>WorkBuddy · {workbuddyOutcomeLabel(account.workbuddyResult.status)}</strong><p>{account.workbuddyResult.message}</p></div>}
            <div className="detail-times">
              <span title={fullAccountTime(account.createdAt)}>入库时间：{accountTime(account.createdAt)}</span>
              {task?.workbuddyFinishedAt && <span title={fullAccountTime(task.workbuddyFinishedAt)}>WorkBuddy 结束：{accountTime(task.workbuddyFinishedAt)}</span>}
              {task?.workbuddyRegisteredAt && <span>外部登记时间（北京时间）：{accountTime(task.workbuddyRegisteredAt)}</span>}
              <span className="detail-timezone">北京时间</span>
            </div>
            {!!task?.workbuddyLinks.length && <div className="task-links"><h4>WorkBuddy 成功关联</h4>{task.workbuddyLinks.map(link=><p key={link.targetId}><strong>{link.targetName}</strong><time title={fullAccountTime(link.createdAt)}>{accountTime(link.createdAt)}</time></p>)}</div>}
          </section>}
        </div>
        <div className="dialog-feedback" aria-live="polite" hidden={!isEdit && !error && !feedback}>
          {error ? (
            <span className="form-error" role="alert">
              {error}
            </span>
          ) : feedback ? (
            <span className="form-success">
              <Check size={15} />
              {feedback}
            </span>
          ) : (
            <span className="muted">
              {dirty
                ? "有未保存的修改"
                : isEdit
                  ? "密码和密钥需先点“修改”，未修改的字段会保留。"
                  : "资料为只读，点击右侧图标即可复制。"}
            </span>
          )}
        </div>
        <footer className="modal-footer">
          {isEdit ? (
            <span className="muted small">修改后需保存才会生效</span>
          ) : (
            <button
              className="button danger-quiet"
              disabled={busy}
              onClick={() => onTrash(account.id)}
            >
              <Trash2 size={15} />
              移入回收站
            </button>
          )}
          <div className="footer-actions">
            <button className="button" disabled={busy} onClick={close}>
              关闭
            </button>
            {isEdit && (
              <button
                className="button primary"
                disabled={busy || !dirty}
                type="submit"
                form="account-form"
              >
                <Save size={15} />
                {busy ? "处理中…" : "保存修改"}
              </button>
            )}
          </div>
        </footer>
      </Modal>
      {confirmation}
      {releasing && (
        <ConfirmDialog
          title="释放这个账号的选用标记？"
          description={`@${account.username} 的当前用途和选用时间将被清除。释放后，这个账号可能再次被自动选用。`}
          cancelLabel="保留标记"
          confirmLabel="确认释放"
          onCancel={() => setReleasing(false)}
          onConfirm={() => {
            setReleasing(false);
            act(async () => {
              await api(`/accounts/${account.id}/release`, "POST");
              await onUpdate();
              setFeedback("选用标记已释放");
            });
          }}
        />
      )}
      {gate.element}
    </>
  );
}
