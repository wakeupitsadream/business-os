import type { Metadata } from "next";
import { Headset } from "lucide-react";
import { EmptyState } from "@/components/os/empty-state";
import { Panel } from "@/components/os/panel";

export const metadata: Metadata = { title: "Секретарь — Business OS" };

export default function SecretaryPage() {
  return (
    <div className="space-y-6">
      <section>
        <p className="label-xs text-muted">Отдел</p>
        <h2 className="mt-2 text-xl font-medium text-fg">Секретарь</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Ася — личный помощник: чат с общей историей веба и Telegram, задачи и напоминания, утренний
          бриф, вечерний чек-ин, память о договорённостях.
        </p>
      </section>

      <Panel title="Что здесь будет">
        <ul className="space-y-2 text-sm text-muted">
          <li>— диалог с агентом (продолжается с телефона в Telegram);</li>
          <li>— задачи и напоминания голосом и текстом;</li>
          <li>— утренний бриф и вечерний чек-ин по сферам жизни;</li>
          <li>— долговременная память: факты, предпочтения, цели.</li>
        </ul>
      </Panel>

      <EmptyState
        icon={Headset}
        title="Модуль появится в фазе 1"
        description="Сейчас работает только каркас: оболочка, авторизация, LLM-шлюз и Telegram-бот."
        note="Фаза 1 — Секретарь"
      />
    </div>
  );
}
