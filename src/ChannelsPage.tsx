import { useMemo, useState } from "react";
import {
  Bell,
  Check,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { api } from "./api";
import { date } from "./types";
import { Modal, ConfirmDialog } from "./components";
import { FilterBar } from "./FilterBar";
import { matchesQuery } from "./filters";
import { Pager, usePage } from "./Pager";
import { Switch } from "./Switch";
import {
  hostOf,
  shortCategory,
  targetOf,
  useNotifyData,
  type Category,
  type Channel,
  type ChannelType,
} from "./notify-data";

const typeMeta: Record<
  ChannelType,
  { label: string; icon: typeof Mail; hint: string; placeholder: string }
> = {
  email: {
    label: "邮件",
    icon: Mail,
    hint: "通过你自己的 SMTP 发信，适合长期留档与转发。",
    placeholder: "工作邮箱",
  },
  dingtalk: {
    label: "钉钉机器人",
    icon: Send,
    hint: "群设置 → 智能群助手 → 添加机器人 → 自定义，复制 Webhook 与加签密钥。",
    placeholder: "运维群",
  },
  feishu: {
    label: "飞书机器人",
    icon: Send,
    hint: "群设置 → 群机器人 → 添加 → 自定义机器人，复制 Webhook 地址。",
    placeholder: "安全告警群",
  },
  webhook: {
    label: "通用 Webhook",
    icon: Webhook,
    hint: "POST 一段 JSON 到你自己的地址，可以接到自建通知服务或自动化流程。",
    placeholder: "自建告警",
  },
};

const channelTypes = Object.keys(typeMeta) as ChannelType[];

const emptyDraft = (type: ChannelType) => ({
  id: undefined as string | undefined,
  type,
  name: "",
  events: ["login", "account", "secret", "intrusion"] as string[],
  enabled: true,
  config: {} as Record<string, string>,
});

type Draft = ReturnType<typeof emptyDraft>;
type StateFilter = "all" | "on" | "off";

export function ChannelsPage({
  notify,
  onChanged,
}: {
  notify: (message: string) => void;
  onChanged?: () => void;
}) {
  const { channels, setChannels, categories, loading, error, setError, load } = useNotifyData(1);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<Channel | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<ChannelType | "all">("all");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");

  const labels = useMemo(
    () => Object.fromEntries(categories.map((item: Category) => [item.id, item.label])),
    [categories],
  );

  const visible = useMemo(
    () =>
      channels.filter((channel) => {
        if (typeFilter !== "all" && channel.type !== typeFilter) return false;
        if (stateFilter === "on" && !channel.enabled) return false;
        if (stateFilter === "off" && channel.enabled) return false;
        return matchesQuery(
          [
            channel.name,
            typeMeta[channel.type].label,
            targetOf(channel),
            channel.events.map((id) => labels[id] || id).join(" "),
          ],
          query,
        );
      }),
    [channels, typeFilter, stateFilter, query, labels],
  );

  const page = usePage(visible, 20, `${query}|${typeFilter}|${stateFilter}`);

  const enabled = channels.filter((item) => item.enabled).length;

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        type: draft.type,
        name: draft.name.trim() || typeMeta[draft.type].label,
        events: draft.events,
        enabled: draft.enabled,
        config: draft.config,
      };
      if (draft.id) await api(`/notify/${draft.id}`, "PATCH", body);
      else await api("/notify", "POST", body);
      setDraft(null);
      notify(draft.id ? "推送通道已更新" : "推送通道已添加，开关已打开");
      await load();
      onChanged?.();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(channel: Channel) {
    const next = !channel.enabled;
    setPending(channel.id);
    setError("");
    // Flip locally first: a switch that waits for a round trip before moving
    // feels broken even when it works.
    setChannels((list) => list.map((item) => (item.id === channel.id ? { ...item, enabled: next } : item)));
    try {
      await api(`/notify/${channel.id}`, "PATCH", { enabled: next });
      notify(next ? `「${channel.name}」已开启，匹配的事件会即时推送` : `「${channel.name}」已关闭，不再推送任何消息`);
      await load();
      onChanged?.();
    } catch (failure) {
      setChannels((list) => list.map((item) => (item.id === channel.id ? { ...item, enabled: !next } : item)));
      setError((failure as Error).message);
    } finally {
      setPending(null);
    }
  }

  async function sendTest(channel: Channel) {
    setTesting(channel.id);
    setError("");
    try {
      await api(`/notify/${channel.id}/test`, "POST", {});
      notify(`测试消息已发送到「${channel.name}」`);
      await load();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setTesting(null);
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await api(`/notify/${removing.id}`, "DELETE");
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

  function edit(channel: Channel) {
    setDraft({
      id: channel.id,
      type: channel.type,
      name: channel.name,
      events: [...channel.events],
      enabled: channel.enabled,
      // Secrets come back masked, so they start blank and an empty value keeps them.
      config: Object.fromEntries(
        Object.entries(channel.config).map(([key, value]) => [key, String(value ?? "")]),
      ),
    });
  }

  function setField(key: string, value: string) {
    setDraft((current) => (current ? { ...current, config: { ...current.config, [key]: value } } : current));
  }

  return (
    <div className="notify-page">
      <div className="security-summary">
        <section className="security-stat">
          <span className="security-stat-label">
            <Check size={14} />
            推送中
          </span>
          <strong className="security-stat-value">{loading ? "—" : enabled}</strong>
          <span className="security-stat-note">
            {loading ? "正在读取…" : channels.length - enabled ? `另有 ${channels.length - enabled} 个已关闭` : "全部通道都在推送"}
          </span>
        </section>
        <section className="security-stat">
          <span className="security-stat-label">
            <Bell size={14} />
            已关闭
          </span>
          <strong className="security-stat-value">{loading ? "—" : channels.length - enabled}</strong>
          <span className="security-stat-note">关掉的不占用推送额度，配置仍保留</span>
        </section>
        <section className="security-stat">
          <span className="security-stat-label">
            <Send size={14} />
            推送方式
          </span>
          <strong className="security-stat-value">{channelTypes.length}</strong>
          <span className="security-stat-note">邮件 / 钉钉 / 飞书 / Webhook</span>
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
            <Bell size={16} />
            <h2>推送通道</h2>
            <span className="security-count">{channels.length}</span>
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
            <button type="button" className="button primary" onClick={() => setDraft(emptyDraft("feishu"))}>
              <Plus size={16} />
              添加通道
            </button>
          </div>
        </header>

        {!channels.length && !loading ? (
          // An empty page with only a paragraph hides the one control people
          // come here for. The four types are shown as switched-off cards: the
          // switch is right where it will live once the channel exists, and
          // flipping it is how you start.
          <div className="channel-empty">
            <p className="channel-empty-lead">
              还没有推送通道。把任意一张卡片的开关拨开，填好地址就能收到第一条告警。
            </p>
            <ul className="channel-grid">
              {channelTypes.map((type) => {
                const Icon = typeMeta[type].icon;
                return (
                  <li key={type} className="channel-card is-off">
                    <header className="channel-card-head">
                      <span className="channel-icon" aria-hidden="true">
                        <Icon size={16} />
                      </span>
                      <div className="channel-card-title">
                        <strong>{typeMeta[type].label}</strong>
                        <span className="channel-card-type">尚未添加</span>
                      </div>
                      <Switch
                        checked={false}
                        label={`添加${typeMeta[type].label}通道`}
                        onChange={() => setDraft(emptyDraft(type))}
                      />
                    </header>
                    <p className="channel-card-note">{typeMeta[type].hint}</p>
                    <footer className="channel-card-actions">
                      <button
                        type="button"
                        className="security-action"
                        onClick={() => setDraft(emptyDraft(type))}
                      >
                        <Plus size={12} />
                        添加
                      </button>
                    </footer>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <>
            {channels.length > 0 && (
              <FilterBar
                query={query}
                onQuery={setQuery}
                placeholder="搜索通道名称、地址或订阅…"
                shown={visible.length}
                total={channels.length}
                onReset={() => {
                  setTypeFilter("all");
                  setStateFilter("all");
                }}
              >
                <label className="filter-select">
                  <select
                    value={typeFilter}
                    aria-label="推送方式"
                    onChange={(event) => setTypeFilter(event.target.value as ChannelType | "all")}
                  >
                    <option value="all">全部方式</option>
                    {channelTypes.map((type) => (
                      <option key={type} value={type}>
                        {typeMeta[type].label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="filter-select">
                  <select
                    value={stateFilter}
                    aria-label="启用状态"
                    onChange={(event) => setStateFilter(event.target.value as StateFilter)}
                  >
                    <option value="all">全部状态</option>
                    <option value="on">推送中</option>
                    <option value="off">已关闭</option>
                  </select>
                </label>
              </FilterBar>
            )}

            {visible.length ? (
              <ul className="channel-grid">
                {page.rows.map((channel) => {
                  const Icon = typeMeta[channel.type].icon;
                  return (
                    <li key={channel.id} className={`channel-card${channel.enabled ? "" : " is-off"}`}>
                      <header className="channel-card-head">
                        <span className="channel-icon" aria-hidden="true">
                          <Icon size={16} />
                        </span>
                        <div className="channel-card-title">
                          <strong>{channel.name}</strong>
                          <span className="channel-card-type">
                            {typeMeta[channel.type].label} · {channel.enabled ? "推送中" : "已关闭"}
                          </span>
                        </div>
                        <Switch
                          checked={channel.enabled}
                          disabled={pending === channel.id}
                          label={
                            channel.enabled
                              ? `关闭「${channel.name}」，停止推送`
                              : `开启「${channel.name}」，开始推送`
                          }
                          onChange={() => void toggle(channel)}
                        />
                      </header>

                      <p className="channel-card-target" title={targetOf(channel)}>
                        {channel.type === "webhook" ? targetOf(channel) : hostOf(targetOf(channel))}
                      </p>

                      <div className="channel-card-tags">
                        {channel.events.map((id) => (
                          <span key={id} className="channel-tag" title={labels[id] || id}>
                            {shortCategory(id, labels[id] || id)}
                          </span>
                        ))}
                        {!channel.events.length && <span className="channel-tag is-off">未订阅任何事件</span>}
                      </div>

                      {!channel.enabled ? (
                        <p className="channel-card-note">已关闭，不会收到任何推送</p>
                      ) : channel.lastError ? (
                        <p className="channel-error">
                          <X size={12} />
                          {channel.lastError}
                          {channel.lastErrorAt && (
                            <span className="channel-error-at">{date(channel.lastErrorAt)}</span>
                          )}
                        </p>
                      ) : (
                        <p className="channel-card-note">
                          {channel.lastSentAt ? `上次发送 ${date(channel.lastSentAt)}` : "还没有发送过"}
                        </p>
                      )}

                      <footer className="channel-card-actions">
                        <button
                          type="button"
                          className="security-action"
                          disabled={testing === channel.id}
                          onClick={() => void sendTest(channel)}
                        >
                          {testing === channel.id ? "发送中…" : "测试"}
                        </button>
                        <button type="button" className="security-action" onClick={() => edit(channel)}>
                          <Pencil size={12} />
                          编辑
                        </button>
                        <button
                          type="button"
                          className="security-action is-danger"
                          aria-label={`删除 ${channel.name}`}
                          title="删除"
                          onClick={() => setRemoving(channel)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </footer>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="security-empty">没有符合筛选条件的通道</p>
            )}

            <Pager state={page} unit="个" label="推送通道" />
          </>
        )}

        <p className="security-hint">
          同一种事件 1 分钟内只推一次，单个通道每分钟最多 20 条，避免被暴力破解刷成一屏消息。
          推送失败只记录在通道上，不影响登录本身。
        </p>
      </section>

      {draft && (
        <Modal
          title={draft.id ? "编辑推送通道" : "添加推送通道"}
          className="notify-editor"
          onClose={() => setDraft(null)}
        >
          <div className="modal-body">
            <label className="field">
              推送方式
              <select
                value={draft.type}
                disabled={!!draft.id}
                onChange={(event) =>
                  setDraft({ ...emptyDraft(event.target.value as ChannelType), name: draft.name })
                }
              >
                {channelTypes.map((type) => (
                  <option key={type} value={type}>
                    {typeMeta[type].label}
                  </option>
                ))}
              </select>
              <span className="auth-field-help">{typeMeta[draft.type].hint}</span>
            </label>

            <label className="field">
              名称
              <input
                data-autofocus
                maxLength={40}
                placeholder={typeMeta[draft.type].placeholder}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>

            {draft.type === "email" && (
              <>
                <div className="notify-grid">
                  <label className="field">
                    SMTP 服务器
                    <input
                      placeholder="smtp.example.com"
                      value={draft.config.host || ""}
                      onChange={(event) => setField("host", event.target.value)}
                    />
                  </label>
                  <label className="field">
                    端口
                    <input
                      inputMode="numeric"
                      placeholder="465"
                      value={draft.config.port || ""}
                      onChange={(event) => setField("port", event.target.value)}
                    />
                  </label>
                </div>
                <div className="notify-grid">
                  <label className="field">
                    账号
                    <input
                      autoComplete="off"
                      placeholder="notify@example.com"
                      value={draft.config.user || ""}
                      onChange={(event) => setField("user", event.target.value)}
                    />
                  </label>
                  <label className="field">
                    密码 / 授权码
                    <input
                      type="password"
                      autoComplete="new-password"
                      placeholder={draft.id ? "留空表示不修改" : ""}
                      value={draft.config.pass || ""}
                      onChange={(event) => setField("pass", event.target.value)}
                    />
                  </label>
                </div>
                <label className="field">
                  发件人
                  <input
                    placeholder="Account Desk <notify@example.com>"
                    value={draft.config.from || ""}
                    onChange={(event) => setField("from", event.target.value)}
                  />
                </label>
                <label className="field">
                  收件人
                  <input
                    placeholder="me@example.com, backup@example.com"
                    value={draft.config.to || ""}
                    onChange={(event) => setField("to", event.target.value)}
                  />
                  <span className="auth-field-help">多个收件人用逗号分隔，最多 10 个。</span>
                </label>
              </>
            )}

            {(draft.type === "dingtalk" || draft.type === "feishu") && (
              <>
                <label className="field">
                  机器人 Webhook
                  <input
                    placeholder="https://..."
                    value={draft.config.webhook || ""}
                    onChange={(event) => setField("webhook", event.target.value)}
                  />
                </label>
                <label className="field">
                  加签密钥（可选）
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder={draft.id ? "留空表示不修改" : "SEC 开头的一串字符"}
                    value={draft.config.secret || ""}
                    onChange={(event) => setField("secret", event.target.value)}
                  />
                  <span className="auth-field-help">机器人开启了「加签」时必须填写，否则消息会被拒绝。</span>
                </label>
              </>
            )}

            {draft.type === "webhook" && (
              <>
                <label className="field">
                  回调地址
                  <input
                    placeholder="https://example.com/hooks/account-desk"
                    value={draft.config.url || ""}
                    onChange={(event) => setField("url", event.target.value)}
                  />
                  <span className="auth-field-help">收到 {"{ title, text }"} 形式的 JSON。</span>
                </label>
                <label className="field">
                  Bearer 令牌（可选）
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder={draft.id ? "留空表示不修改" : ""}
                    value={draft.config.token || ""}
                    onChange={(event) => setField("token", event.target.value)}
                  />
                </label>
              </>
            )}

            <div className="field">
              <span>推送哪些事件</span>
              <div className="notify-events">
                {categories.map((category) => {
                  const checked = draft.events.includes(category.id);
                  return (
                    <label key={category.id} className={`notify-event${checked ? " is-on" : ""}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setDraft({
                            ...draft,
                            events: checked
                              ? draft.events.filter((id) => id !== category.id)
                              : [...draft.events, category.id],
                          })
                        }
                      />
                      <span>
                        <strong>{category.label}</strong>
                        <em>{category.hint}</em>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <label className="notify-enable">
              <Switch
                checked={draft.enabled}
                label={draft.enabled ? "保存后立即推送" : "保存后保持关闭"}
                onChange={(next) => setDraft({ ...draft, enabled: next })}
              />
              <span>
                <strong>{draft.enabled ? "保存后立即开始推送" : "保存后保持关闭"}</strong>
                <em>关闭时配置照样保存，回到列表随时可以打开。</em>
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
          description="删除后不再推送任何消息，已发送的记录仍保留在发送记录里。如果只是暂时不想收，用开关关掉即可。"
          confirmLabel={busy ? "处理中…" : "确认删除"}
          onCancel={() => {
            if (!busy) setRemoving(null);
          }}
          onConfirm={() => void remove()}
        />
      )}
    </div>
  );
}
