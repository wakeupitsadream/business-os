import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Один Docker-контейнер на Timeweb: standalone-сервер + встроенный планировщик.
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Тяжёлые серверные пакеты не тащим в бандл роутов.
    serverActions: { bodySizeLimit: "12mb" },
  },
  // @node-rs/argon2 — нативный модуль, его нельзя бандлить.
  serverExternalPackages: ["@node-rs/argon2", "@prisma/client"],
};

export default nextConfig;
