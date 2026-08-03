import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Send } from "lucide-react";
import { Panel } from "@/components/os/panel";
import { EmptyState } from "@/components/os/empty-state";
import { OutreachQueue } from "@/components/sales/outreach-queue";
import { loadOutreachQueue } from "@/modules/sales/outreach/queue";

/**
 * Очередь аутрича.
 *
 * Самое важное на этом экране — то, чего на нём нет: кнопки «разослать».
 * Система не отправляет ничего. Черновик копируется или открывается ссылкой в
 * мессенджере, владелец пишет сам и отмечает, что написал, — и вот эта отметка
 * уже двигает воронку и ставит напоминание вернуться через три дня.
 */

export const metadata: Metadata = { title: "Аутрич — Business OS" };
export const dynamic = "force-dynamic";

export default async function OutreachPage() {
  const queue = await loadOutreachQueue();

  return (
    <div className="space-y-6">
      <section>
        <Link
          href="/sales"
          className="label-xs inline-flex items-center gap-1.5 text-muted transition-colors hover:text-fg"
        >
          <ArrowLeft aria-hidden className="size-3" />
          Продажи
        </Link>
        <h2 className="mt-2 text-xl font-medium text-fg">Аутрич</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Черновики первого сообщения. Отправка только руками: «Отправил» записывает касание,
          двигает сделку в «связались» и ставит напоминание вернуться через три дня.
        </p>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
        <Panel
          title="Очередь"
          subtitle={
            queue.drafts.length > 0
              ? "Текст можно править прямо здесь — правка сохранится и станет образцом тона."
              : undefined
          }
        >
          {queue.drafts.length === 0 ? (
            <EmptyState
              icon={Send}
              title="Черновиков нет"
              description="Они составляются несколько раз в день по лидам, которых ещё не касались. Сначала нужен хотя бы один такой лид — заведите его руками или через лидоген."
              note="Фаза 3 — Аутрич"
            />
          ) : (
            <OutreachQueue drafts={queue.drafts} />
          )}
        </Panel>

        <Panel title="Сегодня">
          <ul className="space-y-1.5 text-xs">
            <li className="flex justify-between gap-2">
              <span className="text-muted">составлено</span>
              <span className="num text-fg">
                {queue.madeToday} / {queue.dailyCap}
              </span>
            </li>
            <li className="flex justify-between gap-2">
              <span className="text-muted">отправлено</span>
              <span className="num text-fg">{queue.sentToday}</span>
            </li>
          </ul>
          <p className="mt-2 text-[11px] text-muted">
            Потолок стоит на составлении, а не на отправке: сотня черновиков в очереди — это не
            выбор, а повод отправлять не глядя.
          </p>
        </Panel>
      </div>
    </div>
  );
}
