import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Loader2, LockKeyhole, Plus, RefreshCcw, Save, Trash2 } from "lucide-react";
import "./styles.css";
import type { AdminCard } from "./types";
import { adminApi } from "./card-license/api";

const useOptions = [10, 20, 30, 50, 100];
const expiryOptions = [
  { label: "不限期", value: "" },
  { label: "31天", value: "31" },
  { label: "7天", value: "7" },
  { label: "3天", value: "3" },
  { label: "1天", value: "1" },
];
const editExpiryOptions = [{ label: "保持当前", value: "keep" }, ...expiryOptions];
type SortKey = "createdAt" | "totalUses" | "lastLoginAt";
type SortDirection = "asc" | "desc";
type SortState = { key: SortKey; direction: SortDirection };
type CardDraft = { totalUses?: string; expiresInDays?: string };

function AdminApp() {
  const [password, setPassword] = useState("");
  const [isAuthed, setIsAuthed] = useState(false);
  const [cards, setCards] = useState<AdminCard[]>([]);
  const [sort, setSort] = useState<SortState>({ key: "createdAt", direction: "desc" });
  const [totalUses, setTotalUses] = useState("10");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [count, setCount] = useState(10);
  const [note, setNote] = useState("");
  const [drafts, setDrafts] = useState<Record<string, CardDraft>>({});
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const summary = useMemo(
    () => ({
      active: cards.filter((card) => card.status === "active").length,
      disabled: cards.filter((card) => card.status === "disabled").length,
      expired: cards.filter((card) => card.expiresAt && Date.parse(card.expiresAt) <= Date.now()).length,
      remaining: cards.reduce((sum, card) => sum + card.remainingUses, 0),
    }),
    [cards],
  );

  const sortedCards = useMemo(() => {
    const compareTime = (left?: string | null, right?: string | null) => {
      if (!left && !right) return 0;
      if (!left) return 1;
      if (!right) return -1;
      return Date.parse(left) - Date.parse(right);
    };

    return [...cards].sort((left, right) => {
      const direction = sort.direction === "desc" ? -1 : 1;
      let result = 0;

      if (sort.key === "createdAt") {
        result = compareTime(left.createdAt, right.createdAt);
      } else if (sort.key === "totalUses") {
        result = left.totalUses - right.totalUses;
      } else {
        result = compareTime(left.lastLoginAt, right.lastLoginAt);
        if (!left.lastLoginAt || !right.lastLoginAt) {
          return result;
        }
      }

      return result === 0 ? left.code.localeCompare(right.code) : result * direction;
    });
  }, [cards, sort]);

  const toggleSort = (key: SortKey) => {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === "desc" ? "asc" : "desc",
    }));
  };

  const loadCards = async () => {
    setIsBusy(true);
    setError("");
    try {
      setCards(await adminApi.listCards());
      setDrafts({});
      setIsAuthed(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取兑换码失败。");
    } finally {
      setIsBusy(false);
    }
  };

  useEffect(() => {
    void loadCards();
  }, []);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsBusy(true);
    setError("");
    try {
      await adminApi.login(password);
      setPassword("");
      await loadCards();
      setNotice("管理员登录成功。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "管理员登录失败。");
    } finally {
      setIsBusy(false);
    }
  };

  const createBatch = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsBusy(true);
    setError("");
    try {
      const created = await adminApi.createBatch({
        totalUses: Number(totalUses),
        count,
        note,
        expiresInDays: expiresInDays ? Number(expiresInDays) : null,
      });
      setCards((current) => [...created, ...current]);
      setNotice(`已生成 ${created.length} 个兑换码。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "生成兑换码失败。");
    } finally {
      setIsBusy(false);
    }
  };

  const toggleStatus = async (card: AdminCard) => {
    setError("");
    try {
      const next = await adminApi.updateCard(card.code, { status: card.status === "active" ? "disabled" : "active" });
      setCards((current) => current.map((item) => (item.code === next.code ? next : item)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "更新兑换码失败。");
    }
  };

  const updateDraft = (code: string, patch: CardDraft) => {
    setDrafts((current) => ({
      ...current,
      [code]: { ...current[code], ...patch },
    }));
  };

  const saveCardEdits = async (card: AdminCard) => {
    setError("");
    const draft = drafts[card.code] ?? {};
    const nextTotalUses = Number(draft.totalUses ?? card.totalUses);
    const nextExpiry = draft.expiresInDays ?? "keep";
    try {
      const next = await adminApi.updateCard(card.code, {
        totalUses: nextTotalUses,
        ...(nextExpiry === "keep" ? {} : { expiresInDays: nextExpiry ? Number(nextExpiry) : null }),
      });
      setCards((current) => current.map((item) => (item.code === next.code ? next : item)));
      setDrafts((current) => ({ ...current, [card.code]: {} }));
      setNotice(`已更新兑换码 ${card.code}。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "更新兑换码失败。");
    }
  };

  const deleteCard = async (card: AdminCard) => {
    if (!window.confirm(`确定删除兑换码 ${card.code}？此操作不可恢复。`)) return;
    setError("");
    try {
      await adminApi.deleteCard(card.code);
      setCards((current) => current.filter((item) => item.code !== card.code));
      setNotice(`已删除兑换码 ${card.code}。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除兑换码失败。");
    }
  };

  const exportCards = async (format: "json" | "csv") => {
    const { blob, filename } = await adminApi.exportCards(format);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const formatExpiry = (expiresAt?: string | null) => {
    if (!expiresAt) return "不限期";
    const expired = Date.parse(expiresAt) <= Date.now();
    return `${new Date(expiresAt).toLocaleString()}${expired ? "（已过期）" : ""}`;
  };

  if (!isAuthed) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f6f8f8] p-4 text-ink">
        <form className="panel w-full max-w-md" onSubmit={login}>
          <div className="mb-5 flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-accent text-white">
              <LockKeyhole size={20} />
            </div>
            <div>
              <h1 className="text-xl font-semibold">兑换码管理后台</h1>
              <p className="text-sm text-slate-500">请输入管理员密码。</p>
            </div>
          </div>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="ADMIN_PASSWORD"
          />
          {error && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          <button className="primary-button mt-4 w-full" disabled={isBusy || !password}>
            {isBusy ? <Loader2 className="animate-spin" size={18} /> : <LockKeyhole size={18} />}
            登录
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f6f8f8] p-4 text-ink lg:p-6">
      <div className="mx-auto max-w-[1280px] space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">兑换码管理后台</h1>
            <p className="text-sm text-slate-500">生成、导出、启用或禁用图片处理兑换码。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="secondary-button" onClick={loadCards} disabled={isBusy}>
              <RefreshCcw size={16} />
              刷新
            </button>
            <button className="secondary-button" onClick={() => exportCards("csv")}>
              <Download size={16} />
              CSV
            </button>
            <button className="secondary-button" onClick={() => exportCards("json")}>
              <Download size={16} />
              JSON
            </button>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <form className="panel space-y-4" onSubmit={createBatch}>
            <h2 className="text-lg font-semibold">批量生成</h2>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">次数档位</span>
              <input
                className="input"
                type="number"
                min={1}
                max={100000}
                list="total-use-options"
                value={totalUses}
                onChange={(event) => setTotalUses(event.target.value)}
              />
              <datalist id="total-use-options">
                {useOptions.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">使用期限</span>
              <select className="input" value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)}>
                {expiryOptions.map((option) => (
                  <option key={option.value || "unlimited"} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">生成数量</span>
              <input className="input" type="number" min={1} max={1000} value={count} onChange={(event) => setCount(Number(event.target.value))} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">备注</span>
              <input className="input" value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：5月活动批次" />
            </label>
            <button className="primary-button w-full" disabled={isBusy}>
              {isBusy ? <Loader2 className="animate-spin" size={18} /> : <Plus size={18} />}
              生成兑换码
            </button>
            {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}
            {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          </form>

          <section className="grid gap-3 sm:grid-cols-3">
            <Metric label="兑换码总数" value={cards.length} />
            <Metric label="启用 / 禁用 / 过期" value={`${summary.active} / ${summary.disabled} / ${summary.expired}`} />
            <Metric label="剩余总次数" value={summary.remaining} />
          </section>
        </section>

        <section className="panel overflow-hidden">
          <div className="overflow-auto">
            <table className="w-full min-w-[1180px] border-collapse text-sm">
              <thead className="bg-mist text-left text-slate-600">
                <tr>
                  <th className="px-3 py-2">兑换码</th>
                  <SortableHeader label="次数" sortKey="totalUses" activeSort={sort} onSort={toggleSort} />
                  <th className="px-3 py-2">状态</th>
                  <th className="px-3 py-2">使用期限</th>
                  <SortableHeader label="创建时间" sortKey="createdAt" activeSort={sort} onSort={toggleSort} />
                  <SortableHeader label="最近登录" sortKey="lastLoginAt" activeSort={sort} onSort={toggleSort} />
                  <th className="px-3 py-2">备注</th>
                  <th className="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {sortedCards.map((card) => (
                  <tr key={card.code} className="border-t border-line">
                    <td className="px-3 py-2 font-semibold">{card.code}</td>
                    <td className="px-3 py-2">{card.remainingUses}/{card.totalUses}</td>
                    <td className="px-3 py-2">{card.status === "active" ? "启用" : "禁用"}</td>
                    <td className="px-3 py-2">{formatExpiry(card.expiresAt)}</td>
                    <td className="px-3 py-2">{new Date(card.createdAt).toLocaleString()}</td>
                    <td className="px-3 py-2">{card.lastLoginAt ? new Date(card.lastLoginAt).toLocaleString() : "-"}</td>
                    <td className="px-3 py-2">{card.note || "-"}</td>
                    <td className="px-3 py-2">
                      <div className="flex min-w-[360px] flex-wrap items-center gap-2">
                        <input
                          className="input h-9 w-24"
                          type="number"
                          min={card.usedUses}
                          max={100000}
                          value={drafts[card.code]?.totalUses ?? String(card.totalUses)}
                          onChange={(event) => updateDraft(card.code, { totalUses: event.target.value })}
                        />
                        <select
                          className="input h-9 w-28"
                          value={drafts[card.code]?.expiresInDays ?? "keep"}
                          onChange={(event) => updateDraft(card.code, { expiresInDays: event.target.value })}
                        >
                          {editExpiryOptions.map((option) => (
                            <option key={option.value || "unlimited"} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <button className="tiny-button w-auto px-3" onClick={() => saveCardEdits(card)}>
                          <Save size={14} />
                          保存
                        </button>
                        <button className="tiny-button w-auto px-3" onClick={() => toggleStatus(card)}>
                        {card.status === "active" ? "禁用" : "启用"}
                        </button>
                        <button className="tiny-button w-auto px-3 text-red-600" onClick={() => deleteCard(card)}>
                          <Trash2 size={14} />
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {cards.length === 0 && <div className="p-6 text-center text-sm text-slate-500">暂无兑换码</div>}
          </div>
        </section>
      </div>
    </main>
  );
}

function SortableHeader({
  label,
  sortKey,
  activeSort,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  activeSort: SortState;
  onSort: (key: SortKey) => void;
}) {
  const isActive = activeSort.key === sortKey;
  const Icon = !isActive ? ArrowUpDown : activeSort.direction === "desc" ? ArrowDown : ArrowUp;
  const ariaSort = !isActive ? "none" : activeSort.direction === "desc" ? "descending" : "ascending";

  return (
    <th className="px-3 py-2" aria-sort={ariaSort}>
      <button
        className={`inline-flex items-center gap-1.5 border-0 bg-transparent p-0 text-left font-semibold transition hover:text-accent ${isActive ? "text-accent" : "text-slate-600"}`}
        type="button"
        onClick={() => onSort(sortKey)}
      >
        {label}
        <Icon size={14} />
      </button>
    </th>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="panel">
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<AdminApp />);
