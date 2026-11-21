"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import { AutoRefreshProvider } from "./AutoRefreshContext";

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";

  useEffect(() => {
    const applyInitialTheme = () => {
      const saved = typeof window !== "undefined" ? window.localStorage.getItem("theme") : null;
      const prefersDark = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)").matches : true;
      const isDark = saved ? saved === "dark" : prefersDark;
      document.documentElement.classList.toggle("dark", isDark);
    };

    applyInitialTheme();
  }, []);

  if (isLoginPage) {
    return <>{children}</>;
  }

  return (
    <AutoRefreshProvider>
      <>
        <Sidebar />
        <div className="ml-56 min-h-screen">{children}</div>
      </>
    </AutoRefreshProvider>
  );
}
