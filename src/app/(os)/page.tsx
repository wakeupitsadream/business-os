import type { Metadata } from "next";
import { Banknote, Brain, CheckCircle, TrendingUp } from "lucide-react";
import { checkDatabase, type DbFailureReason } from "@/core/db";
import { llmConfigured } from "@/core/llm";
import { tgConfigured } from "@/core/telegram/bot";
import { KpiCard } from "@/components/os/kpi-card";
import { Panel } from "@/components/os/panel";
import { cn } from "@/core/shared/cn";

export const metadata: Metadata = { title: "HQ — Business OS" };

// Статус системы читается в момент запроса: закэшированная страница показывала
// бы «БД доступна» уже после того, как она легла.
export const dynamic = "force-dynamic";

interface CheckRow {
  label: string;
  ok: boolean;
  detail: string;
}

/** Категория отказа базы — по-русски и с подсказкой, куда смотреть. */
const DB_FAILURE_TEXT: Record<DbFailureReason, string> = {
  timeout: "не ответила вовремя — вероятно, компьют Neon просыпается",
  unreachable: "недоступна — проверь строки подключения и лимит компьют-часов",
  auth: "отказала в доступе — проверь логин и пароль в DATABASE_URL",
  unknown: "недоступна — подробности в логах контейнера",
};

async function collectChecks(): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];

  // Каждая проверка в своём try: упавший вызов не должен утащить весь экран —
  // HQ нужен владельцу именно тогда, когда что-то сломалось.
  try {
    const db = await checkDatabase();
    rows.push({
      label: "База данных (Neon)",
      ok: db.ok,
      // Категория вместо сырого текста Prisma: она по-русски и говорит, что
      // делать. Полное сообщение уходит в лог — там оно и нужно, а на экране
      // владельца строка вида «Can't reach database server at ep-….neon.tech»
      // не добавляет ничего, кроме хоста базы на скриншоте.
      detail: db.ok ? "соединение есть" : DB_FAILURE_TEXT[db.reason ?? "unknown"],
    });
  } catch {
    rows.push({ label: "База данных (Neon)", ok: false, detail: "проверка не выполнена" });
  }

  try {
    const ok = llmConfigured();
    rows.push({
      label: "LLM-шлюзы",
      ok,
      detail: ok ? "ключи заданы" : "нет ключей POLZA_API_KEY / PROXYAPI_API_KEY",
    });
  } catch {
    rows.push({ label: "LLM-шлюзы", ok: false, detail: "проверка не выполнена" });
  }

  try {
    const ok = tgConfigured();
    rows.push({
      label: "Telegram-бот",
      ok,
      detail: ok ? "токен и прокси заданы" : "нет TELEGRAM_BOT_TOKEN",
    });
  } catch {
    rows.push({ label: "Telegram-бот", ok: false, detail: "проверка не выполнена" });
  }

  return rows;
}

function StatusRow({ label, ok, detail }: CheckRow) {
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span
        aria-hidden
        className={cn("mt-1.5 size-2 shrink-0 rounded-full", ok ? "bg-ok" : "bg-danger")}
      />
      <span className="min-w-0 flex-1 text-sm text-fg">{label}</span>
      <span
        className={cn("num max-w-[55%] truncate text-right text-xs", ok ? "text-ok" : "text-danger")}
        title={detail}
      >
        {detail}
      </span>
    </li>
  );
}

export default async function HqPage() {
  const checks = await collectChecks();
  const build = process.env.BUILD_SHA?.slice(0, 7) ?? "dev";
  const pending = checks.filter((c) => !c.ok).length;

  return (
    <div className="space-y-6">
      <section>
        <p className="label-xs text-muted">Командный центр</p>
        <h2 className="mt-2 text-xl font-medium text-fg">Обзор</h2>
        <p className="mt-1 text-sm text-muted">
          Сводка по всем отделам. Цифры появятся по мере подключения модулей.
        </p>
      </section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Выручка, месяц"
          value="—"
          icon={Banknote}
          hint="появится в фазе 2 (Финансы)"
        />
        <KpiCard
          label="Активные сделки"
          value="—"
          icon={TrendingUp}
          hint="появится в фазе 3 (Продажи)"
        />
        <KpiCard
          label="Задач на сегодня"
          value="—"
          icon={CheckCircle}
          hint="появится в фазе 1 (Секретарь)"
        />
        <KpiCard label="Расходы на ИИ, день" value="—" icon={Brain} hint="учёт LlmUsage, фаза 0" />
      </div>

      <Panel
        title="Статус системы"
        subtitle={
          pending === 0
            ? "Все подсистемы каркаса подключены."
            : `Не подключено подсистем: ${pending}. Переменные — в разделе «Настройки».`
        }
        flush
      >
        <ul className="divide-y divide-line px-4 py-1">
          {checks.map((row) => (
            <StatusRow key={row.label} {...row} />
          ))}
          <li className="flex items-center gap-3 py-2.5">
            <span aria-hidden className="mt-0 size-2 shrink-0 rounded-full bg-muted" />
            <span className="min-w-0 flex-1 text-sm text-fg">Версия сборки</span>
            <span className="num text-xs text-muted">{build}</span>
          </li>
        </ul>
      </Panel>
    </div>
  );
}
