"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Loader2, Sparkles, X } from "lucide-react";
import { cn } from "@/core/shared/cn";
import { formatKop } from "@/core/shared/money";
import {
  LOST_REASON_LABEL,
  NICHE_LABEL,
  SOURCE_LABEL,
  TOUCH_KIND_LABEL,
  TOUCH_KINDS,
  type ManualTouchKind,
} from "./labels";

/**
 * Выдвижная карточка лида.
 *
 * Всё, ради чего она открывается, — ответить на «звонить или списывать».
 * Поэтому порядок сверху вниз: кто это → что предлагает ИИ → что обещано →
 * что записать сейчас → что было раньше. История внизу: её читают, когда
 * первых четырёх экранов не хватило.
 *
 * Время показываем средствами браузера, а не серверным `formatLocal`: в
 * клиентской сборке `OWNER_TZ` не читается из окружения и молча становится
 * значением по умолчанию. Браузер владельца — и есть его часовой пояс.
 */

interface LeadCardContact {
  id: string;
  name: string | null;
  role: string | null;
  phone: string | null;
  email: string | null;
  telegram: string | null;
  isPersonalData: boolean;
}

interface LeadCardDeal {
  id: string;
  title: string;
  stageName: string;
  isWon: boolean;
  isLost: boolean;
  amountMonthlyKop: number;
  daysInStage: number;
  lostReason: string | null;
}

interface LeadCardTouch {
  id: string;
  kind: string;
  body: string | null;
  occurredAt: string;
  stageMove: { from: string; to: string } | null;
}

interface LeadCardFollowUp {
  id: string;
  dueAt: string;
  note: string | null;
  overdue: boolean;
}

export interface LeadCardData {
  id: string;
  name: string;
  niche: string;
  city: string | null;
  source: string;
  phone: string | null;
  site: string | null;
  address: string | null;
  note: string | null;
  aiScore: number | null;
  aiScoreReasons: string[];
  aiNextStep: { action: string; why: string | null; dueInDays: number | null } | null;
  contacts: LeadCardContact[];
  deals: LeadCardDeal[];
  followUps: LeadCardFollowUp[];
  touches: LeadCardTouch[];
}

/** Пресеты срока: на телефоне это быстрее любого календаря. */
const FOLLOW_UP_PRESETS = [
  { days: 1, label: "завтра" },
  { days: 3, label: "через 3 дня" },
  { days: 7, label: "через неделю" },
] as const;

/** Час, на который встают пресеты: рабочее утро, а не «через ровно 24 часа». */
const FOLLOW_UP_HOUR = 10;

function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
}

/** Значение для `datetime-local` — оно всегда в местном времени браузера. */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function presetValue(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(FOLLOW_UP_HOUR, 0, 0, 0);
  return toLocalInput(d);
}

