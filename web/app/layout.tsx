import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { SITE } from "@/lib/site";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: "Anvil — Anchor → Pinocchio, byte-equal verified",
    template: "%s — Anvil",
  },
  description: SITE.description,
  openGraph: {
    title: "Anvil — Anchor → Pinocchio, with proof",
    description: SITE.description,
    url: SITE.url,
    siteName: "Anvil",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Anvil — Anchor → Pinocchio, with proof",
    description: SITE.description,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className={`${inter.className} min-h-full flex flex-col`}>{children}</body>
    </html>
  );
}
