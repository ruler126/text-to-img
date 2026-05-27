import type { AdminCard, CardSession, UsageReservation } from "../types";

const readJson = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload?.error ?? `请求失败：HTTP ${response.status}`);
  }
  return payload as T;
};

const request = async <T>(path: string, options: RequestInit = {}) =>
  readJson<T>(
    await fetch(path, {
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      ...options,
    }),
  );

export const cardApi = {
  login: async (code: string) => {
    const payload = await request<{ card: CardSession }>("/api/cards/login", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    return payload.card;
  },
  me: async () => {
    const payload = await request<{ card: CardSession }>("/api/cards/me");
    return payload.card;
  },
  logout: async () => request<{ ok: true }>("/api/cards/logout", { method: "POST" }),
  startUsage: async () => {
    const payload = await request<{ reservation: UsageReservation }>("/api/cards/usage/start", { method: "POST" });
    return payload.reservation;
  },
  finishUsage: async (id: string, success: boolean) => {
    const payload = await request<{ card: CardSession }>(`/api/cards/usage/${encodeURIComponent(id)}/${success ? "success" : "fail"}`, {
      method: "POST",
    });
    return payload.card;
  },
};

export const adminApi = {
  login: async (password: string) =>
    request<{ ok: true }>("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  listCards: async () => {
    const payload = await request<{ cards: AdminCard[] }>("/api/admin/cards");
    return payload.cards;
  },
  createBatch: async ({ totalUses, count, note }: { totalUses: number; count: number; note: string }) => {
    const payload = await request<{ cards: AdminCard[] }>("/api/admin/cards/batch", {
      method: "POST",
      body: JSON.stringify({ totalUses, count, note }),
    });
    return payload.cards;
  },
  updateCard: async (code: string, patch: Pick<AdminCard, "status"> | Pick<AdminCard, "note">) => {
    const payload = await request<{ card: AdminCard }>(`/api/admin/cards/${encodeURIComponent(code)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return payload.card;
  },
  exportCards: async (format: "json" | "csv") => {
    const response = await fetch("/api/admin/cards/export", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.error ?? "导出失败。");
    }
    return {
      blob: await response.blob(),
      filename: format === "csv" ? "cards.csv" : "cards.json",
    };
  },
};
