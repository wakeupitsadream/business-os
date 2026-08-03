"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarPlus, CircleHelp } from "lucide-react";
import { cn } from "@/core/shared/cn";

/**
 * Календарь контента.
 *
 * Сетку строит СЕРВЕР и присылает готовой: в клиентской сборке `OWNER_TZ` из
 * окружения не читается и молча становится значением по умолчанию, поэтому
 * посчитанный здесь месяц поехал бы на границе суток — и заметили бы это на
 * посте, назначенном на 00:30.
 *
 * Перенос отправляет день строкой "ГГГГ-ММ-ДД", а не инстант: собранный
 * браузером, он считался бы в поясе браузера.
 */

export interface CalendarPost {
  id: string;
  title: string;
  rubric: string;
  status: string;
  /** Время публикации, уже отформатированное сервером. */
  timeLabel: string | null;
  degraded: boolean;
}

export interface CalendarDay {
  /** Ключ дня "ГГГГ-ММ-ДД" — он же то, что уходит на сервер при переносе. */
  key: string;
  dayNumber: number;
  isToday: boolean;
  inCurrentMonth: boolean;
  posts: CalendarPost[];
}

const STATUS_LABEL: Record<string, string> = {
  IDEA: "идея",
  DRAFT: "черновик",
  APPROVED: "одобрен",
  SCHEDULED: "в расписании",
  PUBLISHING: "публикуется",
  PUBLISHED: "опубликован",
  UNCERTAIN: "не знаю, ушёл ли",
  FAILED: "не ушёл",
  REJECTED: "отклонён",
};

const RUBRIC_LABEL: Record<string, string> = {
  CASE: "кейс",
  NICHE_PAIN: "боль ниши",
  FEATURE: "фича",
  BEHIND_SCENES: "внутрянка",
  DIGEST: "дайджест",
};

/** Статусы, которые ещё можно двигать. Сервер проверяет это заново. */
const MOVABLE = new Set(["IDEA", "DRAFT", "APPROVED", "SCHEDULED"]);

