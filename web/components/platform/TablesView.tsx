// Author: Harsha Gundala
// TablesView.tsx — datasets: minimal Notion-like list cards + grid with inline cell editing.

"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { ChevronLeft, MessageSquare, Phone, Plus, Star, Table2, Trash2, Users } from "lucide-react";
import { fmtTime } from "./shared";

type Dataset = {
  id: string; slug: string; name: string; icon: string;
  columns: { key: string; label: string; type?: string }[];
  row_count?: number;
};
type Row = { id: string; data: Record<string, unknown>; created_at: string };

const ICONS: Record<string, typeof Table2> = {
  table: Table2, users: Users, user: Users, star: Star, "message-square": MessageSquare, phone: Phone,
};
const JSON_HEADERS = { "Content-Type": "application/json" };

async function fetchDatasets(): Promise<Dataset[] | null> {
  try {
    const r = await fetch("/api/datasets");
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? j : j.datasets ?? [];
  } catch {
    return null; // keep empty state
  }
}

async function fetchRows(datasetId: string): Promise<Row[] | null> {
  try {
    const r = await fetch(`/api/datasets/${datasetId}/rows`);
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? j : j.rows ?? [];
  } catch {
    return null;
  }
}

export default function TablesView() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [sel, setSel] = useState<Dataset | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchDatasets().then((d) => { if (live && d) setDatasets(d); });
    return () => { live = false; };
  }, []);

  if (sel) {
    return (
      <Grid
        ds={sel}
        rows={rows}
        setRows={setRows}
        reload={() => void fetchRows(sel.id).then((r) => r && setRows(r))}
        onBack={() => {
          setSel(null);
          setRows([]);
          void fetchDatasets().then((d) => d && setDatasets(d));
        }}
      />
    );
  }

  return (
    <div>
      <div className="mb-4 text-[11px] uppercase tracking-wide text-neutral-400">tables</div>
      <div className="grid grid-cols-3 gap-3 xl:grid-cols-4">
        {datasets.map((d) => {
          const Icon = ICONS[d.icon] ?? Table2;
          return (
            <button
              key={d.id}
              onClick={() => { setSel(d); setRows([]); void fetchRows(d.id).then((r) => r && setRows(r)); }}
              className="rounded-2xl border border-[var(--border)] p-4 text-left transition-colors hover:border-neutral-300"
            >
              <Icon size={15} className="text-neutral-500" />
              <div className="mt-2.5 text-[13px] font-semibold">{d.name}</div>
              <div className="mt-0.5 text-[11px] tabular-nums text-neutral-400">{d.row_count ?? 0} rows</div>
            </button>
          );
        })}
        {creating ? (
          <NewTable onDone={(ok) => { setCreating(false); if (ok) void fetchDatasets().then((d) => d && setDatasets(d)); }} />
        ) : (
          <button
            onClick={() => setCreating(true)}
            title="new table"
            className="flex min-h-[104px] items-center justify-center rounded-2xl border border-dashed border-neutral-200 text-neutral-300 transition-colors hover:border-neutral-400 hover:text-neutral-500"
          >
            <Plus size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

function NewTable({ onDone }: { onDone: (created: boolean) => void }) {
  const [name, setName] = useState("");
  const [cols, setCols] = useState<{ label: string; type: string }[]>([{ label: "", type: "text" }]);

  async function create() {
    const columns = cols
      .filter((c) => c.label.trim())
      .map((c) => ({ key: c.label.trim().toLowerCase().replace(/\W+/g, "_"), label: c.label.trim(), type: c.type }));
    if (!name.trim() || !columns.length) return;
    try {
      const r = await fetch("/api/datasets", {
        method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name: name.trim(), columns }),
      });
      onDone(r.ok);
    } catch { onDone(false); }
  }

  return (
    <div className="col-span-2 space-y-2 rounded-2xl border border-neutral-300 p-4">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="table name"
        className="w-full bg-transparent text-[13px] font-semibold outline-none placeholder:text-neutral-300"
      />
      {cols.map((c, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            value={c.label}
            onChange={(e) => setCols((p) => p.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
            placeholder="column"
            className="min-w-0 flex-1 rounded-lg border border-neutral-200 px-2 py-1 text-xs outline-none focus:border-neutral-400"
          />
          <select
            value={c.type}
            onChange={(e) => setCols((p) => p.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}
            className="rounded-lg border border-neutral-200 px-1.5 py-1 text-xs outline-none"
          >
            {["text", "number", "phone", "date"].map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
      ))}
      <div className="flex items-center justify-between pt-1">
        <button
          onClick={() => setCols((p) => [...p, { label: "", type: "text" }])}
          title="add column"
          className="text-neutral-300 transition-colors hover:text-neutral-600"
        >
          <Plus size={13} />
        </button>
        <button onClick={create} className="rounded-full bg-neutral-900 px-3 py-1 text-[11px] text-white">create</button>
      </div>
    </div>
  );
}

function Grid({
  ds, rows, setRows, reload, onBack,
}: {
  ds: Dataset;
  rows: Row[];
  setRows: Dispatch<SetStateAction<Row[]>>;
  reload: () => Promise<void> | void;
  onBack: () => void;
}) {
  async function patch(row: Row, key: string, value: string) {
    const data = { ...row.data, [key]: value };
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, data } : r)));
    try {
      await fetch(`/api/datasets/${ds.id}/rows`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ id: row.id, data }) });
    } catch { /* optimistic */ }
  }

  async function addRow() {
    try {
      const r = await fetch(`/api/datasets/${ds.id}/rows`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ data: {} }) });
      if (r.ok) void reload();
    } catch { /* noop */ }
  }

  async function del(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
    try {
      await fetch(`/api/datasets/${ds.id}/rows?id=${id}`, { method: "DELETE", headers: JSON_HEADERS, body: JSON.stringify({ id }) });
    } catch { /* optimistic */ }
  }

  const Icon = ICONS[ds.icon] ?? Table2;
  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <button onClick={onBack} title="back" className="text-neutral-300 transition-colors hover:text-neutral-900"><ChevronLeft size={15} /></button>
        <Icon size={14} className="text-neutral-500" />
        <span className="text-[13px] font-semibold">{ds.name}</span>
        <button
          onClick={addRow}
          title="add row"
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg border border-neutral-200 text-neutral-500 transition-colors hover:border-neutral-900 hover:text-neutral-900"
        >
          <Plus size={13} />
        </button>
      </div>
      <div className="max-h-[calc(100vh-180px)] overflow-auto rounded-2xl border border-[var(--border)]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-white">
            <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-neutral-400">
              {ds.columns.map((c) => <th key={c.key} className="px-4 py-2.5 font-medium">{c.label}</th>)}
              <th className="px-4 py-2.5 font-medium">created</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="group border-b border-[var(--border)] last:border-0 hover:bg-neutral-50/60">
                {ds.columns.map((c) => (
                  <Cell key={c.key} value={row.data?.[c.key]} onSave={(v) => patch(row, c.key, v)} />
                ))}
                <td className="px-4 py-2 text-[11px] tabular-nums text-neutral-400">{fmtTime(row.created_at)}</td>
                <td className="pr-3">
                  <button
                    onClick={() => del(row.id)}
                    title="delete row"
                    className="text-neutral-200 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={ds.columns.length + 2} className="px-4 py-10 text-center text-xs text-neutral-400">empty</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cell({ value, onSave }: { value: unknown; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState("");
  return (
    <td
      className="cursor-text px-4 py-2 text-neutral-700"
      onClick={() => { if (!editing) { setV(value == null ? "" : String(value)); setEditing(true); } }}
    >
      {editing ? (
        <input
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={() => { setEditing(false); if (v !== String(value ?? "")) onSave(v); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEditing(false);
          }}
          className="w-full bg-transparent outline-none"
        />
      ) : (
        <span className="block min-h-5">
          {value == null || value === "" ? <span className="text-neutral-200">—</span> : String(value)}
        </span>
      )}
    </td>
  );
}
