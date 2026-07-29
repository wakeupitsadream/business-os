import type { Metadata } from "next";
import { optionalEnv } from "@/core/env";
import { OWNER_TZ } from "@/core/shared/time";
import { LogoutButton } from "@/components/os/sidebar";
import { Panel } from "@/components/os/panel";
import { cn } from "@/core/shared/cn";

export const metadata: Metadata = { title: "Настройки — Business OS" };

// Окружение читается из процесса — страница обязана быть динамической, иначе
// после смены переменной в панели Timeweb она показывала бы прошлое состояние.
export const dynamic = "force-dynamic";

interface EnvSpec {
  name: string;
  hint: string;
  required: boolean;
}

interface EnvGroup {
  title: string;
  note: string;
  vars: EnvSpec[];
}

const ENV_GROUPS: EnvGroup[] = [
  {
    title: "Ядро",
    note: "Без этих переменных не работают вход, БД и кроны.",
    vars: [
      { name: "DATABASE_URL", hint: "пул Neon (-pooler, pgbouncer=true)", required: true },
      { name: "DIRECT_URL", hint: "прямое подключение — для миграций", required: true },
      { name: "APP_URL", hint: "публичный адрес приложения", required: true },
      { name: "AUTH_SECRET", hint: "подпись cookie: openssl rand -base64 48", required: true },
      {
        name: "OWNER_PASSWORD_HASH",
        hint: "argon2id: npm run hash:password -- 'пароль'",
        required: true,
      },
      { name: "CRON_SECRET", hint: "авторизация крон-роутов", required: true },
    ],
  },
  {
    title: "LLM-шлюзы",
    note: "Каскад: первый доступный обслуживает запрос, при провале — следующий.",
    vars: [
      { name: "LLM_GATEWAYS", hint: "порядок каскада, по умолчанию polza,proxyapi", required: false },
      { name: "POLZA_API_KEY", hint: "основной шлюз", required: true },
      { name: "PROXYAPI_API_KEY", hint: "резервный шлюз", required: false },
      { name: "LLM_DAILY_BUDGET_RUB", hint: "дневной потолок расходов, ₽", required: false },
    ],
  },
  {
    title: "Telegram",
    note: "Прямой api.telegram.org с хостинга заблокирован — весь трафик идёт через Cloudflare Worker.",
    vars: [
      { name: "TELEGRAM_BOT_TOKEN", hint: "личный бот владельца", required: true },
      { name: "TELEGRAM_API_BASE", hint: "исходящие вызовы через Worker", required: true },
      { name: "TELEGRAM_WEBHOOK_BASE", hint: "вебхук ставится на Worker", required: true },
      { name: "TELEGRAM_WEBHOOK_SECRET", hint: "заголовок X-Telegram-Bot-Api-Secret-Token", required: true },
      { name: "TELEGRAM_OWNER_CHAT_ID", hint: "единственный обслуживаемый chat_id", required: true },
    ],
  },
  {
    title: "Речь",
    note: "Нужно для голосовых сообщений в Telegram (фаза 1).",
    vars: [
      { name: "STT_PROVIDER", hint: "по умолчанию proxyapi", required: false },
      { name: "STT_MODEL", hint: "по умолчанию gpt-4o-mini-transcribe", required: false },
    ],
  },
  {
    title: "Интеграции (фазы 2–3)",
    note: "Пока не заданы — соответствующие модули просто не активны.",
    vars: [
      { name: "YOOKASSA_SHOP_ID", hint: "идентификатор магазина", required: false },
      { name: "YOOKASSA_SECRET_KEY", hint: "ОТДЕЛЬНЫЙ ключ только на чтение", required: false },
      { name: "YANDEX_GEO_API_KEY", hint: "Geosearch для лидогена", required: false },
      { name: "DGIS_API_KEY", hint: "2ГИС Catalog API", required: false },
      { name: "INBOUND_LEAD_SECRET", hint: "приём заявок с agentus.space", required: false },
    ],
  },
];

/** Показываем только факт наличия. Значение переменной — секрет и в интерфейс не попадает. */
function EnvRow({ spec }: { spec: EnvSpec }) {
  const isSet = Boolean(optionalEnv(spec.name));
  const tone = isSet ? "text-ok" : spec.required ? "text-danger" : "text-muted";

  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
      <span className="num text-xs text-fg">{spec.name}</span>
      {spec.required && !isSet ? (
        <span className="label-xs text-danger">обязательна</span>
      ) : null}
      <span className="w-full text-xs text-muted sm:w-auto sm:flex-1 sm:truncate">{spec.hint}</span>
      <span className={cn("num ml-auto text-xs", tone)}>{isSet ? "задана" : "не задана"}</span>
    </li>
  );
}

export default function SettingsPage() {
  const missingRequired = ENV_GROUPS.flatMap((g) => g.vars).filter(
    (v) => v.required && !optionalEnv(v.name),
  ).length;

  return (
    <div className="space-y-6">
      <section>
        <p className="label-xs text-muted">Система</p>
        <h2 className="mt-2 text-xl font-medium text-fg">Настройки</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Конфигурация задаётся переменными окружения в панели Timeweb, а не в интерфейсе. Здесь
          видно только, какие переменные заданы — значения не показываются никогда.
        </p>
      </section>

      <Panel
        title="Окружение"
        subtitle={
          missingRequired === 0
            ? "Все обязательные переменные заданы."
            : `Не заданы обязательные переменные: ${missingRequired}. Подсистемы без них молча не работают.`
        }
      >
        <div className="space-y-6">
          {ENV_GROUPS.map((group) => (
            <div key={group.title}>
              <h3 className="label-xs text-muted">{group.title}</h3>
              <p className="mt-1.5 text-xs text-muted">{group.note}</p>
              <ul className="mt-2 divide-y divide-line border-t border-line">
                {group.vars.map((spec) => (
                  <EnvRow key={spec.name} spec={spec} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Владелец">
        <dl className="space-y-2 text-sm">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted">Часовой пояс</dt>
            <dd className="num text-fg">{OWNER_TZ}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted">Версия сборки</dt>
            <dd className="num text-fg">{process.env.BUILD_SHA?.slice(0, 7) ?? "dev"}</dd>
          </div>
        </dl>

        <div className="mt-5 border-t border-line pt-4">
          <LogoutButton />
        </div>
      </Panel>
    </div>
  );
}
