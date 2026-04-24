import Image from "next/image";

import LoginForm from "@app/components/login-form";
import { withBasePath } from "@/lib/base-path";

export default function LoginPage() {
  return (
    <main className="app-shell relative flex min-h-screen items-center justify-center px-5 py-10 sm:px-8">
      <section
        className="glass-panel w-full max-w-md rounded-[36px] border p-8 sm:p-10"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-[20px] bg-white/90 shadow-sm">
            <Image
              src={withBasePath("/logo.jpg")}
              alt="Roomy"
              width={48}
              height={48}
              className="rounded-[16px] object-cover"
              priority
            />
          </div>
          <div>
            <p
              className="text-xs font-semibold uppercase tracking-[0.32em]"
              style={{ color: "var(--muted-text)" }}
            >
              Roomy Revenue
            </p>
            <p className="font-display text-3xl">Signals</p>
          </div>
        </div>

        <h1 className="font-display mt-8 text-3xl">Sign in</h1>

        <LoginForm />
      </section>
    </main>
  );
}
