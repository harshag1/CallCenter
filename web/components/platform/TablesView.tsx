// Author: Harsha Gundala
// TablesView.tsx — spreadsheet-grade dataset editor: rail + grid, inline column ops, CSV drop-to-create.

"use client";

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type Dispatch, type DragEvent, type KeyboardEvent, type SetStateAction,
} from "react";
import { ChevronDown, FileUp, Plus, Table2, Trash2, X } from "lucide-react";
import { useLiveEvents } from "@/components/hooks/useLiveEvents";
import type { LiveEvent } from "@/lib/realtime-types";

type Column = { key: string; label: string; type?: string };
type Dataset = { id: string; slug: string; name: string; icon: string; columns: Column[]; row_count?: number };
type Row = { id: string; data: Record<string, unknown>; created_at: string };

const JSON_HEADERS = { "Content-Type": "application/json" };
const NUMERIC = /^-?[\d,]+(\.\d+)?%?$/;

async function getDatasets(): Promise<Dataset[] | null> {
  try {
    const r = await fetch("/api/datasets");
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? j : j.datasets ?? [];
  } catch { return null; }
}

async function getRows(datasetId: string): Promise<Row[] | null> {
  try {
    const r = await fetch(`/api/datasets/${datasetId}/rows?limit=500`);
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? j : j.rows ?? [];
  } catch { return null; }
}

