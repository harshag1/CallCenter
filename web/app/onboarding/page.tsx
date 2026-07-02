// Author: Harsha Gundala
// onboarding — one textbox; personalized bot suggestions stream in from the background company scrape.

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";

type Suggestion = { label: string; purpose: string; prompt: string };

export default function Onboarding() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [company, setCompany] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/onboarding/scrape")
      .then((r) => r.json())
      .then((j) => {
        if (j.scrape) {
          setSuggestions(j.scrape.suggestions ?? []);
          setCompany(j.scrape.company ?? null);
        }
      })
      .catch(() => {});
  }, []);

  async function build() {
    setBuilding(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: text }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      router.push("/workspace");
    } catch (e) {
      setError((e as Error).message);
      setBuilding(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f8f8f8] px-5 text-neutral-950">
      <div className="w-full max-w-[560px] overflow-hidden rounded-[16px] border border-neutral-200 bg-white shadow-[0_10px_30px_rgba(15,15,15,0.035)]">
        <div className="p-4 text-center">
          <h1 className="text-[18px] font-semibold">Describe your agent</h1>
        </div>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder={company ? `What should your ${company} agent handle?` : "A voice agent that..."}
          className="min-h-[148px] w-full resize-none border-y border-neutral-100 bg-transparent p-4 text-[15px] leading-6 outline-none placeholder:text-neutral-300"
        />
        <div className="flex min-h-0 flex-wrap justify-center gap-2 px-3 py-2">
          {suggestions.map((s) => (
            <button
              key={s.label}
              onClick={() => setText(s.prompt)}
              className="flex items-center gap-1.5 rounded-[10px] border border-neutral-200 px-3 py-1.5 text-[12px] text-neutral-600 transition-colors hover:border-neutral-900 hover:text-neutral-900"
            >
              <Sparkles size={11} /> {s.label}
            </button>
          ))}
        </div>
        <div className="border-t border-neutral-100 p-2">
          <button
            onClick={build}
            disabled={building || text.trim().length < 10}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-neutral-950 px-5 text-[14px] font-medium text-white transition-colors hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-400"
          >
            {building ? <><Loader2 size={14} className="animate-spin" /> Building…</> : "Build my agent"}
          </button>
        </div>
        {error && <p className="mt-3 text-center text-xs text-red-500">{error}</p>}
      </div>
    </main>
  );
}
