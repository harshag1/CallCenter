// Author: Harsha Gundala
// brand.ts — short display name from a legal company name ("Costco Wholesale Corporation" → "Costco").

const LEGAL_SUFFIXES = new Set([
  "corporation", "corp", "inc", "incorporated", "llc", "ltd", "limited", "company", "co",
  "plc", "gmbh", "sa", "ag", "holdings", "group", "technologies", "labs",
]);

export function shortBrand(name: string | null | undefined): string | null {
  if (!name) return null;
  const words = name.replace(/[.,]/g, "").split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => !LEGAL_SUFFIXES.has(w.toLowerCase()));
  const base = (meaningful[0] ?? words[0]) ?? "";
  if (!base) return null;
  return base.charAt(0).toUpperCase() + base.slice(1);
}
