import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // WASM mp3 decoder (hold-music transcode) and pdfjs (pdf-parse) use dynamic worker imports Turbopack can't bundle.
  serverExternalPackages: ["mpg123-decoder", "@eshaz/web-worker", "pdf-parse"],
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        // Approval and credential surfaces must never be frameable, including
        // by a hostile same-site subdomain. frame-ancestors is authoritative
        // in modern browsers; X-Frame-Options protects older clients.
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    }];
  },
};

export default nextConfig;
