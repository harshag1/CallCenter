// Author: Harsha Gundala
// FilesModal.tsx — upload PDFs/Docs/TXTs; ingestion status streams in as background embedding completes.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X, Upload, FileText, Loader2, Check, AlertCircle } from "lucide-react";

type Doc = { id: string; filename: string; size_bytes: number; status: string; error?: string };

export default function FilesModal({ open, onClose, onCountChange }: {
  open: boolean; onClose: () => void; onCountChange: (n: number) => void;
}) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/knowledge");
    if (res.ok) {
      const j = await res.json();
      setDocs(j.documents);
      onCountChange(j.documents.filter((d: Doc) => d.status === "ready").length);
    }
  }, [onCountChange]);

  useEffect(() => {
    if (!open) return;
    refresh();
    const iv = setInterval(refresh, 2500);
    return () => clearInterval(iv);
  }, [open, refresh]);

  async function upload(files: FileList | File[]) {
    setUploading(true);
    const form = new FormData();
    for (const f of Array.from(files)) form.append("files", f);
    await fetch("/api/knowledge", { method: "POST", body: form }).catch(() => {});
    setUploading(false);
    refresh();
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/20 backdrop-blur-[2px]" onClick={onClose}>
      <div className="w-[440px] rounded-[24px] border border-neutral-200 bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <div className="text-[14px] font-semibold">Knowledge</div>
          <button onClick={onClose} className="text-neutral-300 hover:text-neutral-900"><X size={16} /></button>
        </div>

        <button
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files); }}
          onClick={() => fileRef.current?.click()}
          className={`flex h-24 w-full flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed transition-colors ${
            dragging ? "border-neutral-900 bg-neutral-50" : "border-neutral-200 hover:border-neutral-400"
          }`}
        >
          {uploading ? <Loader2 size={16} className="animate-spin text-neutral-400" /> : <Upload size={16} className="text-neutral-400" />}
          <span className="text-[11px] text-neutral-400">PDF · DOCX · TXT · MD</span>
          <input
            ref={fileRef} type="file" multiple hidden accept=".pdf,.docx,.txt,.md,.csv,.json"
            onChange={(e) => e.target.files?.length && upload(e.target.files)}
          />
        </button>

        {docs.length > 0 && (
          <div className="mt-3 max-h-56 space-y-1 overflow-y-auto">
            {docs.map((d) => (
              <div key={d.id} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-neutral-50">
                <FileText size={13} className="shrink-0 text-neutral-400" />
                <span className="min-w-0 flex-1 truncate text-[12px]">{d.filename}</span>
                <span className="text-[10px] tabular-nums text-neutral-300">{(d.size_bytes / 1024).toFixed(0)}kb</span>
                {d.status === "ready" ? (
                  <Check size={12} className="text-emerald-500" />
                ) : d.status === "failed" ? (
                  <span title={d.error}><AlertCircle size={12} className="text-red-400" /></span>
                ) : (
                  <Loader2 size={12} className="animate-spin text-neutral-300" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
