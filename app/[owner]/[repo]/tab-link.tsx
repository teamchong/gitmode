"use client";

import { usePathname } from "next/navigation";

export function TabLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const isActive = pathname === href || pathname.startsWith(href + "/");
  // For the Code tab (repo root), only match exact
  const isCodeTab = !href.includes("/commits") && !href.includes("/branches") && !href.includes("/tags");
  const active = isCodeTab
    ? pathname === href || pathname.startsWith(href + "/tree") || pathname.startsWith(href + "/blob")
    : isActive;

  return (
    <a
      href={href}
      style={{
        padding: "8px 16px",
        color: active ? "var(--text)" : "var(--text-secondary)",
        borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
        fontWeight: active ? 600 : 400,
      }}
    >
      {children}
    </a>
  );
}
