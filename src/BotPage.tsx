import { useState } from "react";
import { Bot, Check, Copy, Pencil, Plus, Power, RefreshCw, Trash2, X } from "lucide-react";
import { api } from "./api";
import { date } from "./types";
import { Modal, ConfirmDialog } from "./components";
import { Switch } from "./Switch";
import { localOrigin, useBotData, type BotRow } from "./bot-data";

type Draft = {
  id?: string;
  platform: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
};

const emptyDraft = (platform: string): Draft => ({
  platform,
  name: "",
  enabled: true,
  config: {},
});

/**
 * Bots only: which groups can ask this desk a question, and the address they
 * use to reach it. The commands they understand and the transcript live on
 * their own pages, because nobody reads all three at the same time.
 */
export function BotPage({
  notify,
  onChanged,
}: {
  notify: (message: string) => void;
  onChanged?: () => void;
}) {
  const { data, setData, loading, error, setError, load } = useBotData(1);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<BotRow | null>(null);
  const [rotating, setRotating] = useState<BotRow | null>(null);
  const [copied, setCopied] = useState("");

  const platforms = data?.platforms || [];
  const platformOf = (id: string) => platforms.find((item) => item.id === id);
  const bots = data?.bots || [];
  const enabled = bots.filter((item) => item.enabled).length;

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(""), 1600);
    } catch {
      setError("浏览器不允许写入剪贴板，请手动复制");
    }
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        platform: draft.platform,
        name: draft.name.trim() || platformOf(draft.platform)?.label || "机器人",
        enabled: draft.enabled,
        config: draft.config,
      };
      if (draft.id) await api(`/bot/${draft.id}`, "PATCH", body);
      else await api("/bot", "POST", body);
      setDraft(null);
      notify(draft.id ? "机器人已更新" : "机器人已创建，回调地址可以复制了");
      await load();
      onChanged?.();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(bot: BotRow) {
    const next = !bot.enabled;
    setError("");
    // Same rule as the push channels: the switch moves first, the request
    // confirms it. A switch that waits for the network feels broken.
    setData((current) =>
      current
        ? { ...current, bots: current.bots.map((item) => (item.id === bot.id ? { ...item, enabled: next } : item)) }
        : current,
    );
    try {
      await api(`/bot/${bot.id}`, "PATCH", { enabled: next });
      await load();
      onChanged?.();
    } catch (failure) {
      setData((current) =>
        current
          ? { ...current, bots: current.bots.map((item) => (item.id === bot.id ? { ...item, enabled: !next } : item)) }
          : current,
      );
      setError((failure as Error).message);
    }
  }

  async function rotate() {
    if (!rotating) return;
    setBusy(true);
    try {
      const result = await api<BotRow>(`/bot/${rotating.id}/rotate`, "POST", {});
      setRotating(null);
      notify("回调地址已更换，旧地址立即失效");
      setData((current) =>
        current ? { ...current, bots: current.bots.map((item) => (item.id === result.id ? result : item)) } : current,
      );
      await load();
      onChanged?.();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await api(`/bot/${removing.id}`, "DELETE");
      notify(`已删除「${removing.name}」`);
      setRemoving(null);
      await load();
      onChanged?.();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="notify-page">
      <div className="security-summary">
        <section className="security-stat">
          <span className="security-stat-label">
            <Bot size={14} />
            机器人
          </span>
          <strong className="security-stat-value">{loading ? "—" : bots.length}</strong>
          <span className="security-stat-note">{loading ? "正在读取…" : "接入钉钉、飞书或自建群"}</span>
        </section>
        <section className="security-stat">
          <span className="security-stat-label">
            <Power size={14} />
            接收中
          </span>
          <strong className={`security-stat-value${enabled ? " is-ok" : ""}`}>{loading ? "—" : enabled}</strong>
          <span className="security-stat-note">{loading ? "正在读取…" : "开关打开才会回应群里"}</span>
        </section>
        <section className={`security-stat${bots.length - enabled ? " is-warn" : ""}`}>
          <span className="security-stat-label">
            <X size={14} />
            已停用
          </span>
          <strong className={`security-stat-value${bots.length - enabled ? " is-warn" : " is-ok"}`}>
            {loading ? "—" : bots.length - enabled}
          </strong>
          <span className="security-stat-note">停用后回调地址立即失效</span>
        </section>
      </div>

      {error && (
        <p role="alert" className="inline-error security-error">
          {error}
          <button type="button" className="text-button" onClick={() => void load()}>
            重试
          </button>
        </p>
      )}

      <section className="security-card">
        <header className="security-card-head">
          <div>
            <Bot size={16} />
            <h2>机器人</h2>
            <span className="security-count">{bots.length}</span>
          </div>
          <div className="security-head-actions">
            <button
              type="button"
              className="icon-button"
              aria-label="刷新"
              title="刷新"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw size={16} />
            </button>
            <button type="button" className="button primary" onClick={() => setDraft(emptyDraft("dingtalk"))}>
              <Plus size={16} />
              添加机器人
            </button>
          </div>
        </header>

        {data && localOrigin(data.publicOrigin) && (
          <p className="bot-warning">
            <X size={13} />
            接口地址仍是本机回环（{data.publicOrigin}）。钉钉和飞书的服务器访问不到 127.0.0.1，
            需要先在 <code>ACCOUNT_DESK_API_ORIGIN</code> 配一个公网 HTTPS 域名，回调地址才会通。
          </p>
        )}

        {!bots.length && !loading ? (
          <div className="notify-empty">
            <p>
              机器人让你在群里问一句「状态」，不用打开工作台。选一个平台，把回调地址填到群里，
              打开开关就开始接收指令。
            </p>
            <div className="notify-presets">
              {platforms.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="notify-preset"
                  onClick={() => setDraft(emptyDraft(item.id))}
                >
                  <Bot size={16} />
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ul className="channel-grid bot-grid">
            {bots.map((bot) => {
              const hook = `${data?.hookBase || ""}/${bot.token}`;
              return (
                <li key={bot.id} className={`channel-card${bot.enabled ? "" : " is-off"}`}>
                  <header className="channel-card-head">
                    <span className="channel-icon" aria-hidden="true">
                      <Bot size={16} />
                    </span>
                    <div className="channel-card-title">
                      <strong>{bot.name}</strong>
                      <span className="channel-card-type">
                        {platformOf(bot.platform)?.label || bot.platform} · {bot.enabled ? "接收中" : "已停用"}
                      </span>
                    </div>
                    <Switch
                      checked={bot.enabled}
                      label={bot.enabled ? `停用「${bot.name}」` : `启用「${bot.name}」`}
                      onChange={() => void toggle(bot)}
                    />
                  </header>

                  <div className="bot-hook">
                    <code title={hook}>{hook}</code>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="复制回调地址"
                      title="复制回调地址"
                      onClick={() => void copy(hook, bot.id)}
                    >
                      {copied === bot.id ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>

                  {bot.lastError ? (
                    <p className="channel-error">
                      <X size={12} />
                      {bot.lastError}
                      {bot.lastErrorAt && <span className="channel-error-at">{date(bot.lastErrorAt)}</span>}
                    </p>
                  ) : (
                    <p className="channel-card-note">
                      {bot.lastSeenAt ? `上次收到消息 ${date(bot.lastSeenAt)}` : "还没有收到过消息"}
                    </p>
                  )}

                  <footer className="channel-card-actions">
                    <button
                      type="button"
                      className="security-action"
                      onClick={() =>
                        setDraft({
                          id: bot.id,
                          platform: bot.platform,
                          name: bot.name,
                          enabled: bot.enabled,
                          config: { ...bot.config },
                        })
                      }
                    >
                      <Pencil size={12} />
                      编辑
                    </button>
                    <button type="button" className="security-action" onClick={() => setRotating(bot)}>
                      <RefreshCw size={12} />
                      换地址
                    </button>
                    <button
                      type="button"
                      className="security-action is-danger"
                      aria-label={`删除 ${bot.name}`}
                      title="删除"
                      onClick={() => setRemoving(bot)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </footer>
                </li>
              );
            })}
          </ul>
        )}

        <p className="security-hint">
          回调地址里的那串字符就是入口凭证，拿到它的人可以查询账号状态（但看不到密码）。
          怀疑泄露时点「换地址」，旧地址立即失效。
        </p>
      </section>

      {draft && (
        <Modal
          title={draft.id ? "编辑机器人" : "添加机器人"}
          className="notify-editor"
          onClose={() => setDraft(null)}
        >
          <div className="modal-body">
            <label className="field">
              平台
              <select
                value={draft.platform}
                disabled={!!draft.id}
                onChange={(event) => setDraft({ ...emptyDraft(event.target.value), name: draft.name })}
              >
                {platforms.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
              <span className="auth-field-help">{platformOf(draft.platform)?.hint}</span>
            </label>

            <label className="field">
              名称
              <input
                data-autofocus
                maxLength={40}
                placeholder={platformOf(draft.platform)?.label || "运维群"}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>

            {(platformOf(draft.platform)?.fields || []).map((field) => (
              <label className="field" key={field.key}>
                {field.label}
                <input
                  type={field.secret ? "password" : "text"}
                  autoComplete={field.secret ? "new-password" : "off"}
                  placeholder={draft.id && field.secret ? "留空表示不修改" : ""}
                  value={draft.config[field.key] || ""}
                  onChange={(event) =>
                    setDraft({ ...draft, config: { ...draft.config, [field.key]: event.target.value } })
                  }
                />
                {field.hint && <span className="auth-field-help">{field.hint}</span>}
              </label>
            ))}

            <label className="bot-switch">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              />
              <span>
                <strong>启用</strong>
                <em>停用后回调地址立即失效，但仍然保留配置。</em>
              </span>
            </label>
          </div>
          <footer className="modal-footer">
            <button type="button" className="button" disabled={busy} onClick={() => setDraft(null)}>
              取消
            </button>
            <button type="button" className="button primary" disabled={busy} onClick={() => void save()}>
              {busy ? "保存中…" : "保存"}
            </button>
          </footer>
        </Modal>
      )}

      {removing && (
        <ConfirmDialog
          title={`删除「${removing.name}」？`}
          description="回调地址会立即失效，群里的机器人不再回应。消息记录保留。"
          confirmLabel={busy ? "处理中…" : "确认删除"}
          onCancel={() => {
            if (!busy) setRemoving(null);
          }}
          onConfirm={() => void remove()}
        />
      )}

      {rotating && (
        <ConfirmDialog
          title={`更换「${rotating.name}」的回调地址？`}
          description="旧地址立刻失效，需要把新地址填回钉钉或飞书，否则机器人不再回应。"
          confirmLabel={busy ? "处理中…" : "确认更换"}
          onCancel={() => {
            if (!busy) setRotating(null);
          }}
          onConfirm={() => void rotate()}
        />
      )}
    </div>
  );
}
