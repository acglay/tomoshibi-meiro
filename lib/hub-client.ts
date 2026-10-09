export const HUB_URL = "https://hub-ashy-delta.vercel.app";
const APP_ID = "tomoshibi-meiro";
const TOKEN_KEY = "hub-token";

export function captureHubToken() {
  if (typeof window === "undefined") return;
  const m = window.location.hash.match(/#hub=([0-9a-f]+)/);
  if (m) {
    localStorage.setItem(TOKEN_KEY, m[1]);
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

export function hubToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export async function hubUser(): Promise<{ name: string; emoji: string; admin?: boolean } | null> {
  const token = hubToken();
  if (!token) return null;
  try {
    const res = await fetch(`${HUB_URL}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function hubLoad(
  key: string
): Promise<{ value: unknown; updatedAt: string | null } | null> {
  const token = hubToken();
  if (!token) return null;
  try {
    const res = await fetch(`${HUB_URL}/api/data/${APP_ID}/${key}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function hubSave(key: string, value: unknown) {
  const token = hubToken();
  if (!token) return;
  fetch(`${HUB_URL}/api/data/${APP_ID}/${key}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ value }),
  }).catch(() => {});
}
