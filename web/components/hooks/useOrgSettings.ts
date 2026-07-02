"use client";
// Author: Harsha Gundala
// useOrgSettings.ts — org internet access (toggle + allowlist) and knowledge doc count for the org pills.

import { useCallback, useEffect, useState } from "react";

export function useOrgSettings() {
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [domains, setDomains] = useState<string[]>([]);
  const [faviconUrl, setFaviconUrl] = useState<string | null>(null);
  const [docCount, setDocCount] = useState(0);

  useEffect(() => {
    fetch("/api/onboarding/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) return;
        setEnabled(!!j.internet_enabled);
        setDomains(j.allowed_domains ?? []);
        setFaviconUrl(j.favicon_url ?? null);
        setLoaded(true);
      })
      .catch(() => {});
    fetch("/api/knowledge")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { documents?: { status: string }[] } | null) => {
        if (j?.documents) setDocCount(j.documents.filter((d) => d.status === "ready").length);
      })
      .catch(() => {});
  }, []);

  const post = useCallback(async (body: Record<string, unknown>) => {
    const r = await fetch("/api/settings/internet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!r?.ok) return false;
    const j = await r.json();
    setEnabled(!!j.internet_enabled);
    setDomains(j.allowed_domains ?? []);
    return true;
  }, []);

  const toggle = useCallback((v: boolean) => { setEnabled(v); void post({ enabled: v }); }, [post]);
  const addDomain = useCallback((d: string) => post({ add_domain: d }), [post]);
  const removeDomain = useCallback((d: string) => {
    setDomains((prev) => prev.filter((x) => x !== d));
    void post({ remove_domain: d });
  }, [post]);

  return { loaded, enabled, domains, faviconUrl, docCount, setDocCount, toggle, addDomain, removeDomain };
}
