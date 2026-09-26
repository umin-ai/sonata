import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // The stylesheet goes inside the HTML's <head> instead of a separate file.
    // The server's HTTP/2 does not honour request priorities, so a separate
    // stylesheet arrived only after most of the page's scripts and images, and
    // nothing can paint before it. Costs about 37 KB gzipped on every full page
    // load, since the stylesheet is no longer cached on its own.
    inlineCss: true,
  },
};

export default nextConfig;
