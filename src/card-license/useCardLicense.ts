import { useCallback, useEffect, useState } from "react";
import type { CardSession } from "../types";
import { cardApi } from "./api";

export const useCardLicense = () => {
  const [card, setCard] = useState<CardSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    try {
      setCard(await cardApi.me());
      setMessage("");
    } catch {
      setCard(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = async (code: string) => {
    setIsLoading(true);
    try {
      const nextCard = await cardApi.login(code);
      setCard(nextCard);
      setMessage("授权成功。");
    } catch (error) {
      setCard(null);
      setMessage(error instanceof Error ? error.message : "授权失败。");
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    await cardApi.logout().catch(() => undefined);
    setCard(null);
    setMessage("已退出授权登录。");
  };

  const setCardFromUsage = (nextCard: CardSession) => {
    setCard(nextCard);
    if (nextCard.remainingUses <= 0) {
      setMessage("当前兑换码次数已用完。");
    }
  };

  const blockedReason = !card ? "请先输入兑换码。" : card.remainingUses <= 0 ? "当前兑换码次数已用完。" : "";

  return {
    card,
    isLoading,
    message,
    blockedReason,
    login,
    logout,
    refresh,
    setCardFromUsage,
    setMessage,
  };
};
