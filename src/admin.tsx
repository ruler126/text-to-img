import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Download, Loader2, LockKeyhole, Plus, RefreshCcw } from "lucide-react";
import "./styles.css";
import type { AdminCard } from "./types";
import { adminApi } from "./card-license/api";

const useOptions = [10, 20, 30, 50, 100];

function AdminApp() {
  const [password, setPassword] = useState("");
  const [isAuthed, setIsAuthed] = useState(false);
  const [cards, setCards] = useState<AdminCard[]>([]);
  const [totalUses, setTotalUses] = useState(10);
  const [count, setCount] = useState(10);
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const summary = useMemo(
    () => ({
      active: cards.filter((card) => card.status === "active").length,
      disabled: cards.filter((card) => card.status === "disabled").length,
      remaining: cards.reduce((sum, card) => sum + card.remainingUses, 0),
    }),
    [cards],
  );

  const loadCards = async () => {
    setIsBusy(true);
    setError("");
    try {
      setCards(await adminApi.listCards());
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
      const created = await adminApi.createBatch({ totalUses, count, note });
      setCards((current) => [...created, ...current]);
      setNotice(`已生成 ${created.length} 个兑换码。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "生成兑换码失败。");
    } finally {
      setIsBusy(false);
    }
  };

  const toggleStatus = async (card: AdminCard) => {
    const next = await adminApi.updateCard(card.code, { status: card.status === "active" ? "disabled" : "active" });
    setCards((current) => current.map((item) => (item.code === next.code ? next : item)));
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
              <select className="input" value={totalUses} onChange={(event) => setTotalUses(Number(event.target.value))}>
                {useOptions.map((value) => (
                  <option key={value} value={value}>
                    {value} 次
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
            <Metric label="启用 / 禁用" value={`${summary.active} / ${summary.disabled}`} />
            <Metric label="剩余总次数" value={summary.remaining} />
          </section>
        </section>

        <section className="panel overflow-hidden">
          <div className="overflow-auto">
            <table className="w-full min-w-[900px] border-collapse text-sm">
              <thead className="bg-mist text-left text-slate-600">
                <tr>
                  <th className="px-3 py-2">兑换码</th>
                  <th className="px-3 py-2">次数</th>
                  <th className="px-3 py-2">状态</th>
                  <th className="px-3 py-2">创建时间</th>
                  <th className="px-3 py-2">最近登录</th>
                  <th className="px-3 py-2">备注</th>
                  <th className="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {cards.map((card) => (
                  <tr key={card.code} className="border-t border-line">
                    <td className="px-3 py-2 font-semibold">{card.code}</td>
                    <td className="px-3 py-2">{card.remainingUses}/{card.totalUses}</td>
                    <td className="px-3 py-2">{card.status === "active" ? "启用" : "禁用"}</td>
                    <td className="px-3 py-2">{new Date(card.createdAt).toLocaleString()}</td>
                    <td className="px-3 py-2">{card.lastLoginAt ? new Date(card.lastLoginAt).toLocaleString() : "-"}</td>
                    <td className="px-3 py-2">{card.note || "-"}</td>
                    <td className="px-3 py-2">
                      <button className="tiny-button w-auto px-3" onClick={() => toggleStatus(card)}>
                        {card.status === "active" ? "禁用" : "启用"}
                      </button>
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

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="panel">
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<AdminApp />);