async function patchColumns(datasetId: string, op: Record<string, unknown>): Promise<Dataset | null> {
  try {
    const r = await fetch(`/api/datasets/${datasetId}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(op) });
    if (!r.ok) return null;
    return (await r.json()).dataset ?? null;
  } catch { return null; }
}

export default function TablesView() {
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [drag, setDrag] = useState(false);
  const [importing, setImporting] = useState(false);

  const selRef = useRef<string | null>(null);
  const dragDepth = useRef(0);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { selRef.current = selId; }, [selId]);

  const open = useCallback((id: string) => {
    setSelId(id);
    setRows([]);
    void getRows(id).then((r) => { if (r && selRef.current === id) setRows(r); });
  }, []);

  useEffect(() => {
    let live = true;
    void getDatasets().then((d) => {
      if (!live || !d) return;
      setDatasets(d);
      if (d.length) open(d[0].id);
    });
    return () => {
      live = false;
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [open]);

  // Live sync: rows written mid-campaign appear without user action (dataset_update fanout, migrations/006).
  useLiveEvents((ev: LiveEvent) => {
    if (ev.kind !== "dataset_update" || refetchTimer.current) return;
    if (!selRef.current || (ev.datasetId && ev.datasetId !== selRef.current)) return;
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      const id = selRef.current;
      if (!id) return;
      void getRows(id).then((r) => { if (r && selRef.current === id) setRows(r); });
    }, 1000);
  });

  async function createTable(name: string): Promise<boolean> {
    try {
      const r = await fetch("/api/datasets", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name, columns: [] }) });
      if (!r.ok) return false;
      const created = (await r.json()).dataset as Dataset;
      const d = await getDatasets();
      if (d) setDatasets(d);
      open(created.id);
      return true;
    } catch { return false; }
  }

  /** Uploads dropped CSVs to /api/knowledge, then polls until the auto-imported table lands and opens it. */
  async function importCsvs(files: File[]) {
    const known = new Set((datasets ?? []).map((d) => d.id));
    const form = new FormData();
    for (const f of files) form.append("files", f);
    setImporting(true);
    try {
      const r = await fetch("/api/knowledge", { method: "POST", body: form });
      if (!r.ok) { setImporting(false); return; }
    } catch { setImporting(false); return; }
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      const d = await getDatasets();
      const fresh = d?.find((x) => !known.has(x.id));
      if (d && fresh) {
        setDatasets(d);
        open(fresh.id);
        setImporting(false);
        return;
      }
      if (attempts < 25) pollTimer.current = setTimeout(() => void poll(), 800);
      else setImporting(false);
    };
    pollTimer.current = setTimeout(() => void poll(), 800);
  }

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDragEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDrag(true);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDrag(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDrag(false);
    const csvs = Array.from(e.dataTransfer.files).filter((f) => f.name.toLowerCase().endsWith(".csv"));
    if (csvs.length) void importCsvs(csvs);
  };

  const sel = datasets?.find((d) => d.id === selId) ?? null;

  return (
    <div
      className="relative min-h-[calc(100vh-96px)]"
      onDragEnter={onDragEnter}
      onDragOver={(e) => { if (hasFiles(e)) e.preventDefault(); }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {drag && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-2xl bg-white/85 backdrop-blur-[2px]">
          <div className="flex items-center gap-2.5 rounded-2xl border border-dashed border-neutral-300 px-6 py-4 text-[13px] text-neutral-500">
            <FileUp size={15} className="text-neutral-400" />
            Drop CSV to create a table
          </div>
        </div>
      )}
      {importing && (
        <div className="absolute bottom-4 right-4 z-40 animate-pulse rounded-full border border-neutral-200 bg-white px-3 py-1 text-[11px] text-neutral-400 shadow-[0_8px_18px_rgba(0,0,0,0.04)]">
          importing…
        </div>
      )}

      {datasets === null ? null : !datasets.length ? (
        <EmptyState onCreate={createTable} />
      ) : (
        <div className="flex gap-5">
          <Rail
            datasets={datasets.map((d) => (d.id === selId ? { ...d, row_count: rows.length } : d))}
            selId={selId}
            onSelect={open}
            onCreate={createTable}
          />
          {sel && (
            <div className="min-w-0 flex-1">
              <Grid
                key={sel.id}
                ds={sel}
                rows={rows}
                setRows={setRows}
                onDatasetChange={(d) => setDatasets((prev) => (prev ?? []).map((x) => (x.id === d.id ? { ...x, ...d } : x)))}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: (name: string) => Promise<boolean> }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  return (
    <div className="flex min-h-[calc(100vh-160px)] flex-col items-center justify-center gap-4">
      <Table2 size={26} className="text-neutral-300" strokeWidth={1.75} />
      <div className="text-[13px] text-neutral-400">Create a table or drop a CSV</div>
      {naming ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) void onCreate(name.trim());
            if (e.key === "Escape") { setNaming(false); setName(""); }
          }}
          placeholder="table name"
          className="w-44 rounded-full border border-neutral-300 px-3.5 py-1.5 text-center text-[12.5px] outline-none transition-colors duration-[160ms] placeholder:text-neutral-300 focus:border-neutral-900"
        />
      ) : (
        <button
          onClick={() => setNaming(true)}
          className="rounded-full bg-neutral-900 px-4 py-1.5 text-[12px] font-medium text-white transition-opacity duration-[160ms] hover:opacity-85"
        >
          New table
        </button>
      )}
    </div>
  );
}

function Rail({
  datasets, selId, onSelect, onCreate,
}: {
  datasets: Dataset[];
  selId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<boolean>;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  return (
    <div className="w-44 shrink-0">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-neutral-400">tables</span>
        <button
          onClick={() => setNaming(true)}
          title="new table"
          className="text-neutral-300 transition-colors duration-[160ms] hover:text-neutral-900"
        >
          <Plus size={13} />
        </button>
      </div>
      <div className="space-y-0.5">
        {naming && (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => { setNaming(false); setName(""); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) {
                void onCreate(name.trim()).then((ok) => { if (ok) { setNaming(false); setName(""); } });
              }
              if (e.key === "Escape") { setNaming(false); setName(""); }
            }}
            placeholder="table name"
            className="w-full rounded-lg border border-neutral-300 px-2 py-1.5 text-[12.5px] outline-none placeholder:text-neutral-300 focus:border-neutral-900"
          />
        )}
        {datasets.map((d) => (
          <button
            key={d.id}
            onClick={() => onSelect(d.id)}
            className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors duration-[160ms] ${
              d.id === selId ? "bg-neutral-100 font-medium text-neutral-900" : "text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800"
            }`}
          >
            <span className="truncate">{d.name}</span>
            <span className="ml-2 shrink-0 text-[10px] tabular-nums text-neutral-300">{d.row_count ?? ""}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

type Active = { r: number; c: number };
type Editing = Active & { seed?: string };

function Grid({
  ds, rows, setRows, onDatasetChange,
}: {
  ds: Dataset;
  rows: Row[];
  setRows: Dispatch<SetStateAction<Row[]>>;
  onDatasetChange: (d: Dataset) => void;
}) {
  const cols = ds.columns;
  // Stored DESC; render oldest-first like a sheet. Stable sort keeps batch-imported rows (tied
  // timestamps) in their original insert order, which reverse() would flip.
  const view = useMemo(
    () => [...rows].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)),
    [rows]
  );
  const containerRef = useRef<HTMLDivElement>(null);

  const [active, setActive] = useState<Active | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [addingCol, setAddingCol] = useState(false);

  // Clamp instead of effect-reset: a dropped column simply dissolves the ring.
  const act = active && active.c < cols.length && active.r <= view.length ? active : null;

  useEffect(() => {
    if (!active) return;
    containerRef.current
      ?.querySelector(`[data-cell="${active.r}-${active.c}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const refocus = () => containerRef.current?.focus({ preventScroll: true });

  /** Clears editing only if it still points at (r,c) — a click on another cell may have already moved it. */
  const stopEdit = (r: number, c: number) =>
    setEditing((prev) => (prev && prev.r === r && prev.c === c ? null : prev));

  // Ghost-row creates are optimistic: rows appear instantly under a tmp id, reconciled once the POST lands.
  const pendingEdits = useRef<Record<string, Record<string, unknown>>>({});
  const deletedTmp = useRef<Set<string>>(new Set());
  const tmpSeq = useRef(0);

  async function commitCell(r: number, c: number, value: string, moveRight = false) {
    const key = cols[c]?.key;
    if (!key) return;
    if (r >= view.length) {
      if (!value.trim()) return;
      tmpSeq.current += 1;
      const tmpId = `tmp_${tmpSeq.current}`;
      const tmpRow: Row = { id: tmpId, data: { [key]: value }, created_at: new Date().toISOString() };
      setRows((prev) => [tmpRow, ...prev]);
      setActive({ r, c: moveRight ? Math.min(cols.length - 1, c + 1) : c });
      try {
        const res = await fetch(`/api/datasets/${ds.id}/rows`, {
          method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ data: { [key]: value } }),
        });
        if (!res.ok) { setRows((prev) => prev.filter((x) => x.id !== tmpId)); return; }
        const created = (await res.json()).row as Row;
        setRows((prev) => prev.map((x) => (x.id === tmpId ? { ...x, id: created.id } : x)));
        const pend = pendingEdits.current[tmpId];
        delete pendingEdits.current[tmpId];
        if (deletedTmp.current.delete(tmpId)) {
          void fetch(`/api/datasets/${ds.id}/rows?id=${created.id}`, {
            method: "DELETE", headers: JSON_HEADERS, body: JSON.stringify({ id: created.id }),
          });
        } else if (pend) {
          void fetch(`/api/datasets/${ds.id}/rows`, {
            method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ id: created.id, data: pend }),
          });
        }
      } catch { setRows((prev) => prev.filter((x) => x.id !== tmpId)); }
      return;
    }
    const row = view[r];
    if (String(row.data?.[key] ?? "") === value) return;
    setRows((prev) => prev.map((x) => (x.id === row.id ? { ...x, data: { ...x.data, [key]: value } } : x)));
    if (row.id.startsWith("tmp_")) {
      pendingEdits.current[row.id] = { ...(pendingEdits.current[row.id] ?? {}), [key]: value };
      return;
    }
    try {
      await fetch(`/api/datasets/${ds.id}/rows`, {
        method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ id: row.id, data: { [key]: value } }),
      });
    } catch { /* optimistic */ }
  }

  async function deleteRow(row: Row) {
    setRows((prev) => prev.filter((x) => x.id !== row.id));
    setActive(null);
    if (row.id.startsWith("tmp_")) {
      deletedTmp.current.add(row.id);
      return;
    }
    try {
      await fetch(`/api/datasets/${ds.id}/rows?id=${row.id}`, {
        method: "DELETE", headers: JSON_HEADERS, body: JSON.stringify({ id: row.id }),
      });
    } catch { /* optimistic */ }
  }

  async function columnOp(op: Record<string, unknown>) {
    const updated = await patchColumns(ds.id, op);
    if (updated) onDatasetChange(updated);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (editing || renaming || addingCol) return;
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (!act || !cols.length) return;
    const maxR = view.length; // ghost row included
    const maxC = cols.length - 1;
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      setActive({ r: Math.min(maxR, Math.max(0, act.r + dr)), c: Math.min(maxC, Math.max(0, act.c + dc)) });
    };
    if (e.key === "ArrowUp") move(-1, 0);
    else if (e.key === "ArrowDown") move(1, 0);
    else if (e.key === "ArrowLeft") move(0, -1);
    else if (e.key === "ArrowRight" || e.key === "Tab") move(0, 1);
    else if (e.key === "Enter") { e.preventDefault(); setEditing({ ...act }); }
    else if (e.key === "Escape") setActive(null);
    else if ((e.key === "Backspace" || e.key === "Delete") && act.r < view.length) {
      e.preventDefault();
      void commitCell(act.r, act.c, "");
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setEditing({ ...act, seed: e.key });
    }
  }

  return (
    <div className="min-w-0">
      <div className="mb-3 flex items-center gap-2">
        <Table2 size={14} className="text-neutral-400" />
        <span className="text-[13px] font-semibold">{ds.name}</span>
      </div>

      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="max-h-[calc(100vh-230px)] overflow-auto rounded-xl border border-[var(--border)] outline-none"
      >
        <table className="w-max min-w-full border-separate border-spacing-0 text-[12.5px]">
          <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_var(--border)]">
            <tr>
              <th className="w-8 min-w-8 border-r border-[var(--border)]" />
              {cols.map((col) => (
                <Header
                  key={col.key}
                  col={col}
                  renaming={renaming === col.key}
                  menuOpen={menu === col.key}
                  confirmDrop={confirmDrop}
                  onStartRename={() => { setRenaming(col.key); setMenu(null); }}
                  onRename={(label) => {
                    setRenaming(null);
                    if (label.trim() && label.trim() !== col.label) void columnOp({ rename_column: { key: col.key, label: label.trim() } });
                  }}
                  onCancelRename={() => setRenaming(null)}
                  onToggleMenu={() => { setMenu(menu === col.key ? null : col.key); setConfirmDrop(false); }}
                  onCloseMenu={() => { setMenu(null); setConfirmDrop(false); }}
                  onDelete={() => {
                    if (!confirmDrop) { setConfirmDrop(true); return; }
                    setMenu(null);
                    setConfirmDrop(false);
                    void columnOp({ drop_column: { key: col.key } });
                  }}
                />
              ))}
              <th className="min-w-[44px] border-b border-[var(--border)] px-2 py-1.5 text-left align-middle font-normal">
                {addingCol ? (
                  <input
                    autoFocus
                    onBlur={(e) => {
                      const v = e.currentTarget.value.trim();
                      setAddingCol(false);
                      if (v) void columnOp({ add_column: { label: v } });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") { e.currentTarget.value = ""; setAddingCol(false); }
                    }}
                    placeholder="column"
                    className="w-28 bg-transparent text-[11px] font-medium normal-case tracking-normal outline-none placeholder:text-neutral-300"
                  />
                ) : (
                  <button
                    onClick={() => setAddingCol(true)}
                    title="add column"
                    className="flex h-5 w-5 items-center justify-center rounded text-neutral-300 transition-colors duration-[160ms] hover:bg-neutral-100 hover:text-neutral-700"
                  >
                    <Plus size={13} />
                  </button>
                )}
              </th>
            </tr>
          </thead>
          <tbody>
            {view.map((row, r) => (
              <tr key={row.id} className="group">
                <td className="w-8 min-w-8 border-b border-r border-[var(--border)] text-center">
                  <button
                    onClick={() => void deleteRow(row)}
                    title="delete row"
                    className="align-middle text-neutral-200 opacity-0 transition-all duration-[160ms] hover:text-red-400 group-hover:opacity-100"
                  >
                    <X size={11} />
                  </button>
                </td>
                {cols.map((col, c) => (
                  <Cell
                    key={col.key}
                    r={r} c={c}
                    value={row.data?.[col.key]}
                    numeric={col.type === "number"}
                    active={act?.r === r && act?.c === c}
                    editing={editing?.r === r && editing?.c === c ? editing : null}
                    onActivate={() => { setActive({ r, c }); setEditing({ r, c }); }}
                    onCommit={(v, dir) => {
                      stopEdit(r, c);
                      void commitCell(r, c, v);
                      if (dir) setActive({ r, c: Math.min(cols.length - 1, c + 1) });
                      refocus();
                    }}
                    onCancel={() => { stopEdit(r, c); refocus(); }}
                  />
                ))}
                <td className="border-b border-[var(--border)]" />
              </tr>
            ))}
            {cols.length > 0 && (
              <tr>
                <td className="w-8 min-w-8 border-r border-[var(--border)] text-center">
                  <Plus size={11} className="mx-auto text-neutral-200" />
                </td>
                {cols.map((col, c) => (
                  <Cell
                    key={col.key}
                    r={view.length} c={c}
                    value=""
                    ghost
                    numeric={col.type === "number"}
                    active={act?.r === view.length && act?.c === c}
                    editing={editing?.r === view.length && editing?.c === c ? editing : null}
                    onActivate={() => { setActive({ r: view.length, c }); setEditing({ r: view.length, c }); }}
                    onCommit={(v, dir) => {
                      stopEdit(view.length, c);
                      void commitCell(view.length, c, v, dir);
                      refocus();
                    }}
                    onCancel={() => { stopEdit(view.length, c); refocus(); }}
                  />
                ))}
                <td />
              </tr>
            )}
            {!cols.length && (
              <tr>
                <td colSpan={2} className="px-4 py-10 text-center text-xs text-neutral-300">add a column</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="px-1 pt-2 text-[11px] tabular-nums text-neutral-400">
        {view.length} {view.length === 1 ? "row" : "rows"}
      </div>
    </div>
  );
}

function Header({
  col, renaming, menuOpen, confirmDrop,
  onStartRename, onRename, onCancelRename, onToggleMenu, onCloseMenu, onDelete,
}: {
  col: Column;
  renaming: boolean;
  menuOpen: boolean;
  confirmDrop: boolean;
  onStartRename: () => void;
  onRename: (label: string) => void;
  onCancelRename: () => void;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onDelete: () => void;
}) {
  return (
    <th className="group/h relative min-w-[120px] max-w-[320px] border-b border-r border-[var(--border)] px-3 py-1.5 text-left align-middle">
      {renaming ? (
        <input
          autoFocus
          defaultValue={col.label}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => onRename(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") { e.currentTarget.value = col.label; onCancelRename(); }
          }}
          className="w-full bg-transparent text-[11px] font-medium text-neutral-700 outline-none"
        />
      ) : (
        <button
          onClick={onStartRename}
          title="rename"
          className="block w-full truncate pr-4 text-left text-[11px] font-medium text-neutral-500 transition-colors duration-[160ms] hover:text-neutral-900"
        >
          {col.label}
        </button>
      )}
      {!renaming && (
        <button
          onClick={onToggleMenu}
          className={`absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-neutral-300 transition-all duration-[160ms] hover:bg-neutral-100 hover:text-neutral-600 ${
            menuOpen ? "opacity-100" : "opacity-0 group-hover/h:opacity-100"
          }`}
        >
          <ChevronDown size={12} />
        </button>
      )}
      {menuOpen && (
        <div
          onMouseLeave={onCloseMenu}
          className="absolute right-0 top-full z-20 mt-1 w-36 rounded-lg border border-neutral-200 bg-white p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]"
        >
          <button
            onClick={onDelete}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] font-normal normal-case tracking-normal transition-colors duration-[160ms] ${
              confirmDrop ? "bg-red-50 text-red-500" : "text-neutral-600 hover:bg-neutral-50"
            }`}
          >
            <Trash2 size={12} />
            {confirmDrop ? "Confirm delete" : "Delete column"}
          </button>
        </div>
      )}
    </th>
  );
}

