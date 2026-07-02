// Author: Harsha Gundala
// favicon.ts — resolves a company favicon from its domain (HTML <link rel=icon> → /favicon.ico → Google cache).

const LINK_RE = /<link[^>]+rel=["'](?:shortcut )?(?:icon|apple-touch-icon)["'][^>]*>/gi;
const HREF_RE = /href=["']([^"']+)["']/i;

export async function resolveFavicon(domain: string): Promise<string> {
  const base = `https://${domain}`;
  try {
    const res = await fetch(base, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CallCenterBot/1.0)" },
      redirect: "follow",
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const html = (await res.text()).slice(0, 200_000);
      const links = html.match(LINK_RE) ?? [];
      for (const link of links) {
        const href = link.match(HREF_RE)?.[1];
        if (!href) continue;
        const url = new URL(href, res.url).toString();
        if (await headOk(url)) return url;
      }
    }
  } catch { /* fall through */ }

  const ico = `${base}/favicon.ico`;
  if (await headOk(ico)) return ico;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

async function headOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) });
    return res.ok && (res.headers.get("content-type") ?? "").startsWith("image");
  } catch {
    return false;
  }
}
