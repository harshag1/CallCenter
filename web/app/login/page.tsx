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
  const emailRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const cleanEmail = emailRef.current?.value.trim().toLowerCase() ?? "";
    const cleanPhone = normalizePhone(phoneRef.current?.value ?? "");
    if (!looksLikeEmail(cleanEmail)) {
      setError("enter a valid work email");
      emailRef.current?.focus();
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
    <main className="flex min-h-screen items-center justify-center bg-[#f7f7f7] px-5 text-neutral-950">
      <div className="w-full max-w-[430px]">
        <div className="mb-6 flex items-center justify-center gap-2.5 text-neutral-900">
          <Phone size={17} strokeWidth={2.35} />
          <span className="text-sm font-semibold tracking-tight">Harsha&apos;s Amazing Call Center</span>
        </div>

        <form onSubmit={submit} className="rounded-[28px] border border-neutral-200 bg-white p-3 shadow-[0_18px_70px_rgba(15,15,15,0.06)]">
          <div className="rounded-[22px] border border-neutral-100 bg-white px-4 py-3">
            <label htmlFor="email" className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-neutral-400">
              <Mail size={13} /> Work email
            </label>
            <input
              id="email"
              autoFocus
              type="email"
              ref={emailRef}
              placeholder="you@company.com"
              autoComplete="email"
              className="w-full bg-transparent text-[22px] font-medium tracking-tight outline-none placeholder:text-neutral-200"
            />
          </div>

          <div className="mt-2 grid grid-rows-[1fr] opacity-100 transition-[grid-template-rows,opacity,margin] duration-500 ease-out">
            <div className="min-h-0 overflow-hidden">
              <div className="rounded-[22px] border border-neutral-100 bg-white px-4 py-3">
                <label htmlFor="phone" className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-neutral-400">
                  <Phone size={13} /> Phone number
                </label>
                <input
                  id="phone"
                  inputMode="tel"
                  ref={phoneRef}
                  placeholder="+1 415 555 0123"
                  autoComplete="tel"
                  className="w-full bg-transparent text-[22px] font-medium tracking-tight outline-none placeholder:text-neutral-200"
                />
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={busy}
            className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-[18px] bg-neutral-950 text-sm font-medium text-white transition-all hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <>Continue <ArrowRight size={15} /></>}
          </button>
        </form>

        <p className="mx-auto mt-4 max-w-[340px] text-center text-xs leading-5 text-neutral-400">
          We use this to verify the builder and prepare company-specific agent suggestions while you confirm access.
        </p>
        {error && <p className="mt-3 text-center text-xs text-red-500">{error}</p>}
      </div>
    </main>
  );
}
