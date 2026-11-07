import { useRef, useState } from "react";
import {
  Upload,
  FileText,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
} from "lucide-react";
import { Modal, useDiscardConfirmation } from "./components";
import { api } from "./api";
import { emptyOrganization, type Preview, type OrganizationData } from "./types";
import { OrganizationFields } from "./Organization";

export function ImportDialog({
  onClose,
  onComplete,
  organization = emptyOrganization,
}: {
  organization?: OrganizationData;
  onClose: () => void;
  onComplete: (message: string) => void;
}) {
  const [text, setText] = useState("");
  const [groupId, setGroupId] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const valid = preview?.records.filter((r) => !r.duplicate).length || 0;
  const duplicates = preview?.records.filter((r) => r.duplicate).length || 0;
  const { close, confirmation } = useDiscardConfirmation(
    Boolean(text || groupId || tagIds.length),
    busy,
    onClose,
    true,
  );
  async function inspect() {
    setBusy(true);
    setError("");
    try {
      setPreview(await api<Preview>("/import/preview", "POST", { text }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{
        imported: number;
        duplicates: number;
        errors: unknown[];
      }>("/import", "POST", { text, groupId: groupId || null, tagIds });
      onComplete(
        `已导入 ${result.imported} 个账号，跳过 ${result.duplicates} 个重复账号、${result.errors.length} 行无效内容`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Modal
        title="导入 GitHub 账号"
        subtitle="把分散的账号，整理到一个地方。"
        onClose={close}
        wide
      >
        <div className="modal-body">
          <OrganizationFields data={organization} groupId={groupId} tagIds={tagIds} onGroup={setGroupId} onTags={setTagIds} disabled={busy}/>
          <div className="format-box">
            <FileText size={20} />
            <div>
              <strong>一行一个账号，以四个短横线分隔</strong>
              <code>邮箱----密码----用户名----TOTP密钥</code>
              <p>TOTP 密钥可省略；密码中的空格会保留。最多 1000 行。</p>
            </div>
          </div>
          {!preview ? (
            <>
              <div className="label-row">
                <label htmlFor="import-text">账号内容</label>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => input.current?.click()}
                >
                  <Upload size={15} />
                  读取 TXT 文件
                </button>
              </div>
              <input
                ref={input}
                type="file"
                accept=".txt,text/plain"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 1024 * 1024) {
                    setError("文件超过 1 MB，请分批导入");
                    return;
                  }
                  try {
                    setText(await file.text());
                    setError("");
                  } catch {
                    setError("无法读取文件，请重新选择");
                  }
                  e.target.value = "";
                }}
              />
              <textarea
                id="import-text"
                className="import-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  "name@example.com----password----username----JBSWY3DPEHPK3PXP\nname2@example.com----password----username2"
                }
                spellCheck={false}
                autoComplete="off"
              />
              <p className="muted small">
                重复邮箱或用户名会跳过，不会覆盖已有资料。下一步可预览校验结果。
              </p>
            </>
          ) : (
            <>
              <div className="preview-summary">
                <span>
                  <CheckCircle2 size={17} />
                  <strong>{valid}</strong> 可导入
                </span>
                <span>{duplicates} 个重复</span>
                <span>{preview.errors.length} 行无效</span>
              </div>
              <div className="preview-list">
                {preview.records.map((r) => (
                  <div className="preview-row" key={r.line}>
                    <span className="line-number">{r.line}</span>
                    <div>
                      <strong>{r.username}</strong>
                      <small>{r.email}</small>
                    </div>
                    <span
                      className={`badge ${r.duplicate ? "unchecked" : "reachable"}`}
                    >
                      {r.duplicate
                        ? "重复 · 跳过"
                        : r.hasTotp
                          ? "含 TOTP"
                          : "无 TOTP"}
                    </span>
                  </div>
                ))}
                {preview.errors.map((e) => (
                  <div className="inline-error" key={e.line}>
                    <CircleAlert size={16} />第 {e.line} 行：{e.message}
                  </div>
                ))}
                {!preview.records.length && !preview.errors.length && (
                  <p className="muted">未发现账号内容，请返回编辑。</p>
                )}
              </div>
              <p className="muted small">
                仅导入校验通过的非重复账号。无效行和重复账号会跳过。
              </p>
            </>
          )}
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
        </div>
        <footer className="modal-footer">
          <button
            className="button"
            disabled={busy}
            onClick={
              preview
                ? () => {
                    setPreview(null);
                    setError("");
                  }
                : close
            }
          >
            {preview ? "返回编辑" : "取消"}
          </button>
          <button
            className="button primary"
            disabled={busy || (preview ? !valid : !text.trim())}
            onClick={preview ? submit : inspect}
          >
            {busy ? "处理中…" : preview ? `导入 ${valid} 个账号` : "预览并校验"}
            <ArrowRight size={16} />
          </button>
        </footer>
      </Modal>
      {confirmation}
    </>
  );
}