export function LeadDrawer({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const router = useRouter();
  const [card, setCard] = useState<LeadCardData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [kind, setKind] = useState<ManualTouchKind>("CALL");
  const [body, setBody] = useState("");
  const [followUpAt, setFollowUpAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`/api/sales/leads/${leadId}`, { cache: "no-store" });
      const data = (await res.json()) as LeadCardData & { error?: string };
      if (!res.ok) {
        setLoadError(data.error ?? "Не удалось загрузить карточку");
        return;
      }
      setCard(data);
    } catch {
      setLoadError("Сеть недоступна");
    }
  }, [leadId]);

  useEffect(() => {
    setCard(null);
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submitTouch(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;

    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/sales/leads/${leadId}/touches`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          body: body.trim() || undefined,
          // Поле `datetime-local` отдаёт время без пояса. `new Date` читает
          // его как местное — то есть ровно так, как владелец его и набрал.
          followUpAt: followUpAt ? new Date(followUpAt).toISOString() : undefined,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setActionError(data.error ?? "Касание не записано");
        return;
      }
      setBody("");
      setFollowUpAt("");
      await load();
      // Доска снаружи считает касания за сегодня и ближайшие сроки — без
      // обновления она разойдётся с только что открытой карточкой.
      router.refresh();
    } catch {
      setActionError("Сеть недоступна — касание не записано");
    } finally {
      setBusy(false);
    }
  }

  async function closeFollowUp(id: string, status: "DONE" | "SKIPPED") {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/sales/follow-ups/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setActionError(data.error ?? "Не удалось закрыть касание");
        return;
      }
      await load();
      router.refresh();
    } catch {
      setActionError("Сеть недоступна");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Закрыть карточку"
        onClick={onClose}
        className="absolute inset-0 bg-bg/70"
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={card ? `Лид «${card.name}»` : "Карточка лида"}
        className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-line bg-surface"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-line bg-surface px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-medium text-fg">{card?.name ?? "Загрузка…"}</h2>
            {card && (
              <p className="mt-0.5 truncate text-xs text-muted">
                {[NICHE_LABEL[card.niche] ?? card.niche, card.city, SOURCE_LABEL[card.source]]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="shrink-0 rounded-md p-1 text-muted hover:text-fg"
          >
            <X aria-hidden className="size-4" />
          </button>
        </header>

        {loadError && (
          <p className="flex items-center gap-2 px-4 py-3 text-xs text-danger">
            <AlertTriangle aria-hidden className="size-3.5" />
            {loadError}
          </p>
        )}

        {!card && !loadError && (
          <p className="flex items-center gap-2 px-4 py-6 text-xs text-muted">
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
            Загружаю карточку…
          </p>
        )}

        {card && (
          <div className="space-y-5 px-4 py-4">
            {(card.phone ?? card.site ?? card.address ?? card.contacts.length > 0) && (
              <section className="space-y-1.5 text-xs">
                {card.phone && (
                  <p>
                    <a href={`tel:+${card.phone.replace(/\D+/g, "")}`} className="num text-fg hover:text-accent">
                      {card.phone}
                    </a>
                  </p>
                )}
                {card.site && (
                  <p className="truncate">
                    <a
                      href={card.site.startsWith("http") ? card.site : `https://${card.site}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-fg hover:text-accent"
                    >
                      {card.site}
                    </a>
                  </p>
                )}
                {card.address && <p className="text-muted">{card.address}</p>}
                {card.contacts.map((c) => (
                  <p key={c.id} className="text-muted">
                    {[c.name, c.role].filter(Boolean).join(", ") || "Контакт"}
                    {c.phone ? ` · ${c.phone}` : ""}
                    {c.email ? ` · ${c.email}` : ""}
                    {c.telegram ? ` · ${c.telegram}` : ""}
                  </p>
                ))}
                {card.note && <p className="pt-1 text-muted">{card.note}</p>}
              </section>
            )}

            {(card.aiScore !== null || card.aiNextStep) && (
              <section className="rounded-md border border-line bg-surface-2 p-3">
                <p className="label-xs flex items-center gap-1.5 text-muted">
                  <Sparkles aria-hidden className="size-3" />
                  Оценка ИИ
                  {card.aiScore !== null && <span className="num text-fg">{card.aiScore}/100</span>}
                </p>
                {card.aiNextStep && (
                  <p className="mt-2 text-xs text-fg">{card.aiNextStep.action}</p>
                )}
                {card.aiNextStep?.why && (
                  <p className="mt-1 text-xs text-muted">{card.aiNextStep.why}</p>
                )}
                {card.aiScoreReasons.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-xs text-muted">
                    {card.aiScoreReasons.map((r) => (
                      <li key={r}>• {r}</li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-[11px] text-muted">
                  Это мнение модели, а не факт: решение за вами.
                </p>
              </section>
            )}

            {card.deals.length > 0 && (
              <section>
                <p className="label-xs text-muted">Сделки</p>
                <ul className="mt-2 space-y-2">
                  {card.deals.map((deal) => (
                    <li key={deal.id} className="rounded-md border border-line p-2.5 text-xs">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-fg">{deal.title}</span>
                        <span className="num shrink-0 text-fg">
                          {formatKop(deal.amountMonthlyKop)}
                        </span>
                      </div>
                      <p className="mt-1 text-muted">
                        {deal.stageName} · {deal.daysInStage} дн.
                        {deal.lostReason
                          ? ` · ${LOST_REASON_LABEL[deal.lostReason] ?? deal.lostReason}`
                          : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {card.followUps.length > 0 && (
              <section>
                <p className="label-xs text-muted">Обещано</p>
                <ul className="mt-2 space-y-2">
                  {card.followUps.map((f) => (
                    <li
                      key={f.id}
                      className={cn(
                        "rounded-md border p-2.5 text-xs",
                        f.overdue ? "border-warn/50" : "border-line",
                      )}
                    >
                      <p className={f.overdue ? "text-warn" : "text-fg"}>
                        {formatMoment(f.dueAt)}
                        {f.overdue ? " · просрочено" : ""}
                      </p>
                      {f.note && <p className="mt-0.5 text-muted">{f.note}</p>}
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void closeFollowUp(f.id, "DONE")}
                          className="flex items-center gap-1 rounded border border-line px-2 py-1 text-[11px] text-fg hover:border-accent disabled:opacity-40"
                        >
                          <Check aria-hidden className="size-3" />
                          Сделал
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void closeFollowUp(f.id, "SKIPPED")}
                          className="rounded px-2 py-1 text-[11px] text-muted hover:text-fg disabled:opacity-40"
                        >
                          Пропустить
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <form onSubmit={submitTouch} className="space-y-2.5">
              <p className="label-xs text-muted">Записать касание</p>

              <div className="flex flex-wrap gap-1.5">
                {TOUCH_KINDS.map((k) => (
                  <button
                    key={k.value}
                    type="button"
                    onClick={() => setKind(k.value)}
                    className={cn(
                      "rounded-md border px-2 py-1 text-[11px] transition-colors",
                      kind === k.value
                        ? "border-accent text-fg"
                        : "border-line text-muted hover:text-fg",
                    )}
                  >
                    {k.label}
                  </button>
                ))}
              </div>

              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={3}
                placeholder="Что сказали, о чём договорились"
                aria-label="Что произошло"
                className="w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg outline-none placeholder:text-muted focus:border-accent"
              />

              <div>
                <p className="text-[11px] text-muted">Вернуться к лиду:</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {FOLLOW_UP_PRESETS.map((p) => {
                    const value = presetValue(p.days);
                    return (
                      <button
                        key={p.days}
                        type="button"
                        onClick={() => setFollowUpAt((cur) => (cur === value ? "" : value))}
                        className={cn(
                          "rounded-md border px-2 py-1 text-[11px] transition-colors",
                          followUpAt === value
                            ? "border-accent text-fg"
                            : "border-line text-muted hover:text-fg",
                        )}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                  <input
                    type="datetime-local"
                    value={followUpAt}
                    onChange={(e) => setFollowUpAt(e.target.value)}
                    aria-label="Срок следующего касания"
                    className="num rounded-md border border-line bg-surface-2 px-2 py-1 text-[11px] text-fg outline-none focus:border-accent"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg transition-opacity disabled:opacity-40"
              >
                {busy ? "Записываю…" : "Записать"}
              </button>

              {actionError && (
                <p className="flex items-center gap-2 text-xs text-danger">
                  <AlertTriangle aria-hidden className="size-3.5" />
                  {actionError}
                </p>
              )}
            </form>

            <section>
              <p className="label-xs text-muted">История</p>
              {card.touches.length === 0 ? (
                <p className="mt-2 text-xs text-muted">Касаний ещё не было.</p>
              ) : (
                <ul className="mt-2 space-y-2.5">
                  {card.touches.map((t) => (
                    <li key={t.id} className="border-l border-line pl-3 text-xs">
                      <p className="text-muted">
                        {formatDay(t.occurredAt)} · {TOUCH_KIND_LABEL[t.kind] ?? t.kind}
                      </p>
                      {t.stageMove && (
                        <p className="text-fg">
                          {t.stageMove.from} → {t.stageMove.to}
                        </p>
                      )}
                      {t.body && <p className="text-fg">{t.body}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

export default LeadDrawer;
