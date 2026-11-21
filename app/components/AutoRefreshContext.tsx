"use client";

import { createContext, useContext, useState, type Dispatch, type SetStateAction } from "react";

type AutoRefreshContextValue = {
  autoRefresh: boolean;
  setAutoRefresh: Dispatch<SetStateAction<boolean>>;
};

const AutoRefreshContext = createContext<AutoRefreshContextValue | null>(null);

export function AutoRefreshProvider({ children }: { children: React.ReactNode }) {
  const [autoRefresh, setAutoRefresh] = useState(false);

  return (
    <AutoRefreshContext.Provider value={{ autoRefresh, setAutoRefresh }}>
      {children}
    </AutoRefreshContext.Provider>
  );
}

export function useAutoRefresh() {
  const context = useContext(AutoRefreshContext);
  if (!context) throw new Error("useAutoRefresh must be used within AutoRefreshProvider");
  return context;
}
