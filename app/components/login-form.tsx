"use client";

import { FormEvent, useState } from "react";
import { withBasePath } from "@/lib/base-path";

export default function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(withBasePath("/api/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Login failed" }));
        setError(body.error ?? "Login failed");
        setLoading(false);
        return;
      }

      window.location.assign(withBasePath("/dashboard/select-client"));
    } catch {
      setError("We couldn't reach the server. Check your connection and try again.");
      setLoading(false);
    }
  }

  return (
    <form className="mt-8 space-y-4" onSubmit={onSubmit}>
      <label className="block text-sm font-medium">
        <span style={{ color: "var(--muted-text)" }}>Email</span>
        <input
          autoComplete="username"
          className="mt-2 w-full rounded-[20px] border bg-white px-4 py-3 outline-none transition focus-visible:border-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-100"
          style={{ borderColor: "var(--border)" }}
          name="roomy_email"
          placeholder="you@company.com"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </label>

      <label className="block text-sm font-medium">
        <span style={{ color: "var(--muted-text)" }}>Password</span>
        <input
          autoComplete="current-password"
          className="mt-2 w-full rounded-[20px] border bg-white px-4 py-3 outline-none transition focus-visible:border-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-100"
          style={{ borderColor: "var(--border)" }}
          name="roomy_password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          minLength={8}
        />
      </label>

      {error ? (
        <p
          role="alert"
          className="rounded-2xl border px-4 py-3 text-sm"
          style={{ borderColor: "rgba(187,75,82,0.2)", background: "rgba(187,75,82,0.08)", color: "var(--delta-negative)" }}
        >
          {error}
        </p>
      ) : null}

      <button
        className="w-full rounded-full px-4 py-3 text-sm font-semibold text-white transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-100 disabled:opacity-60"
        style={{ background: "var(--green-dark)" }}
        type="submit"
        disabled={loading}
      >
        {loading ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}
