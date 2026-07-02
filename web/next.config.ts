import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // WASM mp3 decoder (hold-music transcode) uses dynamic worker imports Turbopack can't bundle.
  serverExternalPackages: ["mpg123-decoder", "@eshaz/web-worker"],
};

export default nextConfig;
