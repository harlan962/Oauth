let csrfToken = "";
let reauthToken = "";
export function setCsrfToken(value: string) {
  csrfToken = value;
}
// A short-lived grant for the two endpoints that return plaintext credentials.
// Kept in memory only: closing the tab or reloading drops it.
export function setReauthToken(value: string) {
  reauthToken = value;
}
export function clearReauthToken() {
  reauthToken = "";
}
export type ApiFailure = Error & { status?: number; code?: string };
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      "X-Local-Client": "account-desk",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...(reauthToken ? { "X-Reauth-Token": reauthToken } : {}),
      ...headers,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  if (
    (response.status === 401 &&
      !["/auth/login", "/auth/setup", "/auth/status"].includes(path)) ||
    data.code === "AUTH_CSRF"
  ) {
    setCsrfToken("");
    clearReauthToken();
    if (typeof window !== "undefined")
      window.dispatchEvent(new Event("account-desk:auth-required"));
  }
  if (!response.ok) {
    const error = new Error(data.error || "请求失败，请重试") as ApiFailure;
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data as T;
}
