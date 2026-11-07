import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/**
 * The bot section is three pages now (bots, commands, messages), and all three
 * sit on the same `GET /bot` payload. The types and the fetch live here so the
 * split does not turn into three copies of the same request code.
 */
export type Field = { key: string; label: string; secret: boolean; hint?: string };

export type Platform = { id: string; label: string; hint: string; fields: Field[] };

export type BotRow = {
  id: string;
  name: string;
  platform: string;
  config: Record<string, string>;
  enabled: boolean;
  token: string;
  createdAt: string;
  lastSeenAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
};

export type Settings = {
  enabled: boolean;
  dailyAt: string;
  checkBefore: boolean;
  staleDays: number;
  lastRunAt: string | null;
};

export type Message = {
  at: string;
  botId: string;
  direction: "in" | "out";
  text: string;
  actor: string | null;
  ok: boolean;
};

export type Command = { command: string; argv: string; hint: string };

export type Payload = {
  bots: BotRow[];
  settings: Settings;
  nextRunAt: string | null;
  messages: Message[];
  platforms: Platform[];
  commands: Command[];
  hookBase: string;
  publicOrigin: string;
  stale: number;
};

/** Loopback means the hook address is unreachable for DingTalk and Feishu. */
export function localOrigin(origin: string) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(origin);
}

export function useBotData(messageLimit = 1) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await api<Payload>(`/bot?messages=${messageLimit}`);
      setData(result);
      setError("");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setLoading(false);
    }
  }, [messageLimit]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, setData, loading, error, setError, load };
}