function Cell({
  r, c, value, numeric, ghost, active, editing, onActivate, onCommit, onCancel,
}: {
  r: number;
  c: number;
  value: unknown;
  numeric?: boolean;
  ghost?: boolean;
  active: boolean;
  editing: Editing | null;
  onActivate: () => void;
  onCommit: (v: string, moveRight: boolean) => void;
  onCancel: () => void;
}) {
  const text = value == null ? "" : String(value);
  const tabular = numeric || NUMERIC.test(text);
  // One commit per edit session: Enter/Tab triggers a native blur (via refocus) that must not re-commit.
  const done = useRef(false);
  useEffect(() => { done.current = false; }, [editing]);
  const commit = (v: string, moveRight: boolean) => {
    if (done.current) return;
    done.current = true;
    onCommit(v, moveRight);
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };
  return (
    <td
      data-cell={`${r}-${c}`}
      onMouseDown={() => { if (!editing) onActivate(); }}
      className={`min-w-[120px] max-w-[320px] cursor-default border-b border-r border-[var(--border)] px-3 py-[6px] text-neutral-700 ${
        tabular ? "tabular-nums" : ""
      } ${active && !editing ? "[box-shadow:inset_0_0_0_1.5px_#171717]" : ""}`}
    >
      {editing ? (
        <input
          autoFocus
          defaultValue={editing.seed ?? text}
          onFocus={(e) => { if (!editing.seed) e.currentTarget.select(); }}
          onBlur={(e) => commit(e.currentTarget.value, false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(e.currentTarget.value, false); }
            else if (e.key === "Tab") { e.preventDefault(); commit(e.currentTarget.value, true); }
            else if (e.key === "Escape") { e.currentTarget.value = text; cancel(); }
            e.stopPropagation();
          }}
          className="w-full min-w-[96px] bg-transparent outline-none"
        />
      ) : (
        <span className="block min-h-[19px] truncate">
          {text === "" ? (ghost ? "" : <span className="text-neutral-200">—</span>) : text}
        </span>
      )}
    </td>
  );
}
