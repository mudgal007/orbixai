import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: { default: "ORBIX AI — The Control Plane for Autonomous Work", template: "%s · ORBIX AI" },
  description: "Turn goals into secure, observable, recoverable AI workflows with verifiable outcomes.",
};

export const viewport: Viewport = { themeColor: "#060a14", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
