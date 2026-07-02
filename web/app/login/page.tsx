// Author: Harsha Gundala
// login — staged contact capture: work email first, phone field expands below.

"use client";

import { type FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, Mail, Phone } from "lucide-react";

function looksLikeEmail(value: string) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
}

function normalizePhone(value: string) {
  const raw = value.trim();
  if (/^\+\d{7,15}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

export default function Login() {
  const router = useRouter();
  const phoneRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showPhone = email.trim().length > 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const cleanEmail = email.trim().toLowerCase();
    const cleanPhone = normalizePhone(phone);
    if (!looksLikeEmail(cleanEmail)) {
      setError("enter a valid work email");
      return;
    }
    if (!cleanPhone) {
      setError("enter a valid phone number");
      phoneRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: cleanEmail }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "could not send verification code");
      sessionStorage.setItem("onboarding:email", cleanEmail);
      sessionStorage.setItem("onboarding:phone", cleanPhone);
      router.push(`/verify?email=${encodeURIComponent(cleanEmail)}&phone=${encodeURIComponent(cleanPhone)}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col bg-[#f8f8f8] px-5 text-neutral-950">
      <header className="flex items-center justify-center gap-2.5 pt-10">
        <Phone size={17} strokeWidth={2.35} />
        <h1 className="text-[15px] font-semibold tracking-tight">Harsha&apos;s Amazing Call Center</h1>
      </header>

      <div className="flex flex-1 items-center justify-center">
      <div className="w-full max-w-[408px]">
        <form onSubmit={submit} className="overflow-hidden rounded-[16px] border border-neutral-200 bg-white shadow-[0_10px_30px_rgba(15,15,15,0.035)]">
          <div className="flex h-16 items-center gap-3 px-4">
            <Mail size={17} strokeWidth={1.9} className="shrink-0 text-neutral-400" />
            <input
              id="email"
              autoFocus
              type="email"
              aria-label="Work email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
              }}
              placeholder="Work email"
              autoComplete="email"
              className="min-w-0 flex-1 bg-transparent text-[17px] font-medium outline-none placeholder:text-neutral-300"
            />
          </div>

          <div className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${showPhone ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
            <div className="min-h-0 overflow-hidden">
              {showPhone && (
                <>
                  <div className="flex h-16 items-center gap-3 border-t border-neutral-100 px-4">
                    <Phone size={17} strokeWidth={1.9} className="shrink-0 text-neutral-400" />
                    <input
                      id="phone"
                      inputMode="tel"
                      ref={phoneRef}
                      aria-label="Phone number"
                      value={phone}
                      onChange={(e) => {
                        setPhone(e.target.value);
                        setError(null);
                      }}
                      placeholder="Phone number"
                      autoComplete="tel"
                      className="min-w-0 flex-1 bg-transparent text-[17px] font-medium outline-none placeholder:text-neutral-300"
                    />
                  </div>

                  <div className="border-t border-neutral-100 p-2">
                    <button
                      type="submit"
                      disabled={busy}
                      className="flex h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-neutral-950 text-[14px] font-medium text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400"
                    >
                      {busy ? <Loader2 size={15} className="animate-spin" /> : <>Continue <ArrowRight size={15} strokeWidth={2} /></>}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </form>

        {error && <p className="mt-3 text-center text-xs text-red-500">{error}</p>}
      </div>
      </div>
    </main>
  );
}