export function ContentCalendar({ days, weekdays }: { days: CalendarDay[]; weekdays: string[] }) {
  const router = useRouter();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Клавиатурный сдвиг перерисовывает карточку, и фокус уезжает в body —
  // второе нажатие подряд не сработало бы.
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef<string | null>(null);

  useEffect(() => {
    if (!refocus.current) return;
    cardRefs.current.get(refocus.current)?.focus();
    refocus.current = null;
  });

  async function move(postId: string, day: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sales/content/${postId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reschedule", day }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        // Крон мог опубликовать пост между рендером и перетаскиванием: карточка
        // в браузере об этом не знает, поэтому отказ приходит с сервера.
        setError(data.error ?? "Не удалось перенести пост");
        return;
      }
      refocus.current = postId;
      router.refresh();
    } catch {
      setError("Сеть недоступна — пост остался на месте");
    } finally {
      setBusy(false);
    }
  }

  async function buildPlan() {
    setPlanning(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/sales/content", { method: "POST" });
      const data = (await res.json()) as {
        error?: string;
        created?: number;
        degraded?: boolean;
        existed?: boolean;
      };
      if (!res.ok) {
        setError(data.error ?? "Не удалось собрать план");
        return;
      }
      if (data.existed) setNotice("План на эту неделю уже собран.");
      else if (data.degraded) {
        // Владелец обязан видеть, что модели не было: иначе решит, что ИИ
        // выдаёт мусор, и перестанет нажимать кнопку.
        setNotice(`Добавлено идей: ${data.created}. Модель была недоступна — темы заготовочные, их стоит переписать.`);
      } else setNotice(`Добавлено идей: ${data.created}.`);
      router.refresh();
    } catch {
      setError("Сеть недоступна — план не собран");
    } finally {
      setPlanning(false);
    }
  }

  /** Сдвиг с клавиатуры: перетаскивание — мышиный жест, на телефоне его нет. */
  function shiftByDays(postId: string, fromKey: string, delta: number) {
    const index = days.findIndex((d) => d.key === fromKey);
    const target = days[index + delta];
    if (!target) return;
    void move(postId, target.key);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void buildPlan()}
          disabled={planning}
          className={cn(
            "flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-3 py-1.5 text-xs text-fg transition-colors hover:border-accent",
            planning && "opacity-50",
          )}
        >
          <CalendarPlus aria-hidden className="size-3.5" />
          {planning ? "Собираю…" : "Собрать план недели"}
        </button>
        {notice && <p className="text-xs text-muted">{notice}</p>}
      </div>

      {error && (
        <p className="flex items-center gap-2 text-xs text-danger">
          <AlertTriangle aria-hidden className="size-3.5" />
          {error}
        </p>
      )}

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-line bg-line">
        {weekdays.map((w) => (
          <div key={w} className="bg-surface-2 px-2 py-1 text-center label-xs text-muted">
            {w}
          </div>
        ))}

        {days.map((day) => (
          <div
            key={day.key}
            onDragOver={(e) => {
              if (!dragging) return;
              e.preventDefault();
              setOver(day.key);
            }}
            onDragLeave={() => setOver((k) => (k === day.key ? null : k))}
            onDrop={() => {
              const postId = dragging;
              setDragging(null);
              setOver(null);
              if (postId) void move(postId, day.key);
            }}
            className={cn(
              "min-h-24 bg-surface p-1.5 transition-colors",
              !day.inCurrentMonth && "opacity-45",
              over === day.key && "bg-surface-2 ring-1 ring-inset ring-accent",
            )}
          >
            <p
              className={cn(
                "mb-1 text-right label-xs",
                day.isToday ? "font-semibold text-accent" : "text-muted",
              )}
            >
              {day.dayNumber}
            </p>

            <div className="space-y-1">
              {day.posts.map((post) => {
                const movable = MOVABLE.has(post.status);
                return (
                  <button
                    key={post.id}
                    ref={(el) => {
                      if (el) cardRefs.current.set(post.id, el);
                      else cardRefs.current.delete(post.id);
                    }}
                    type="button"
                    draggable={movable && !busy}
                    onDragStart={() => setDragging(post.id)}
                    onDragEnd={() => setDragging(null)}
                    onKeyDown={(e) => {
                      if (!movable || busy) return;
                      // Shift+стрелки — клавиатурный эквивалент переноса.
                      if (e.shiftKey && e.key === "ArrowRight") {
                        e.preventDefault();
                        shiftByDays(post.id, day.key, 1);
                      }
                      if (e.shiftKey && e.key === "ArrowLeft") {
                        e.preventDefault();
                        shiftByDays(post.id, day.key, -1);
                      }
                    }}
                    title={`${RUBRIC_LABEL[post.rubric] ?? post.rubric} · ${STATUS_LABEL[post.status] ?? post.status}`}
                    className={cn(
                      "w-full rounded border border-line bg-surface-2 px-1.5 py-1 text-left text-[11px] leading-tight text-fg transition-colors",
                      movable ? "cursor-grab hover:border-accent" : "cursor-default opacity-70",
                      dragging === post.id && "opacity-40",
                      post.status === "UNCERTAIN" && "border-warning",
                      post.status === "PUBLISHED" && "border-success",
                    )}
                  >
                    <span className="flex items-center gap-1">
                      {post.status === "UNCERTAIN" && (
                        <CircleHelp aria-hidden className="size-3 shrink-0 text-warning" />
                      )}
                      <span className="truncate">{post.title}</span>
                    </span>
                    <span className="label-xs mt-0.5 block text-muted">
                      {post.timeLabel ?? "без времени"}
                      {post.degraded && " · заготовка"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <p className="label-xs text-muted">
        Перетащите карточку на другой день или сдвиньте с клавиатуры: Shift + ← →
      </p>
    </div>
  );
}
