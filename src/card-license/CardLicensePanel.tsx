import { LogOut, TicketCheck } from "lucide-react";
import { useState } from "react";
import type { CardSession } from "../types";

export function CardLicensePanel({
  card,
  isLoading,
  message,
  onLogin,
  onLogout,
}: {
  card: CardSession | null;
  isLoading: boolean;
  message: string;
  onLogin: (code: string) => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const [code, setCode] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    await onLogin(code);
    setCode("");
  };

  if (card) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <span className="font-semibold">{card.code}</span>
          <span className="ml-2">剩余 {card.remainingUses}/{card.totalUses} 次</span>
        </div>
        <button className="icon-button" type="button" onClick={onLogout} title="退出卡密登录">
          <LogOut size={17} />
        </button>
      </div>
    );
  }

  return (
    <form className="flex min-w-[260px] flex-wrap items-center justify-end gap-2" onSubmit={submit}>
      <input
        className="input h-10 w-36 uppercase"
        value={code}
        onChange={(event) => setCode(event.target.value.toUpperCase())}
        placeholder="输入卡密"
        maxLength={6}
      />
      <button className="secondary-button min-h-10 py-2" type="submit" disabled={isLoading || code.trim().length < 6}>
        <TicketCheck size={16} />
        登录
      </button>
      {message && <span className="w-full text-right text-xs text-slate-500">{message}</span>}
    </form>
  );
}
