"use client";

export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="app-shell relative flex min-h-screen items-center justify-center px-6 py-12">
      <div className="glass-panel w-full max-w-2xl rounded-[28px] border panel-border p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.32em]" style={{ color: "var(--muted-text)" }}>
          Something Went Wrong
        </p>
        <h1 className="font-display mt-4 text-4xl text-balance">The workspace hit a problem before it could finish loading.</h1>
        <p className="mt-4 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
          {error.message || "Unexpected application error."}
        </p>
        <button
          type="button"
          className="mt-6 rounded-full px-5 py-3 text-sm font-semibold text-white"
          style={{ background: "var(--green-dark)" }}
          onClick={reset}
        >
          Try again
        </button>
      </div>
    </main>
  );
}
