"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { cn } from "@/core/shared/cn";

export interface TaskItem {
  id: string;
  title: string;
  due: string | null;
  overdue: boolean;
  urgent: boolean;
}

export function TaskList({ initial }: { initial: TaskItem[] }) {
  const [tasks, setTasks] = useState(initial);
  const [, startTransition] = useTransition();
  const [failed, setFailed] = useState<string | null>(null);

  async function complete(id: string) {
    // Убираем из списка сразу: ожидание ответа сервера на такое действие
    // выглядит как подвисший интерфейс. При неудаче задача вернётся.
    const snapshot = tasks;
    setTasks((t) => t.filter((x) => x.id !== id));
    setFailed(null);

    try {
      const res = await fetch(`/api/tasks/${id}/complete`, { method: "POST" });
      if (!res.ok) throw new Error("не удалось");
      startTransition(() => {});
    } catch {
      setTasks(snapshot);
      setFailed("Не удалось отметить задачу — попробуй ещё раз");
    }
  }

  if (tasks.length === 0) {
    return <p className="text-sm text-muted">Открытых задач нет.</p>;
  }

  return (
    <div className="space-y-2">
      {failed && <p className="text-xs text-danger">{failed}</p>}
      {tasks.map((t) => (
        <div
          key={t.id}
          className="flex items-start gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2"
        >
          <button
            type="button"
            onClick={() => void complete(t.id)}
            className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-line text-transparent transition hover:border-accent hover:text-accent"
            aria-label={`Выполнить: ${t.title}`}
          >
            <Check className="h-3 w-3" />
          </button>
          <div className="min-w-0 flex-1">
            <p className={cn("text-sm text-fg", t.urgent && "font-medium")}>
              {t.urgent && <span className="mr-1 text-accent">!</span>}
              {t.title}
            </p>
            {t.due && (
              <p className={cn("label-xs mt-0.5", t.overdue ? "text-danger" : "text-muted")}>
                {t.overdue ? "просрочена — " : ""}
                {t.due}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
