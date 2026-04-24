import type { ReactNode } from "react";

type WorkspaceLoadingScreenProps = {
  kicker?: string;
  title: string;
  description: string;
  fixed?: boolean;
  children?: ReactNode;
};

export default function WorkspaceLoadingScreen({
  kicker = "Roomy Revenue",
  title,
  description,
  fixed = false,
  children
}: WorkspaceLoadingScreenProps) {
  return (
    <div
      className={
        fixed
          ? "app-shell fixed inset-0 z-[140] flex items-center justify-center px-6 py-12"
          : "app-shell relative flex min-h-screen items-center justify-center px-6 py-12"
      }
      style={fixed ? { background: "rgba(247, 244, 236, 0.94)", backdropFilter: "blur(8px)" } : undefined}
    >
      <div className="glass-panel w-full max-w-xl rounded-[28px] border panel-border p-8 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.32em]" style={{ color: "var(--muted-text)" }}>
          {kicker}
        </p>
        <h1 className="font-display mt-2 text-4xl text-balance">{title}</h1>
        <p className="mt-4 text-base" style={{ color: "var(--muted-text)" }}>
          {description}
        </p>
        <div
          className="mx-auto mt-6 h-12 w-12 animate-spin rounded-full border-4"
          style={{ borderColor: "rgba(22, 71, 51, 0.16)", borderTopColor: "var(--green-dark)" }}
        />
        {children ? <div className="mt-6">{children}</div> : null}
      </div>
    </div>
  );
}
