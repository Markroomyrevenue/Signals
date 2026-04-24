import { useEffect, useMemo, useRef, useState } from "react";

import {
  CALENDAR_SETTINGS_MONTH_OPTIONS,
  CALENDAR_SETTINGS_WEEKDAY_OPTIONS,
  type PricingCalendarRow
} from "./calendar-utils";

type CalendarSettingsScope = "portfolio" | "group" | "property";
type CalendarSettingsSectionId =
  | "base_pricing"
  | "occupancy"
  | "demand"
  | "seasonality"
  | "day_of_week"
  | "safety_net"
  | "local_events"
  | "last_minute"
  | "stay_rules";
type CalendarSensitivityTarget = "seasonality" | "dayOfWeek";
type CalendarSensitivityMode = "less_sensitive" | "recommended" | "more_sensitive" | "custom";
type CalendarSettingsScopeOption = {
  id: CalendarSettingsScope;
  label: string;
};
type CalendarSettingsMenuItem = {
  id: CalendarSettingsSectionId;
  label: string;
};
type CalendarCustomGroup = {
  label: string;
  listingIds: string[];
};
type CalendarSettingsListField = "localEvents" | "lastMinuteAdjustments" | "gapNightAdjustments";
type LocalEventDateMode = "range" | "multiple";

function normalizeSettingsKey(value: string): string {
  return value.trim().toLowerCase();
}

function isDateOnlyValue(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function normalizeLocalEventSelectedDates(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isDateOnlyValue).map((item) => item.trim()))].sort((left, right) => left.localeCompare(right));
}

function localEventDateMode(event: Record<string, any>): LocalEventDateMode {
  if (event.dateSelectionMode === "multiple") return "multiple";
  return normalizeLocalEventSelectedDates(event.selectedDates).length > 0 ? "multiple" : "range";
}

