import { useCallback, useEffect, useState } from "react";
import { Bell, Bot, Clock3, Inbox, MessageSquare, Terminal } from "lucide-react";
import { api } from "./api";
import { ChannelsPage } from "./ChannelsPage";
import { DeliveriesPage } from "./DeliveriesPage";
import { PatrolPage } from "./PatrolPage";
import { BotPage } from "./BotPage";
import { CommandPage } from "./CommandPage";
import { BotMessagesPage } from "./BotMessagesPage";

/**
 * Six small pages behind one tab strip, matching the security centre.
 * Each tab owns exactly one question: where does it go, what went out, when
 * does it run, who answers in the group, what can they ask, and what was said.
 */
const sections = [
  { id: "channels", label: "推送通道", icon: Bell },
  { id: "deliveries", label: "发送记录", icon: Inbox },
  { id: "patrol", label: "定时巡检", icon: Clock3 },
  { id: "bot", label: "群机器人", icon: Bot },
  { id: "commands", label: "指令", icon: Terminal },
  { id: "messages", label: "消息记录", icon: MessageSquare },
] as const;

type Section = (typeof sections)[number]["id"];

type Summary = {
  channels: number | null;
  deliveries: number | null;
  bots: number | null;
  commands: number | null;
  messages: number | null;
  patrol: boolean | null;
};

export function NotifyPage({ notify }: { notify: (message: string) => void }) {
  const [tab, setTab] = useState<Section>("channels");
  const [summary, setSummary] = useState<Summary>({
    channels: null,
    deliveries: null,
    bots: null,
    commands: null,
    messages: null,
    patrol: null,
  });

  // Only the counts are read here — the pages below load what they actually show.
  const refresh = useCallback(async () => {
    try {
      const [push, bot] = await Promise.all([
        api<{ channels: unknown[]; deliveries: unknown[] }>("/notify?deliveries=200"),
        api<{ bots: unknown[]; messages: unknown[]; commands: unknown[]; settings: { enabled: boolean } }>(
          "/bot?messages=300",
        ),
      ]);
      setSummary({
        channels: push.channels.length,
        deliveries: push.deliveries.length,
        bots: bot.bots.length,
        commands: bot.commands.length,
        messages: bot.messages.length,
        patrol: bot.settings.enabled,
      });
    } catch {
      // The tab strip is navigation, not a status report: if this fails the page
      // below still shows the real error with a retry button.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, tab]);

  function countOf(id: Section): number | string {
    if (summary.channels === null) return "—";
    if (id === "channels") return summary.channels ?? 0;
    if (id === "deliveries") return summary.deliveries ?? 0;
    if (id === "patrol") return summary.patrol ? "开" : "关";
    if (id === "bot") return summary.bots ?? 0;
    if (id === "commands") return summary.commands ?? 0;
    return summary.messages ?? 0;
  }

  return (
    <div className="notify-page">
      <div className="security-tabs" role="tablist" aria-label="通知推送分类">
        {sections.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`security-tab${tab === item.id ? " is-active" : ""}${
                item.id === "patrol" && summary.patrol === false ? " has-alert" : ""
              }`}
              onClick={() => setTab(item.id)}
            >
              <Icon size={14} />
              {item.label}
              <span
                className={`security-tab-count${
                  item.id === "patrol" ? (summary.patrol ? " is-on" : " is-warn") : ""
                }`}
                title={
                  item.id === "patrol"
                    ? summary.patrol
                      ? "每日巡检已开启"
                      : "每日巡检未开启"
                    : undefined
                }
              >
                {countOf(item.id)}
              </span>
            </button>
          );
        })}
      </div>

      {tab === "channels" && <ChannelsPage notify={notify} onChanged={() => void refresh()} />}
      {tab === "deliveries" && <DeliveriesPage />}
      {tab === "patrol" && <PatrolPage notify={notify} />}
      {tab === "bot" && <BotPage notify={notify} onChanged={() => void refresh()} />}
      {tab === "commands" && <CommandPage />}
      {tab === "messages" && <BotMessagesPage />}
    </div>
  );
}
