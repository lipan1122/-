import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 默认 .next；CI/本机构建被占用时可用 NEXT_DIST_DIR 指定临时目录
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["node:sqlite"],
  experimental: {
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
  async headers() {
    return [
      {
        // 需要登录的页面统一禁止缓存：
        // 否则「未登录 → 307 到 /login」会被浏览器缓存，
        // 登录后再点链接仍会命中旧的重定向，表现为「点什么都掉登录」。
        source: "/:path((?!login|api|_next).*)",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, max-age=0" },
          { key: "Pragma", value: "no-cache" },
        ],
      },
    ];
  },
};

export default nextConfig;
