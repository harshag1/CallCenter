import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // WASM mp3 decoder (hold-music transcode) and pdfjs (pdf-parse) use dynamic worker imports Turbopack can't bundle.
  serverExternalPackages: ["mpg123-decoder", "@eshaz/web-worker", "pdf-parse"],
};

export default nextConfig;
