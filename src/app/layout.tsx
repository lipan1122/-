import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "云栖 PMS · 酒店管理系统",
  description: "前台、预订、房态、收银、客房、夜审一体化酒店管理",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
