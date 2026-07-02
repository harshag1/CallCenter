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
    <main className="flex min-h-screen items-center justify-center bg-[#f7f7f7] px-5">
      <div className="w-full max-w-[600px] rounded-[30px] border border-neutral-200 bg-white p-4 shadow-[0_18px_70px_rgba(15,15,15,0.055)]">
        <div className="px-2 pb-4 pt-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Describe your agent</h1>
          <p className="mt-1 text-xs text-neutral-400">One clear request is enough. We&apos;ll turn it into a working voice flow.</p>
        </div>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder={company ? `What should your ${company} agent handle?` : "A voice agent that..."}
          className="w-full resize-none rounded-[22px] border border-neutral-100 p-4 text-[15px] leading-relaxed outline-none placeholder:text-neutral-300 focus:border-neutral-400"
        />
        <div className="mt-3 flex min-h-8 flex-wrap justify-center gap-2">
          {suggestions.map((s) => (
            <button
              key={s.label}
              onClick={() => setText(s.prompt)}
              className="flex items-center gap-1.5 rounded-full border border-neutral-200 px-3 py-1 text-xs text-neutral-600 transition-colors hover:border-neutral-900 hover:text-neutral-900"
            >
              <Sparkles size={11} /> {s.label}
            </button>
          ))}
        </div>
        <div className="mt-6 flex justify-center">
          <button
            onClick={build}
            disabled={building || text.trim().length < 10}
            className="flex h-11 items-center gap-2 rounded-[17px] bg-neutral-950 px-5 text-sm font-medium text-white transition-opacity disabled:opacity-30"
          >
            {building ? <><Loader2 size={14} className="animate-spin" /> Building…</> : "Build my first agent"}
          </button>
        </div>
        {error && <p className="mt-3 text-center text-xs text-red-500">{error}</p>}
      </div>
    </main>
  );
}
