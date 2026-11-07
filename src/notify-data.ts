import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/**
 * The push settings are read by two separate pages (channels and delivery
 * history), so the fetch and its types live here instead of being copied twice.
 */
export type ChannelType = "email" | "dingtalk" | "feishu" | "webhook";

export type Channel = {
  id: string;
  type: ChannelType;
  name: string;
  config: Record<string, string | number | boolean>;
  events: string[];
  enabled: boolean;
  createdAt: string;
  lastSentAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
};

export type Category = { id: string; label: string; hint: string };
export type Delivery = { at: string; channelId: string; kind: string; ok: boolean; detail: string | null };

/**
 * The full category names ("凭据读取与两步验证") are right in the editor but
 * turn a card into three lines of wrapping tags. The short forms fit one row.
 */
const shortLabels: Record<string, string> = {
  login: "登录",
  account: "账号设置",
  secret: "凭据",
  intrusion: "异常",
  report: "巡检播报",
};

export function shortCategory(id: string, fallback: string) {
  return shortLabels[id] || fallback;
}

export function targetOf(channel: Channel) {
  const config = channel.config;
  if (channel.type === "email") return `${config.host}:${config.port} → ${config.to}`;
  return String(config.webhook || config.url || "");
}

export function hostOf(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

export function useNotifyData(deliveryLimit = 1) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await api<{ channels: Channel[]; categories: Category[]; deliveries: Delivery[] }>(
        `/notify?deliveries=${deliveryLimit}`,
      );
      setChannels(result.channels);
      setCategories(result.categories);
      setDeliveries(result.deliveries);
      setError("");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setLoading(false);
    }
  }, [deliveryLimit]);

  useEffect(() => {
    void load();
  }, [load]);

  return { channels, setChannels, categories, deliveries, loading, error, setError, load };
}
