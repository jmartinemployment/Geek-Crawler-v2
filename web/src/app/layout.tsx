import type { Metadata } from "next";
import { AppNav, PhaseBanner } from "@/components/shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Geek-Crawler v2",
  description: "Local operator UI for Crawlee crawls (localhost)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <AppNav />
        <PhaseBanner />
        <main className="main">{children}</main>
      </body>
    </html>
  );
}
