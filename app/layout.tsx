import type { Metadata } from "next";
import { DM_Sans, Fraunces } from "next/font/google";

import "./globals.css";

const sans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-sans"
});

const display = Fraunces({
  subsets: ["latin"],
  variable: "--font-display"
});

export const metadata: Metadata = {
  title: "Signals by Roomy Revenue",
  description: "Revenue intelligence for short-term rental operators",
  robots: {
    follow: false,
    index: false,
    googleBot: {
      follow: false,
      index: false,
      noimageindex: true
    }
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${display.variable}`}>{children}</body>
    </html>
  );
}
