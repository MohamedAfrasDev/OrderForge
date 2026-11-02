import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Merchant sign in · OrderForge" };

export default function MerchantLoginPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-24">
      <h1 className="text-2xl font-semibold tracking-tight">Merchant sign in</h1>
      <LoginForm />
    </main>
  );
}
