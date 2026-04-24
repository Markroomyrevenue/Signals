"use client";

import { useMemo, useState } from "react";

type TeamUser = {
  id: string;
  email: string;
  role: string;
  displayName: string | null;
  lastLoginAt: string | null;
  createdAt: string;
};

type Props = {
  currentUserId: string;
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

export default function TeamManager({ currentUserId, initialUsers }: Props) {
  const [users, setUsers] = useState<TeamUser[]>(initialUsers);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"admin" | "viewer">("viewer");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const adminCount = useMemo(() => users.filter((u) => u.role === "admin").length, [users]);

  async function refresh() {
    const res = await fetch("/api/team/users", { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { users: TeamUser[] };
      setUsers(data.users);
    }
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const res = await fetch("/api/team/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          role,
          displayName: displayName || undefined
        })
      });
      const data = (await res.json()) as { user?: TeamUser; error?: string };
      if (!res.ok) throw new Error(data.error || "Failed to add user.");
      setNotice(`Added ${data.user?.email}. Share the password with them securely.`);
      setEmail("");
      setPassword("");
      setDisplayName("");
      setRole("viewer");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add user.");
    } finally {
      setPending(false);
    }
  }

  async function handleRoleChange(userId: string, nextRole: "admin" | "viewer") {
    setError(null);
    const res = await fetch("/api/team/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, role: nextRole })
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error || "Could not change role.");
      return;
    }
    await refresh();
  }

  async function handleDelete(userId: string, emailLabel: string) {
    if (!confirm(`Remove ${emailLabel}? This revokes their access immediately.`)) return;
    setError(null);
    const res = await fetch(`/api/team/users?id=${encodeURIComponent(userId)}`, {
      method: "DELETE"
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error || "Could not remove user.");
      return;
    }
    await refresh();
  }

  return (
    <div className="space-y-10">
      <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm">
        <h2 className="font-display text-xl">Invite a teammate</h2>
        <p className="mt-1 text-sm text-neutral-600">
          Pick a temporary password and share it with them securely — they can change it later.
        </p>
        <form className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={handleCreate}>
          <label className="text-sm">
            <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-xl border border-neutral-300 px-3 py-2"
              placeholder="teammate@yourcompany.com"
            />
          </label>
          <label className="text-sm">
            <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Display name (optional)</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="mt-1 w-full rounded-xl border border-neutral-300 px-3 py-2"
              placeholder="Sam"
            />
          </label>
          <label className="text-sm">
            <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Temporary password</span>
            <input
              type="text"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-xl border border-neutral-300 px-3 py-2"
              placeholder="at least 8 characters"
            />
          </label>
          <label className="text-sm">
            <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "admin" | "viewer")}
              className="mt-1 w-full rounded-xl border border-neutral-300 px-3 py-2"
            >
              <option value="viewer">Viewer — reporting only (no Calendar)</option>
              <option value="admin">Admin — full access, including Calendar & team settings</option>
            </select>
          </label>
          <div className="md:col-span-2 flex items-center gap-4">
            <button
              type="submit"
              disabled={pending}
              className="rounded-full bg-neutral-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {pending ? "Adding..." : "Add teammate"}
            </button>
            {error ? <span className="text-sm text-red-600">{error}</span> : null}
            {notice ? <span className="text-sm text-emerald-600">{notice}</span> : null}
          </div>
        </form>
      </section>

      <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-xl">People with access</h2>
          <span className="text-xs uppercase tracking-wide text-neutral-500">{users.length} total · {adminCount} admin</span>
        </div>
        <div className="mt-4 overflow-hidden rounded-2xl border border-neutral-200">
          <table className="min-w-full divide-y divide-neutral-200 text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Last login</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {users.map((user) => {
                const isSelf = user.id === currentUserId;
                return (
                  <tr key={user.id}>
                    <td className="px-4 py-3 font-medium">{user.email}{isSelf ? " (you)" : ""}</td>
                    <td className="px-4 py-3">{user.displayName || "—"}</td>
                    <td className="px-4 py-3">
                      <select
                        value={user.role}
                        disabled={isSelf}
                        onChange={(e) => handleRoleChange(user.id, e.target.value as "admin" | "viewer")}
                        className="rounded-lg border border-neutral-300 px-2 py-1 text-xs"
                      >
                        <option value="viewer">Viewer</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                    <td className="px-4 py-3 text-neutral-500">{formatDate(user.lastLoginAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        disabled={isSelf}
                        onClick={() => handleDelete(user.id, user.email)}
                        className="text-xs font-semibold text-red-600 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
