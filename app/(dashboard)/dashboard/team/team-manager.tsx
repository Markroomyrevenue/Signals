"use client";

import { useMemo, useState } from "react";

type TeamClient = {
  id: string;
  name: string;
  hostawayAccountId: string | null;
  membershipRole: "admin" | "viewer";
  canManage: boolean;
};

type TeamUserClient = {
  id: string;
  name: string;
  role: "admin" | "viewer";
};

type TeamUser = {
  email: string;
  role: "admin" | "viewer" | "mixed";
  displayName: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  clients: TeamUserClient[];
};

type TeamResponse = {
  clients: TeamClient[];
  users: TeamUser[];
  currentUserEmail: string;
  currentTenantId: string;
};

type Props = {
  currentUserEmail: string;
  currentTenantId: string;
  initialClients: TeamClient[];
  initialUsers: TeamUser[];
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    });
  } catch {
    return value;
  }
}

export default function TeamManager({
  currentUserEmail,
  currentTenantId,
  initialClients,
  initialUsers
}: Props) {
  const [users, setUsers] = useState<TeamUser[]>(initialUsers);
  const [clients, setClients] = useState<TeamClient[]>(initialClients);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"admin" | "viewer">("viewer");
  const [selectedClientIds, setSelectedClientIds] = useState<string[]>(() =>
    initialClients.some((client) => client.id === currentTenantId) ? [currentTenantId] : initialClients[0] ? [initialClients[0].id] : []
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const adminCount = useMemo(
    () => users.filter((user) => user.role === "admin" || user.role === "mixed").length,
    [users]
  );

  function toggleClient(clientId: string) {
    setSelectedClientIds((current) =>
      current.includes(clientId) ? current.filter((value) => value !== clientId) : [...current, clientId]
    );
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    if (selectedClientIds.length === 0) {
      setError("Choose at least one portfolio for this teammate.");
      return;
    }

    setPending(true);
    try {
      const res = await fetch("/api/team/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          role,
          displayName: displayName || undefined,
          clientIds: selectedClientIds
        })
      });
      const data = (await res.json().catch(() => ({}))) as Partial<TeamResponse> & { error?: string };
      if (!res.ok) throw new Error(data.error || "Failed to add user.");
      const nextClients = data.clients ?? [];
      setUsers(data.users ?? []);
      setClients(nextClients);
      setNotice(`Saved ${email.trim().toLowerCase()} and updated their portfolio access.`);
      setEmail("");
      setPassword("");
      setDisplayName("");
      setRole("viewer");
      setSelectedClientIds(
        nextClients.some((client) => client.id === currentTenantId)
          ? [currentTenantId]
          : nextClients[0]
            ? [nextClients[0].id]
            : []
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add user.");
    } finally {
      setPending(false);
    }
  }

  async function handleRoleChange(emailValue: string, nextRole: "admin" | "viewer") {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/team/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailValue, role: nextRole })
      });
      const data = (await res.json().catch(() => ({}))) as Partial<TeamResponse> & { error?: string };
      if (!res.ok) throw new Error(data.error || "Could not change role.");
      setUsers(data.users ?? []);
      setClients(data.clients ?? []);
      setNotice(`Updated ${emailValue} to ${nextRole}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change role.");
    }
  }

  async function handleDelete(emailValue: string, clientCount: number) {
    if (
      !confirm(
        `Remove ${emailValue} from ${clientCount} portfolio${clientCount === 1 ? "" : "s"} you manage? They will lose access immediately.`
      )
    ) {
      return;
    }

    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/team/users?email=${encodeURIComponent(emailValue)}`, {
        method: "DELETE"
      });
      const data = (await res.json().catch(() => ({}))) as Partial<TeamResponse> & { error?: string };
      if (!res.ok) throw new Error(data.error || "Could not remove user.");
      setUsers(data.users ?? []);
      setClients(data.clients ?? []);
      setNotice(`Removed ${emailValue} from the portfolios you manage.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove user.");
    }
  }

  const sortedClients = useMemo(
    () => [...clients].sort((left, right) => left.name.localeCompare(right.name, "en-GB", { sensitivity: "base" })),
    [clients]
  );

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm">
        <h2 className="font-display text-lg">Add teammate</h2>
        <form className="mt-4 space-y-3" onSubmit={handleCreate}>
          <label className="block text-sm">
            <span className="text-xs font-semibold text-neutral-500">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-1 w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm"
              placeholder="teammate@example.com"
            />
          </label>
          <label className="block text-sm">
            <span className="text-xs font-semibold text-neutral-500">Name (optional)</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="mt-1 w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-xs font-semibold text-neutral-500">Temporary password (8+ chars)</span>
            <input
              type="text"
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-xs font-semibold text-neutral-500">Role</span>
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as "admin" | "viewer")}
              className="mt-1 w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm"
            >
              <option value="viewer">Viewer</option>
              <option value="admin">Admin</option>
            </select>
          </label>

          <div className="rounded-2xl border border-neutral-200 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Portfolios ({selectedClientIds.length}/{sortedClients.length})
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-full border border-neutral-300 px-2.5 py-1 text-[11px] font-semibold text-neutral-700"
                  onClick={() => setSelectedClientIds(sortedClients.map((client) => client.id))}
                >
                  All
                </button>
                <button
                  type="button"
                  className="rounded-full border border-neutral-300 px-2.5 py-1 text-[11px] font-semibold text-neutral-700"
                  onClick={() => setSelectedClientIds([])}
                >
                  None
                </button>
              </div>
            </div>
            <div className="mt-2 space-y-1">
              {sortedClients.map((client) => {
                const checked = selectedClientIds.includes(client.id);
                return (
                  <label
                    key={client.id}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-neutral-50"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-neutral-300"
                      checked={checked}
                      onChange={() => toggleClient(client.id)}
                    />
                    <span className="truncate">{client.name}</span>
                  </label>
                );
              })}
            </div>
          </div>

          {error ? (
            <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          ) : null}
          {notice ? (
            <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>
          ) : null}

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-full bg-neutral-900 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60 sm:w-auto"
          >
            {pending ? "Saving..." : "Add teammate"}
          </button>
        </form>
      </section>

      <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-display text-lg">People</h2>
          <span className="text-xs uppercase tracking-wide text-neutral-500">
            {users.length} · {adminCount} admin
          </span>
        </div>

        {users.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">No teammates yet.</p>
        ) : (
          <div className="mt-4 space-y-2">
            {users.map((user) => {
              const isSelf = user.email === currentUserEmail;
              return (
                <div
                  key={user.email}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-neutral-200 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">
                        {user.email}
                        {isSelf ? <span className="ml-1 text-xs font-normal text-neutral-500">(you)</span> : null}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-neutral-500">
                      {user.clients.map((c) => c.name).join(", ") || "No portfolio access"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={user.role}
                      disabled={isSelf}
                      onChange={(event) => handleRoleChange(user.email, event.target.value as "admin" | "viewer")}
                      className="rounded-lg border border-neutral-300 px-2 py-1 text-xs"
                    >
                      {user.role === "mixed" ? <option value="mixed">Mixed</option> : null}
                      <option value="viewer">Viewer</option>
                      <option value="admin">Admin</option>
                    </select>
                    <button
                      type="button"
                      disabled={isSelf}
                      onClick={() => handleDelete(user.email, user.clients.length)}
                      className="rounded-full border border-red-200 px-3 py-1 text-xs font-semibold text-red-700 disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
