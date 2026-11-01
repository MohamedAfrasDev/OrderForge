import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SandboxBanner } from "@/components/sandbox-banner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OrderForge",
  description:
    "Turn a vague custom-order request into an approved, PayPal-authorized order. Sandbox demo with simulated data.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <SandboxBanner />
        {children}
      </body>
    </html>
  );
}