function formatLocalEventDateLabel(dateOnly: string): string {
  const parsed = new Date(`${dateOnly}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return dateOnly;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(parsed);
}

function localEventDateSummary(event: Record<string, any>, fallbackDate: string): string {
  const mode = localEventDateMode(event);
  const selectedDates = normalizeLocalEventSelectedDates(event.selectedDates);
  const startDate = isDateOnlyValue(event.startDate) ? event.startDate : fallbackDate;
  const endDate = isDateOnlyValue(event.endDate) ? event.endDate : startDate;

  if (mode === "multiple" && selectedDates.length > 0) {
    if (selectedDates.length === 1) return formatLocalEventDateLabel(selectedDates[0]);
    if (selectedDates.length === 2) {
      return `${formatLocalEventDateLabel(selectedDates[0])} and ${formatLocalEventDateLabel(selectedDates[1])}`;
    }
    return `${selectedDates.length} selected dates`;
  }

  return startDate === endDate
    ? formatLocalEventDateLabel(startDate)
    : `${formatLocalEventDateLabel(startDate)} to ${formatLocalEventDateLabel(endDate)}`;
}

function formatNightLabel(value: number): string {
  return `${value} night${value === 1 ? "" : "s"}`;
}

function summarizeCurrentMinimumStay(rows: PricingCalendarRow[]): { valueLabel: string; detail: string } {
  const values = rows.flatMap((row) =>
    row.cells.flatMap((cell) => {
      if (cell.minStay === null || !Number.isFinite(cell.minStay)) return [];
      return [Math.max(1, Math.round(cell.minStay))];
    })
  );

  if (values.length === 0) {
    return {
      valueLabel: "No live stay rule found",
      detail: "The loaded Hostaway calendar does not expose a minimum stay for this scope yet."
    };
  }

  const counts = new Map<number, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  const uniqueValues = [...counts.keys()].sort((left, right) => left - right);
  const minValue = uniqueValues[0] ?? 1;
  const maxValue = uniqueValues[uniqueValues.length - 1] ?? minValue;
  const typicalValue =
    [...counts.entries()].sort((left, right) => (right[1] === left[1] ? left[0] - right[0] : right[1] - left[1]))[0]?.[0] ?? minValue;

  if (minValue === maxValue) {
    return {
      valueLabel: formatNightLabel(minValue),
      detail: `Hostaway is currently enforcing ${formatNightLabel(minValue)} across the loaded month.`
    };
  }

  return {
    valueLabel: `${formatNightLabel(minValue)} to ${formatNightLabel(maxValue)}`,
    detail: `${formatNightLabel(typicalValue)} is the most common live minimum stay in the loaded month.`
  };
}

function LocalEventDatePicker({
  event,
  index,
  fallbackDate,
  updateCalendarSettingsListItem
}: {
  event: Record<string, any>;
  index: number;
  fallbackDate: string;
  updateCalendarSettingsListItem: (field: CalendarSettingsListField, index: number, key: string, value: any) => void;
}) {
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const mode = useMemo(() => localEventDateMode(event), [event]);
  const selectedDates = useMemo(() => normalizeLocalEventSelectedDates(event.selectedDates), [event.selectedDates]);
  const displayStartDate = isDateOnlyValue(event.startDate) ? event.startDate : fallbackDate;
  const displayEndDate = isDateOnlyValue(event.endDate) ? event.endDate : displayStartDate;
  const [open, setOpen] = useState(false);
  const [pendingDate, setPendingDate] = useState<string>(selectedDates[0] ?? displayStartDate);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(pointerEvent: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(pointerEvent.target as Node)) {
        setOpen(false);
      }
    }

    function handleEscape(keyboardEvent: KeyboardEvent) {
      if (keyboardEvent.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  useEffect(() => {
    if (selectedDates.length > 0) {
      setPendingDate((current) => (current ? current : selectedDates[selectedDates.length - 1]));
      return;
    }

    setPendingDate((current) => (current ? current : displayStartDate));
  }, [displayStartDate, selectedDates]);

  function updateLocalEventDates(next: {
    mode?: LocalEventDateMode;
    startDate?: string;
    endDate?: string;
    selectedDates?: string[];
  }) {
    const nextMode = next.mode ?? mode;

    if (nextMode === "multiple") {
      const nextSelectedDates = normalizeLocalEventSelectedDates(next.selectedDates ?? selectedDates);
      const firstSelectedDate = nextSelectedDates[0] ?? displayStartDate;
      const lastSelectedDate = nextSelectedDates[nextSelectedDates.length - 1] ?? firstSelectedDate;
      updateCalendarSettingsListItem("localEvents", index, "dateSelectionMode", "multiple");
      updateCalendarSettingsListItem("localEvents", index, "selectedDates", nextSelectedDates);
      updateCalendarSettingsListItem("localEvents", index, "startDate", firstSelectedDate);
      updateCalendarSettingsListItem("localEvents", index, "endDate", lastSelectedDate);
      return;
    }

    const nextStartDate = isDateOnlyValue(next.startDate) ? next.startDate : displayStartDate;
    const nextEndDateRaw = isDateOnlyValue(next.endDate) ? next.endDate : displayEndDate;
    const nextEndDate = nextEndDateRaw < nextStartDate ? nextStartDate : nextEndDateRaw;
    updateCalendarSettingsListItem("localEvents", index, "dateSelectionMode", "range");
    updateCalendarSettingsListItem("localEvents", index, "selectedDates", []);
    updateCalendarSettingsListItem("localEvents", index, "startDate", nextStartDate);
    updateCalendarSettingsListItem("localEvents", index, "endDate", nextEndDate);
  }

  function handleModeChange(nextMode: LocalEventDateMode) {
    if (nextMode === mode) return;

    if (nextMode === "multiple") {
      const seededDates = selectedDates.length > 0 ? selectedDates : [displayStartDate, displayEndDate];
      updateLocalEventDates({ mode: "multiple", selectedDates: seededDates });
      return;
    }

    updateLocalEventDates({
      mode: "range",
      startDate: selectedDates[0] ?? displayStartDate,
      endDate: selectedDates[selectedDates.length - 1] ?? displayEndDate
    });
  }

  function addSelectedDate() {
    if (!isDateOnlyValue(pendingDate)) return;
    updateLocalEventDates({ mode: "multiple", selectedDates: [...selectedDates, pendingDate] });
    setPendingDate(pendingDate);
  }

  function removeSelectedDate(dateOnly: string) {
    const nextDates = selectedDates.filter((candidate) => candidate !== dateOnly);
    if (nextDates.length === 0) {
      updateLocalEventDates({
        mode: "range",
        startDate: displayStartDate,
        endDate: displayStartDate
      });
      return;
    }
    updateLocalEventDates({
      mode: "multiple",
      selectedDates: nextDates
    });
  }

  const pendingDateExists = isDateOnlyValue(pendingDate) && selectedDates.includes(pendingDate);

  return (
    <div ref={pickerRef} className="relative">
      <button
        type="button"
        className="w-full rounded-md border bg-white px-3 py-2 text-left outline-none transition hover:border-[var(--border-strong)]"
        style={{ borderColor: "var(--border)" }}
        onClick={() => setOpen((current) => !current)}
      >
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--muted-text)" }}>
          Dates
        </div>
        <div className="mt-1 text-sm font-semibold" style={{ color: "var(--navy-dark)" }}>
          {localEventDateSummary(event, fallbackDate)}
        </div>
        <div className="mt-1 text-[11px]" style={{ color: "var(--muted-text)" }}>
          {mode === "multiple" ? `${selectedDates.length} individual dates` : "Continuous date range"}
        </div>
      </button>

      {open ? (
        <div
          className="absolute left-0 top-[calc(100%+8px)] z-30 w-[min(360px,calc(100vw-4rem))] rounded-[12px] border bg-white p-3 shadow-[0_20px_40px_rgba(25,35,45,0.16)]"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="flex flex-wrap gap-2">
            {[
              { id: "range" as const, label: "Date range" },
              { id: "multiple" as const, label: "Multiple dates" }
            ].map((option) => (
              <button
                key={`event-date-mode-${option.id}`}
                type="button"
                className="rounded-full px-3 py-1.5 text-xs font-semibold"
                style={
                  mode === option.id
                    ? { background: "var(--green-dark)", color: "#ffffff" }
                    : { background: "rgba(248,250,249,0.9)", border: "1px solid var(--border)", color: "var(--navy-dark)" }
                }
                onClick={() => handleModeChange(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {mode === "range" ? (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--muted-text)" }}>
                Start
                <input
                  type="date"
                  className="mt-1.5 w-full rounded-md border px-3 py-2 text-sm outline-none"
                  style={{ borderColor: "var(--border)" }}
                  value={displayStartDate}
                  onChange={(evt) => updateLocalEventDates({ mode: "range", startDate: evt.target.value, endDate: displayEndDate })}
                />
              </label>
              <label className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--muted-text)" }}>
                End
                <input
                  type="date"
                  className="mt-1.5 w-full rounded-md border px-3 py-2 text-sm outline-none"
                  style={{ borderColor: "var(--border)" }}
                  value={displayEndDate}
                  onChange={(evt) => updateLocalEventDates({ mode: "range", startDate: displayStartDate, endDate: evt.target.value })}
                />
              </label>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              <div className="flex flex-wrap gap-2">
                <input
                  type="date"
                  className="min-w-[180px] flex-1 rounded-md border px-3 py-2 text-sm outline-none"
                  style={{ borderColor: "var(--border)" }}
                  value={pendingDate}
                  onChange={(evt) => setPendingDate(evt.target.value)}
                />
                <button
                  type="button"
                  className="rounded-md border px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                  disabled={!isDateOnlyValue(pendingDate) || pendingDateExists}
                  onClick={addSelectedDate}
                >
                  Add date
                </button>
              </div>

              <div className="flex max-h-[160px] flex-wrap gap-2 overflow-auto">
                {selectedDates.map((dateOnly) => (
                  <button
                    key={`selected-local-event-date-${dateOnly}`}
                    type="button"
                    className="rounded-full border px-3 py-1.5 text-xs font-semibold"
                    style={{ borderColor: "var(--border)", color: "var(--navy-dark)", background: "rgba(248,250,249,0.9)" }}
                    onClick={() => removeSelectedDate(dateOnly)}
                  >
                    {formatLocalEventDateLabel(dateOnly)} ×
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-3 rounded-[10px] bg-slate-50 px-3 py-2 text-[12px] leading-5" style={{ color: "var(--muted-text)" }}>
            {mode === "multiple"
              ? "Use multiple dates for scattered event nights without filling the gap between them."
              : "Use a range for events that apply on every night between the start and end date."}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function CalendarSettingsPanel({
  calendarSettingsScope,
  calendarSettingsSection,
  calendarSettingsScopeOptions,
  calendarSettingsMenu,
  effectiveCalendarSettingsGroupRef,
  effectiveCalendarSettingsPropertyId,
  allCustomGroups,
  calendarRows,
  calendarSettingsScopeReady,
  calendarSettingsDirty,
  calendarSettingsHasOverrides,
  calendarSettingsForm,
  calendarSettingsResolvedForm,
  calendarSeasonalityAdjustments,
  calendarDayOfWeekAdjustments,
  calendarDemandSensitivityLevel,
  pricingCalendarSelectedMonthStart,
  savingPricingSettings,
  loadingPricingSettings,
  setCalendarSettingsScope,
  setCalendarSettingsSection,
  setCalendarSettingsGroupRef,
  setCalendarSettingsPropertyId,
  updateCalendarSettingsField,
  activeCalendarSensitivityMode,
  applyCalendarSensitivityMode,
  setCalendarDemandSensitivityLevel,
  addCalendarSettingsListItem,
  removeCalendarSettingsListItem,
  updateCalendarSettingsListItem,
  handleDiscardCalendarSettingsChanges,
  handleSaveCalendarSettings,
  handleResetCalendarSettingsScope
}: {
  calendarSettingsScope: CalendarSettingsScope | null;
  calendarSettingsSection: CalendarSettingsSectionId;
  calendarSettingsScopeOptions: CalendarSettingsScopeOption[];
  calendarSettingsMenu: CalendarSettingsMenuItem[];
  effectiveCalendarSettingsGroupRef: string;
  effectiveCalendarSettingsPropertyId: string;
  allCustomGroups: CalendarCustomGroup[];
  calendarRows: PricingCalendarRow[];
  calendarSettingsScopeReady: boolean;
  calendarSettingsDirty: boolean;
  calendarSettingsHasOverrides: boolean;
  calendarSettingsForm: Record<string, any>;
  calendarSettingsResolvedForm: Record<string, any>;
  calendarSeasonalityAdjustments: Array<{ month: number; adjustmentPct: number }>;
  calendarDayOfWeekAdjustments: Array<{ weekday: number; adjustmentPct: number }>;
  calendarDemandSensitivityLevel: 1 | 2 | 3 | 4 | 5;
  pricingCalendarSelectedMonthStart: string;
  savingPricingSettings: boolean;
  loadingPricingSettings: boolean;
  setCalendarSettingsScope: (scope: CalendarSettingsScope) => void;
  setCalendarSettingsSection: (section: CalendarSettingsSectionId) => void;
  setCalendarSettingsGroupRef: (groupRef: string) => void;
  setCalendarSettingsPropertyId: (propertyId: string) => void;
  updateCalendarSettingsField: (field: string, value: any) => void;
  activeCalendarSensitivityMode: (target: CalendarSensitivityTarget) => CalendarSensitivityMode;
  applyCalendarSensitivityMode: (target: CalendarSensitivityTarget, mode: CalendarSensitivityMode) => void;
  setCalendarDemandSensitivityLevel: (level: 1 | 2 | 3 | 4 | 5) => void;
  addCalendarSettingsListItem: (field: CalendarSettingsListField) => void;
  removeCalendarSettingsListItem: (field: CalendarSettingsListField, index: number) => void;
  updateCalendarSettingsListItem: (field: CalendarSettingsListField, index: number, key: string, value: any) => void;
  handleDiscardCalendarSettingsChanges: () => void;
  handleSaveCalendarSettings: () => Promise<void> | void;
  handleResetCalendarSettingsScope: () => Promise<void> | void;
}) {
  const displayMinimumPriceOverride =
    calendarSettingsForm.minimumPriceOverride ?? calendarSettingsResolvedForm.minimumPriceOverride ?? "";
  const displayBasePriceOverride = calendarSettingsForm.basePriceOverride ?? calendarSettingsResolvedForm.basePriceOverride ?? "";
  const scopedCalendarRows = useMemo(() => {
    if (calendarSettingsScope === "property") {
      return calendarRows.filter((row) => row.listingId === effectiveCalendarSettingsPropertyId);
    }

    if (calendarSettingsScope === "group") {
      const selectedGroup = allCustomGroups.find(
        (group) => normalizeSettingsKey(group.label) === normalizeSettingsKey(effectiveCalendarSettingsGroupRef)
      );
      const listingIds = new Set(selectedGroup?.listingIds ?? []);
      return calendarRows.filter((row) => listingIds.has(row.listingId));
    }

    return calendarRows;
  }, [
    allCustomGroups,
    calendarRows,
    calendarSettingsScope,
    effectiveCalendarSettingsGroupRef,
    effectiveCalendarSettingsPropertyId
  ]);
  const currentMinimumStaySummary = useMemo(() => summarizeCurrentMinimumStay(scopedCalendarRows), [scopedCalendarRows]);

  return (
    <div className="h-full overflow-auto rounded-[10px] border bg-white/76 p-3" style={{ borderColor: "var(--border)" }}>
      {!calendarSettingsScope ? (
        <div className="mx-auto grid max-w-4xl gap-3">
          <div className="rounded-[10px] border bg-white px-4 py-4" style={{ borderColor: "var(--border)" }}>
            <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
              Choose Settings Scope
            </p>
            <p className="mt-2 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
              Start by choosing whether these pricing rules should apply to the whole portfolio, one group, or one property.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {calendarSettingsScopeOptions.map((scope) => (
              <button
                key={`calendar-settings-scope-card-${scope.id}`}
                type="button"
                className="rounded-[10px] border bg-white px-4 py-5 text-left transition-colors"
                style={{ borderColor: "var(--border)" }}
                onClick={() => {
                  setCalendarSettingsScope(scope.id);
                  setCalendarSettingsSection("base_pricing");
                }}
              >
                <div className="text-sm font-semibold" style={{ color: "var(--navy-dark)" }}>
                  {scope.label}
                </div>
                <div className="mt-2 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
                  {scope.id === "portfolio"
                    ? "Set the standard pricing rules for every property first."
                    : scope.id === "group"
                      ? "Tighten or relax pricing logic for a selected group."
                      : "Fine-tune one property without changing the wider rules."}
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid gap-3 xl:grid-cols-[260px_minmax(0,1fr)]">
          <div className="space-y-3">
            <div className="rounded-[10px] border bg-white p-3" style={{ borderColor: "var(--border)" }}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                Scope
              </p>
              <div className="mt-2 grid gap-2">
                {calendarSettingsScopeOptions.map((scope) => (
                  <button
                    key={`calendar-settings-scope-${scope.id}`}
                    type="button"
                    className="rounded-md px-3 py-2 text-left text-sm font-semibold"
                    style={
                      calendarSettingsScope === scope.id
                        ? { background: "var(--green-dark)", color: "#ffffff" }
                        : { background: "white", border: "1px solid var(--border)", color: "var(--navy-dark)" }
                    }
                    onClick={() => {
                      setCalendarSettingsScope(scope.id);
                      setCalendarSettingsSection("base_pricing");
                    }}
                  >
                    {scope.label}
                  </button>
                ))}
              </div>

              {calendarSettingsScope === "group" ? (
                <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                  Group
                  <select
                    className="mt-1.5 w-full rounded-md border bg-white px-3 py-2 text-sm outline-none"
                    style={{ borderColor: "var(--border)" }}
                    value={effectiveCalendarSettingsGroupRef}
                    onChange={(event) => setCalendarSettingsGroupRef(event.target.value)}
                  >
                    <option value="">{allCustomGroups.length === 0 ? "No groups available" : "Choose a group"}</option>
                    {allCustomGroups.map((group) => (
                      <option key={`calendar-settings-group-${group.label}`} value={group.label}>
                        {group.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {calendarSettingsScope === "property" ? (
                <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                  Property
                  <select
                    className="mt-1.5 w-full rounded-md border bg-white px-3 py-2 text-sm outline-none"
                    style={{ borderColor: "var(--border)" }}
                    value={effectiveCalendarSettingsPropertyId}
                    onChange={(event) => setCalendarSettingsPropertyId(event.target.value)}
                  >
                    {calendarRows.map((row) => (
                      <option key={`calendar-settings-property-${row.listingId}`} value={row.listingId}>
                        {row.listingName}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <div className="mt-3 rounded-[8px] bg-slate-50 px-3 py-3 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
                Portfolio rules set the base. Group and property settings only change the selected scope.
              </div>

              <div
                className="mt-3 inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]"
                style={
                  savingPricingSettings
                    ? { background: "rgba(31,122,77,0.08)", color: "var(--green-dark)" }
                    : calendarSettingsDirty
                      ? { background: "rgba(176,122,25,0.12)", color: "var(--mustard-dark)" }
                      : { background: "rgba(228,234,240,0.7)", color: "var(--muted-text)" }
                }
              >
                {savingPricingSettings ? "Saving" : calendarSettingsDirty ? "Unsaved changes" : "All changes saved"}
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-md px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                  style={{ background: "var(--green-dark)" }}
                  disabled={savingPricingSettings || loadingPricingSettings || !calendarSettingsScopeReady || !calendarSettingsDirty}
                  onClick={() => void handleSaveCalendarSettings()}
                >
                  {savingPricingSettings ? "Saving..." : "Save changes"}
                </button>
                <button
                  type="button"
                  className="rounded-md border px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                  style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
                  disabled={savingPricingSettings || loadingPricingSettings || !calendarSettingsDirty}
                  onClick={handleDiscardCalendarSettingsChanges}
                >
                  Discard changes
                </button>
                <button
                  type="button"
                  className="rounded-md border px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                  style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
                  disabled={savingPricingSettings || loadingPricingSettings || !calendarSettingsScopeReady || !calendarSettingsHasOverrides}
                  onClick={() => void handleResetCalendarSettingsScope()}
                >
                  Reset Scope
                </button>
              </div>
            </div>

            <div className="rounded-[10px] border bg-white p-2" style={{ borderColor: "var(--border)" }}>
              <div className="grid gap-1">
                {calendarSettingsMenu.map((item) => (
                  <button
                    key={`calendar-settings-menu-${item.id}`}
                    type="button"
                    className="rounded-md px-3 py-2 text-left text-sm font-semibold"
                    style={
                      calendarSettingsSection === item.id
                        ? { background: "rgba(22,71,51,0.1)", color: "var(--green-dark)" }
                        : { color: "var(--navy-dark)" }
                    }
                    onClick={() => setCalendarSettingsSection(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-[10px] border bg-white p-3" style={{ borderColor: "var(--border)" }}>
            {loadingPricingSettings ? (
              <div className="rounded-[8px] border bg-slate-50 px-3 py-3 text-sm" style={{ borderColor: "var(--border)" }}>
                Loading pricing settings for this scope...
              </div>
            ) : !calendarSettingsScopeReady ? (
              <div className="rounded-[8px] border bg-slate-50 px-3 py-3 text-sm" style={{ borderColor: "var(--border)" }}>
                {calendarSettingsScope === "group"
                  ? "Choose a group to load pricing settings."
                  : "Choose a property to load pricing settings."}
              </div>
            ) : (
              <>
                {calendarSettingsSection === "base_pricing" ? (
                  <div className="grid gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                        Base Price & Minimum Price
                      </p>
                      <p className="mt-1 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
                        Set the pricing anchor for this scope and choose the property quality that best matches the home.
                      </p>
                    </div>
                    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
                      <div className="rounded-[8px] border p-3" style={{ borderColor: "var(--border)" }}>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                          Quality Tier
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {[
                            { id: "low_scale" as const, label: "Value" },
                            { id: "mid_scale" as const, label: "Standard" },
                            { id: "upscale" as const, label: "Premium" }
                          ].map((option) => (
                            <button
                              key={`settings-quality-${option.id}`}
                              type="button"
                              className="rounded-md px-3 py-2 text-sm font-semibold"
                              style={
                                calendarSettingsForm.qualityTier === option.id
                                  ? { background: "var(--green-dark)", color: "#ffffff" }
                                  : { background: "white", border: "1px solid var(--border)", color: "var(--navy-dark)" }
                              }
                              onClick={() => updateCalendarSettingsField("qualityTier", option.id)}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                          Minimum Price
                          <input
                            type="number"
                            min="0"
                            step="1"
                            className="mt-1.5 w-full rounded-md border bg-white px-3 py-2 text-sm outline-none"
                            style={{ borderColor: "var(--border)" }}
                            value={displayMinimumPriceOverride}
                            onChange={(event) =>
                              updateCalendarSettingsField("minimumPriceOverride", event.target.value === "" ? null : Number(event.target.value))
                            }
                          />
                        </label>
                        <label className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                          Base Price
                          <input
                            type="number"
                            min="0"
                            step="1"
                            className="mt-1.5 w-full rounded-md border bg-white px-3 py-2 text-sm outline-none"
                            style={{ borderColor: "var(--border)" }}
                            value={displayBasePriceOverride}
                            onChange={(event) =>
                              updateCalendarSettingsField("basePriceOverride", event.target.value === "" ? null : Number(event.target.value))
                            }
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                ) : null}

                {calendarSettingsSection === "occupancy" ? (
                  <div className="grid gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                        Occupancy
                      </p>
                      <p className="mt-1 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
                        Occupancy pace pressure changes how hard pricing reacts when occupancy is very low or very high. Ungrouped listings use
                        portfolio occupancy automatically.
                      </p>
                    </div>
                    <div className="grid gap-3 lg:grid-cols-2">
                      <div className="rounded-[8px] border p-3" style={{ borderColor: "var(--border)" }}>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                          Occupancy Scope
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {[
                            { id: "portfolio" as const, label: "Portfolio" },
                            { id: "group" as const, label: "Group if grouped" }
                          ].map((option) => (
                            <button
                              key={`settings-occ-scope-${option.id}`}
                              type="button"
                              className="rounded-md px-3 py-2 text-sm font-semibold"
                              style={
                                calendarSettingsForm.occupancyScope === option.id
                                  ? { background: "var(--mustard-dark)", color: "#ffffff" }
                                  : { background: "white", border: "1px solid var(--border)", color: "var(--navy-dark)" }
                              }
                              onClick={() => updateCalendarSettingsField("occupancyScope", option.id)}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="rounded-[8px] border p-3" style={{ borderColor: "var(--border)" }}>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                          Occupancy Pace Pressure
                        </p>
                        <div className="mt-2 grid gap-2">
                          {[
                            {
                              id: "conservative" as const,
                              label: "More Conservative",
                              description: "Uses the same logic, but with lighter discounts and premiums at the extremes."
                            },
                            {
                              id: "recommended" as const,
                              label: "Recommended",
                              description: "Our standard balance of occupancy protection and yield."
                            },
                            {
                              id: "aggressive" as const,
                              label: "More Aggressive",
                              description: "Leans harder into discounts or uplifts when occupancy is far from target."
                            }
                          ].map((option) => (
                            <button
                              key={`settings-occ-pressure-${option.id}`}
                              type="button"
                              className="rounded-md border px-3 py-2 text-left"
                              style={
                                calendarSettingsForm.occupancyPressureMode === option.id
                                  ? { borderColor: "rgba(22,71,51,0.22)", background: "rgba(22,71,51,0.08)" }
                                  : { borderColor: "var(--border)" }
                              }
                              onClick={() => updateCalendarSettingsField("occupancyPressureMode", option.id)}
                            >
                              <div className="text-sm font-semibold">{option.label}</div>
                              <div className="mt-1 text-sm leading-5" style={{ color: "var(--muted-text)" }}>
                                {option.description}
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {calendarSettingsSection === "demand" ? (
                  <div className="grid gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                        Demand
                      </p>
                      <p className="mt-1 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
                        Standard recommended demand sensitivity is 3 out of 5. Choose 4 or 5 for a stronger response, or 1 or 2 for a more conservative one.
                      </p>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-5">
                      {[1, 2, 3, 4, 5].map((level) => (
                        <button
                          key={`calendar-demand-level-${level}`}
                          type="button"
                          className="rounded-md border px-3 py-3 text-left"
                          style={
                            calendarDemandSensitivityLevel === level
                              ? { borderColor: "rgba(22,71,51,0.22)", background: "rgba(22,71,51,0.08)" }
                              : { borderColor: "var(--border)" }
                          }
                          onClick={() => setCalendarDemandSensitivityLevel(level as 1 | 2 | 3 | 4 | 5)}
                        >
                          <div className="text-sm font-semibold">Level {level}</div>
                          <div className="mt-1 text-[12px]" style={{ color: "var(--muted-text)" }}>
                            {level <= 2 ? "More conservative" : level === 3 ? "Recommended" : "More aggressive"}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {calendarSettingsSection === "seasonality" ? (
                  <div className="grid gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                        Seasonality
                      </p>
                      <p className="mt-1 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
                        Recommended uses the city baseline. Manual lets you set each month as a percentage above or below the overall base price.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { id: "less_sensitive" as const, label: "Less Sensitive" },
                        { id: "recommended" as const, label: "Recommended" },
                        { id: "more_sensitive" as const, label: "More Sensitive" },
                        { id: "custom" as const, label: "Manual" }
                      ].map((option) => (
                        <button
                          key={`settings-seasonality-${option.id}`}
                          type="button"
                          className="rounded-md px-3 py-2 text-sm font-semibold"
                          style={
                            activeCalendarSensitivityMode("seasonality") === option.id
                              ? { background: "var(--green-dark)", color: "#ffffff" }
                              : { background: "white", border: "1px solid var(--border)", color: "var(--navy-dark)" }
                          }
                          onClick={() => applyCalendarSensitivityMode("seasonality", option.id)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    {activeCalendarSensitivityMode("seasonality") === "custom" ? (
                      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                        {CALENDAR_SETTINGS_MONTH_OPTIONS.map((month) => {
                          const value = calendarSeasonalityAdjustments.find((item) => item.month === month.month)?.adjustmentPct ?? 0;
                          return (
                            <label
                              key={`calendar-seasonality-adjustment-${month.month}`}
                              className="rounded-[8px] border px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em]"
                              style={{ borderColor: "var(--border)", color: "var(--muted-text)" }}
                            >
                              {month.label}
                              <input
                                type="number"
                                step="1"
                                className="mt-1.5 w-full rounded-md border bg-white px-3 py-2 text-sm font-medium outline-none"
                                style={{ borderColor: "var(--border)", color: "var(--navy-dark)" }}
                                value={value}
                                onChange={(event) => {
                                  const next = calendarSeasonalityAdjustments.map((item) =>
                                    item.month === month.month ? { ...item, adjustmentPct: Number(event.target.value) } : item
                                  );
                                  updateCalendarSettingsField("seasonalityMonthlyAdjustments", next);
                                }}
                              />
                            </label>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {calendarSettingsSection === "day_of_week" ? (
                  <div className="grid gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                        Day Of Week
                      </p>
                      <p className="mt-1 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
                        Recommended uses the city weekday pattern. Manual sets each weekday as a percentage above or below the overall base price.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { id: "less_sensitive" as const, label: "Less Sensitive" },
                        { id: "recommended" as const, label: "Recommended" },
                        { id: "more_sensitive" as const, label: "More Sensitive" },
                        { id: "custom" as const, label: "Manual" }
                      ].map((option) => (
                        <button
                          key={`settings-dow-${option.id}`}
                          type="button"
                          className="rounded-md px-3 py-2 text-sm font-semibold"
                          style={
                            activeCalendarSensitivityMode("dayOfWeek") === option.id
                              ? { background: "var(--green-dark)", color: "#ffffff" }
                              : { background: "white", border: "1px solid var(--border)", color: "var(--navy-dark)" }
                          }
                          onClick={() => applyCalendarSensitivityMode("dayOfWeek", option.id)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    {activeCalendarSensitivityMode("dayOfWeek") === "custom" ? (
                      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                        {CALENDAR_SETTINGS_WEEKDAY_OPTIONS.map((weekday) => {
                          const value = calendarDayOfWeekAdjustments.find((item) => item.weekday === weekday.weekday)?.adjustmentPct ?? 0;
                          return (
                            <label
                              key={`calendar-dow-adjustment-${weekday.weekday}`}
                              className="rounded-[8px] border px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em]"
                              style={{ borderColor: "var(--border)", color: "var(--muted-text)" }}
                            >
                              {weekday.label}
                              <input
                                type="number"
                                step="1"
                                className="mt-1.5 w-full rounded-md border bg-white px-3 py-2 text-sm font-medium outline-none"
                                style={{ borderColor: "var(--border)", color: "var(--navy-dark)" }}
                                value={value}
                                onChange={(event) => {
                                  const next = calendarDayOfWeekAdjustments.map((item) =>
                                    item.weekday === weekday.weekday ? { ...item, adjustmentPct: Number(event.target.value) } : item
                                  );
                                  updateCalendarSettingsField("dayOfWeekAdjustments", next);
                                }}
                              />
                            </label>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {calendarSettingsSection === "safety_net" ? (
                  <div className="grid gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                        Safety Net
                      </p>
                      <p className="mt-1 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
                        Example: 100% means the rate for a future date will never drop below last year&apos;s monthly ADR. This is a floor, not a target.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { value: 90, label: "More Aggressive" },
                        { value: 95, label: "Recommended" },
                        { value: 100, label: "More Conservative" }
                      ].map((option) => (
                        <button
                          key={`settings-ly-floor-${option.value}`}
                          type="button"
                          className="rounded-md px-3 py-2 text-sm font-semibold"
                          style={
                            Number(calendarSettingsForm.lastYearBenchmarkFloorPct ?? 95) === option.value
                              ? { background: "var(--mustard-dark)", color: "#ffffff" }
                              : { background: "white", border: "1px solid var(--border)", color: "var(--navy-dark)" }
                          }
                          onClick={() => updateCalendarSettingsField("lastYearBenchmarkFloorPct", option.value)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <label className="max-w-[240px] text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                      Manual Floor %
                      <input
                        type="number"
                        min="0"
                        step="1"
                        className="mt-1.5 w-full rounded-md border bg-white px-3 py-2 text-sm outline-none"
                        style={{ borderColor: "var(--border)" }}
                        value={calendarSettingsForm.lastYearBenchmarkFloorPct ?? ""}
                        onChange={(event) =>
                          updateCalendarSettingsField(
                            "lastYearBenchmarkFloorPct",
                            event.target.value === "" ? null : Number(event.target.value)
                          )
                        }
                      />
                    </label>
                  </div>
                ) : null}

                {calendarSettingsSection === "local_events" ? (
                  <div className="grid gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                        Local Events
                      </p>
                      <p className="mt-1 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
                        Add one-off uplifts or discounts for specific events. Use the adjustment field to say how much the recommended price should change versus a normal equivalent night.
                      </p>
                    </div>
                    <div className="space-y-2">
                      {(Array.isArray(calendarSettingsForm.localEvents) ? calendarSettingsForm.localEvents : []).map((event, index) => (
                        <div
                          key={event.id ?? `event-${index}`}
                          className="grid gap-2 rounded-[8px] border p-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_140px_110px]"
                          style={{ borderColor: "var(--border)" }}
                        >
                          <input
                            className="rounded-md border px-3 py-2 text-sm outline-none"
                            style={{ borderColor: "var(--border)" }}
                            value={event.name ?? ""}
                            onChange={(evt) => updateCalendarSettingsListItem("localEvents", index, "name", evt.target.value)}
                            placeholder="Event name and why it matters"
                          />
                          <LocalEventDatePicker
                            event={event}
                            index={index}
                            fallbackDate={pricingCalendarSelectedMonthStart}
                            updateCalendarSettingsListItem={updateCalendarSettingsListItem}
                          />
                          <input
                            type="number"
                            step="1"
                            className="rounded-md border px-3 py-2 text-sm outline-none"
                            style={{ borderColor: "var(--border)" }}
                            value={event.adjustmentPct ?? 0}
                            onChange={(evt) => updateCalendarSettingsListItem("localEvents", index, "adjustmentPct", Number(evt.target.value))}
                            placeholder="% vs normal night"
                          />
                          <button
                            type="button"
                            className="rounded-md border px-3 py-2 text-sm font-semibold"
                            style={{ borderColor: "rgba(187,75,82,0.24)", color: "var(--delta-negative)" }}
                            onClick={() => removeCalendarSettingsListItem("localEvents", index)}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="w-fit rounded-md border px-3 py-2 text-sm font-semibold"
                      style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                      onClick={() => addCalendarSettingsListItem("localEvents")}
                    >
                      Add local event
                    </button>
                  </div>
                ) : null}

                {calendarSettingsSection === "last_minute" ? (
                  <div className="grid gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                        Last Minute
                      </p>
                      <p className="mt-1 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
                        Set optional lead-time adjustments. For example, you can apply an extra discount from 0 to 3 days before arrival or an uplift for rare high-demand close-in dates.
                      </p>
                    </div>
                    <div className="space-y-2">
                      {(Array.isArray(calendarSettingsForm.lastMinuteAdjustments) ? calendarSettingsForm.lastMinuteAdjustments : []).map((rule, index) => (
                        <div
                          key={rule.id ?? `lead-${index}`}
                          className="grid gap-2 rounded-[8px] border p-3 md:grid-cols-[150px_150px_minmax(0,1fr)_110px]"
                          style={{ borderColor: "var(--border)" }}
                        >
                          <input
                            type="number"
                            min="0"
                            step="1"
                            className="rounded-md border px-3 py-2 text-sm outline-none"
                            style={{ borderColor: "var(--border)" }}
                            value={rule.minDaysBefore ?? 0}
                            onChange={(evt) => updateCalendarSettingsListItem("lastMinuteAdjustments", index, "minDaysBefore", Number(evt.target.value))}
                            placeholder="From days out"
                          />
                          <input
                            type="number"
                            min="0"
                            step="1"
                            className="rounded-md border px-3 py-2 text-sm outline-none"
                            style={{ borderColor: "var(--border)" }}
                            value={rule.maxDaysBefore ?? 7}
                            onChange={(evt) => updateCalendarSettingsListItem("lastMinuteAdjustments", index, "maxDaysBefore", Number(evt.target.value))}
                            placeholder="To days out"
                          />
                          <input
                            type="number"
                            step="1"
                            className="rounded-md border px-3 py-2 text-sm outline-none"
                            style={{ borderColor: "var(--border)" }}
                            value={rule.adjustmentPct ?? 0}
                            onChange={(evt) => updateCalendarSettingsListItem("lastMinuteAdjustments", index, "adjustmentPct", Number(evt.target.value))}
                            placeholder="% vs usual recommended price"
                          />
                          <button
                            type="button"
                            className="rounded-md border px-3 py-2 text-sm font-semibold"
                            style={{ borderColor: "rgba(187,75,82,0.24)", color: "var(--delta-negative)" }}
                            onClick={() => removeCalendarSettingsListItem("lastMinuteAdjustments", index)}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="w-fit rounded-md border px-3 py-2 text-sm font-semibold"
                      style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                      onClick={() => addCalendarSettingsListItem("lastMinuteAdjustments")}
                    >
                      Add last-minute rule
                    </button>
                  </div>
                ) : null}

                {calendarSettingsSection === "stay_rules" ? (
                  <div className="grid gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                        Stay Rules
                      </p>
                      <p className="mt-1 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
                        Keep the live Hostaway minimum stay visible here, then set the publish minimum stay you want ready for launch.
                      </p>
                    </div>
                    <div className="grid gap-3 lg:grid-cols-[minmax(0,260px)_minmax(0,260px)]">
                      <div className="rounded-[8px] border p-3" style={{ borderColor: "var(--border)", background: "rgba(248,250,249,0.88)" }}>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                          Current Hostaway Minimum Stay
                        </p>
                        <div className="mt-2 text-lg font-semibold" style={{ color: "var(--navy-dark)" }}>
                          {currentMinimumStaySummary.valueLabel}
                        </div>
                        <p className="mt-2 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
                          {currentMinimumStaySummary.detail}
                        </p>
                      </div>
                      <label className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                        Future Publish Minimum Stay
                        <input
                          type="number"
                          min="1"
                          step="1"
                          className="mt-1.5 w-full rounded-md border bg-white px-3 py-2 text-sm outline-none"
                          style={{ borderColor: "var(--border)" }}
                          value={calendarSettingsForm.minimumNightStay ?? ""}
                          onChange={(event) =>
                            updateCalendarSettingsField("minimumNightStay", event.target.value === "" ? null : Number(event.target.value))
                          }
                        />
                        <div className="mt-2 text-[12px] leading-5 normal-case" style={{ color: "var(--muted-text)" }}>
                          This setting is ready for the publish flow. It does not replace the live Hostaway rule shown beside it.
                        </div>
                      </label>
                    </div>
                    <div className="space-y-2">
                      {(Array.isArray(calendarSettingsForm.gapNightAdjustments) ? calendarSettingsForm.gapNightAdjustments : []).map((rule, index) => (
                        <div
                          key={`gap-${index}-${rule.gapNights ?? index + 1}`}
                          className="grid gap-2 rounded-[8px] border p-3 md:grid-cols-[150px_minmax(0,1fr)_110px]"
                          style={{ borderColor: "var(--border)" }}
                        >
                          <input
                            type="number"
                            min="1"
                            step="1"
                            className="rounded-md border px-3 py-2 text-sm outline-none"
                            style={{ borderColor: "var(--border)" }}
                            value={rule.gapNights ?? index + 1}
                            onChange={(evt) => updateCalendarSettingsListItem("gapNightAdjustments", index, "gapNights", Number(evt.target.value))}
                            placeholder="Gap nights"
                          />
                          <input
                            type="number"
                            step="1"
                            className="rounded-md border px-3 py-2 text-sm outline-none"
                            style={{ borderColor: "var(--border)" }}
                            value={rule.adjustmentPct ?? 0}
                            onChange={(evt) => updateCalendarSettingsListItem("gapNightAdjustments", index, "adjustmentPct", Number(evt.target.value))}
                            placeholder="% premium or discount"
                          />
                          <button
                            type="button"
                            className="rounded-md border px-3 py-2 text-sm font-semibold"
                            style={{ borderColor: "rgba(187,75,82,0.24)", color: "var(--delta-negative)" }}
                            onClick={() => removeCalendarSettingsListItem("gapNightAdjustments", index)}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="w-fit rounded-md border px-3 py-2 text-sm font-semibold"
                      style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                      onClick={() => addCalendarSettingsListItem("gapNightAdjustments")}
                    >
                      Add gap-night rule
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
