import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Anvil | Anchor to Pinocchio and Native, byte-equal verified",
  description:
    "Compile Anchor source into Pinocchio or Native Rust with byte-equal differential verification, live CU comparisons, and runtime previews.",
  openGraph: {
    title: "Anvil",
    description:
      "Anchor to Pinocchio and Native Rust with byte-equal differential verification, supported demos, and live runtime output previews.",
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
