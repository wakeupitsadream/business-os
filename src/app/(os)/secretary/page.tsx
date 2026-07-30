import type { Metadata } from "next";
import { prisma } from "@/core/db";
import { KpiCard } from "@/components/os/kpi-card";
import { Panel } from "@/components/os/panel";
import { ChatPanel } from "@/components/secretary/chat-panel";
import { TaskList, type TaskItem } from "@/components/secretary/task-list";
import { dayBounds, formatLocal } from "@/core/shared/time";
import { latestCheckIn } from "@/modules/secretary/checkin";
import { briefDate } from "@/modules/secretary/brief";
import { countStreak } from "@/modules/secretary/streak";

export const metadata: Metadata = { title: "Секретарь — Business OS" };

/**
 * Страница строится на каждый запрос: это личная панель одного человека,
 * кэшировать нечего, а устаревший список задач хуже секунды ожидания.
 */
export const dynamic = "force-dynamic";

export default async function SecretaryPage() {
  const data = await loadPage();

  if (!data) {
    return (
      <div className="space-y-6">
        <Header />
        <Panel title="База недоступна">
          <p className="text-sm text-muted">
            Секретарь не может показать задачи и историю. Причина — в{" "}
            <code className="font-mono text-fg">/api/health</code>.
          </p>
        </Panel>
      </div>
    );
  }

  const { tasks, brief, checkIn, history, doneToday, streak } = data;

  return (
    <div className="space-y-6">
      <Header />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Настроение / энергия"
          value={
            checkIn && (checkIn.mood !== null || checkIn.energy !== null)
              ? `${checkIn.mood ?? "—"} / ${checkIn.energy ?? "—"}`
              : "—"
          }
          hint={checkIn ? `чек-ин ${formatLocal(checkIn.date)}` : "чек-инов ещё не было"}
        />
        <KpiCard label="Открытых задач" value={String(tasks.length)} hint="в работе" />
        <KpiCard
          label="Закрыто сегодня"
          value={String(doneToday)}
          hint={streak > 0 ? `серия: ${streak} дн.` : "задач"}
        />
        <KpiCard
          label="Фокус дня"
          value={brief?.focus ? "есть" : "—"}
          hint={brief?.focus ?? "бриф ещё не приходил"}
          accent={Boolean(brief?.focus)}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
        <div className="space-y-6">
          {brief && (
            <Panel title="Утренний бриф" subtitle={formatLocal(brief.createdAt)}>
              <p className="whitespace-pre-wrap text-sm text-fg">{brief.content}</p>
            </Panel>
          )}

          <Panel title="Задачи">
            <TaskList initial={tasks} />
          </Panel>
        </div>

        <Panel title="Ася" subtitle="общая история с Telegram">
          <div className="h-[560px]">
            <ChatPanel initial={history} />
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Header() {
  return (
    <section>
      <p className="label-xs text-muted">Отдел</p>
      <h2 className="mt-2 text-xl font-medium text-fg">Секретарь</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Ася помнит договорённости, ведёт задачи и напоминания, приносит утренний бриф. Разговор
        продолжается в Telegram и обратно.
      </p>
    </section>
  );
}

/** null — база недоступна; страница обязана это пережить, а не упасть. */
async function loadPage() {
  const now = new Date();
  const today = dayBounds(now);

  try {
    const [openTasks, brief, checkIn, conversation, doneToday, recentDone] = await Promise.all([
      prisma.task.findMany({
        where: { status: { in: ["TODO", "IN_PROGRESS"] } },
        orderBy: [{ priority: "asc" }, { dueAt: { sort: "asc", nulls: "last" } }],
        take: 30,
        select: { id: true, title: true, dueAt: true, priority: true },
      }),
      prisma.dailyBrief.findUnique({
        where: { date: briefDate(now) },
        select: { content: true, focus: true, createdAt: true },
      }),
      latestCheckIn(),
      prisma.conversation.findFirst({
        where: { agentKey: "secretary", archived: false },
        orderBy: { updatedAt: "desc" },
        select: {
          messages: {
            where: { role: { in: ["USER", "ASSISTANT"] } },
            orderBy: { createdAt: "desc" },
            take: 20,
            select: { role: true, content: true },
          },
        },
      }),
      prisma.task.count({
        where: { status: "DONE", completedAt: { gte: today.start, lt: today.end } },
      }),
      prisma.task.findMany({
        where: { status: "DONE", completedAt: { not: null } },
        orderBy: { completedAt: "desc" },
        take: 60,
        select: { completedAt: true },
      }),
    ]);

    const tasks: TaskItem[] = openTasks.map((t) => ({
      id: t.id,
      title: t.title,
      due: t.dueAt ? formatLocal(t.dueAt) : null,
      overdue: t.dueAt !== null && t.dueAt < now,
      urgent: t.priority === 1,
    }));

    const history = (conversation?.messages ?? [])
      .slice()
      .reverse()
      .map((m) => ({
        role: m.role === "USER" ? ("user" as const) : ("assistant" as const),
        content: m.content,
      }));

    return {
      tasks,
      brief,
      checkIn,
      history,
      doneToday,
      streak: countStreak(
        recentDone.map((r) => r.completedAt).filter((d): d is Date => d !== null),
        now,
      ),
    };
  } catch {
    return null;
  }
}
