"use client";

import { useEffect, useState } from "react";

import type { RecsClientSummary } from "@/lib/recs/data";

import RecsCalendarView from "./recs-calendar-view";
import RecsOverview from "./recs-overview";

type HomeView = "clients" | "calendar";

/**
 * Thin client wrapper for the internal Pricing Recommendations page: a
 * "Clients | Calendar" toggle (persisted as localStorage "recsHomeView",
 * default "clients") switching between the existing per-client overview and
 * the master calendar view. The server component keeps loading
 * loadRecsOverview(); the calendar fetches its own payload on mount.
 */
export default function RecsHome({ initialClients }: { initialClients: RecsClientSummary[] }) {
  const [view, setView] = useState<HomeView>("clients");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("recsHomeView");
      if (stored === "calendar" || stored === "clients") setView(stored);
    } catch {
      // localStorage unavailable — default stands
    }
  }, []);

  const pick = (next: HomeView) => {
    setView(next);
    try {
      window.localStorage.setItem("recsHomeView", next);
    } catch {
      // ignore
    }
  };

  const segStyle = (on: boolean): React.CSSProperties =>
    on
      ? { background: "var(--green-dark)", color: "#fff", border: 0 }
      : { background: "transparent", color: "var(--muted-text)", border: 0 };

  return (
    <div className="relative">
      <div className="pointer-events-none absolute left-0 right-0 top-4 z-30 flex justify-center sm:top-6">
        <span
          className="pointer-events-auto inline-flex items-stretch overflow-hidden rounded-full border shadow-sm"
          role="group"
          aria-label="Recommendations view"
          style={{ borderColor: "var(--border-strong)", background: "var(--bg-strong)", height: 32 }}
        >
          <button
            type="button"
            className="px-4 text-xs font-semibold"
            style={segStyle(view === "clients")}
            onClick={() => pick("clients")}
          >
            Clients
          </button>
          <button
            type="button"
            className="px-4 text-xs font-semibold"
            style={segStyle(view === "calendar")}
            onClick={() => pick("calendar")}
          >
            Calendar
          </button>
        </span>
      </div>
      {view === "clients" ? <RecsOverview initialClients={initialClients} /> : <RecsCalendarView />}
    </div>
  );
}
