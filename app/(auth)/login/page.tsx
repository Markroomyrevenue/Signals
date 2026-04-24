import Image from "next/image";

import LoginForm from "@app/components/login-form";
import { withBasePath } from "@/lib/base-path";

export default function LoginPage() {
  return (
    <main className="app-shell relative min-h-screen px-5 py-10 sm:px-8">
      <div className="mx-auto grid min-h-[calc(100vh-5rem)] max-w-6xl gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <section
          className="order-2 glass-panel rounded-[36px] border p-6 sm:p-8 lg:p-10 xl:order-1"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-[22px] bg-white/90 shadow-sm">
              <Image src={withBasePath("/logo.jpg")} alt="Roomy" width={56} height={56} className="rounded-[18px] object-cover" priority />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.32em]" style={{ color: "var(--muted-text)" }}>
                Roomy Revenue
              </p>
              <p className="font-display text-3xl">Signals</p>
            </div>
          </div>

          <div className="mt-10 max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.32em]" style={{ color: "var(--muted-text)" }}>
              Built For Decision Speed
            </p>
            <h1 className="font-display mt-3 text-5xl leading-tight text-balance sm:text-6xl">
              Revenue intelligence that stays clear even when the portfolio gets messy.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-8" style={{ color: "var(--muted-text)" }}>
              Roomy turns noisy reservation data into practical signals for operators, revenue managers, and experts who need depth without clutter.
            </p>
          </div>

          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {[
              {
                title: "Action-first home",
                body: "See what needs attention next before digging through tables."
              },
              {
                title: "Commercial depth",
                body: "Pace, booking windows, drilldowns, and advanced metrics in one place."
              },
              {
                title: "Operator clarity",
                body: "Keeps the day-to-day work clear, practical, and easy to move through."
              }
            ].map((item) => (
              <div key={item.title} className="rounded-[24px] border bg-white/75 p-5" style={{ borderColor: "var(--border)" }}>
                <p className="font-display text-2xl">{item.title}</p>
                <p className="mt-2 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section
          className="order-1 glass-panel flex items-center rounded-[36px] border p-6 sm:p-8 xl:order-2"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="w-full">
            <p className="text-xs font-semibold uppercase tracking-[0.32em]" style={{ color: "var(--muted-text)" }}>
              Sign In
            </p>
            <h2 className="font-display mt-3 text-4xl">Open your workspace</h2>
            <p className="mt-3 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
              Use your Roomy credentials to load the latest portfolio signals.
            </p>

            <LoginForm />
          </div>
        </section>
      </div>
    </main>
  );
}
