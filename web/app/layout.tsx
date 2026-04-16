import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Anvil | Anchor to Pinocchio and Quasar",
  description:
    "Compile familiar Anchor source into leaner Solana runtime references with live demos and CU comparisons.",
  openGraph: {
    title: "Anvil",
    description:
      "Anchor to Pinocchio and Quasar with a cleaner compute story, supported demos, and live runtime output previews.",
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
