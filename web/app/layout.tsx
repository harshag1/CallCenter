// Author: Harsha Gundala
// layout.tsx — root layout: typography and white canvas.

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { PRODUCT_NAME } from "@/lib/product";
import "./globals.css";

const sans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: PRODUCT_NAME,
  description: "Build reliable, provider-neutral realtime voice agents",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
