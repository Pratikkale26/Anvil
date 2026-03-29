import type { Metadata } from "next";
import "./globals.css";

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
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
