import type { Metadata } from "next";
import { optionalEnv } from "@/core/env";
import LoginForm from "./login-form";

export const metadata: Metadata = {
  title: "Вход — BUSINESS OS",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** Открытый редирект: принимаем только внутренние пути, «//host» отбрасываем. */
function safeNext(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const configured = Boolean(optionalEnv("OWNER_PASSWORD_HASH")) && Boolean(optionalEnv("AUTH_SECRET"));

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-8">
        <h1 className="font-mono text-sm uppercase tracking-[0.22em] text-accent">Business OS</h1>
        <p className="mt-2 text-sm text-muted">Пульт владельца. Вход только для хозяина системы.</p>

        {configured ? (
          <LoginForm next={next} />
        ) : (
          <div className="mt-6 rounded-lg border border-line bg-surface-2 p-4 text-sm text-muted">
            <p className="text-warn">Вход не настроен.</p>
            <p className="mt-2">Задайте в окружении переменные и перезапустите приложение:</p>
            <ul className="mt-3 space-y-2 font-mono text-xs">
              <li>
                <span className="text-fg">AUTH_SECRET</span>
                <br />
                openssl rand -base64 48
              </li>
              <li>
                <span className="text-fg">OWNER_PASSWORD_HASH</span>
                <br />
                npm run hash:password -- &apos;пароль&apos;
              </li>
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}
