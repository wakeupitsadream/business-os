"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, FileUp, Info, Loader2 } from "lucide-react";
import { cn } from "@/core/shared/cn";
import { formatKop } from "@/core/shared/money";

/**
 * Загрузка выписки и предпросмотр.
 *
 * Один компонент на оба шага намеренно: между ними нет паузы и нет решения,
 * которое стоило бы отделять переходом на другой экран. Владелец выбирает
 * файл, тут же видит, что из него получилось, и подтверждает.
 */

const MAX_MB = 10;

export interface AccountOption {
  id: string;
  name: string;
}

export interface CategoryOption {
  id: string;
  name: string;
  type: "INCOME" | "EXPENSE" | "TRANSFER";
}

interface PreviewRow {
  index: number;
  lineNo: number;
  date: string;
  amountKop: number;
  type: "INCOME" | "EXPENSE";
  description: string;
  dedupKey: string;
  rowClass: "new" | "duplicate" | "transfer" | "settlement";
  categoryId: string | null;
  categoryName: string | null;
  counterpartAccount?: string | null;
  transferConfidence?: "high" | "low";
  transferNote?: string;
  settlementNote?: string;
}

interface ControlSum {
  status: "not_available" | "matched" | "mismatch";
  reason?: string;
  declaredKop?: number;
  computedKop?: number;
  deltaKop?: number;
}

interface Stats {
  accountName: string;
  bankLabel: string;
  encoding: string;
  total: number;
  fresh: number;
  duplicates: number;
  transfers: number;
  settlements: number;
  pending: number;
  skipped: Array<{ lineNo: number; reason: string }>;
  incomeKop: number;
  expenseKop: number;
  controlSum: ControlSum;
  fingerprint: string;
}

interface Preview {
  id: string;
  status: string;
  stats: Stats;
  rows: PreviewRow[];
}

type Decision = {
  include: boolean;
  categoryId?: string | null;
  mergeTransfer?: boolean;
  settlementAsIncome?: boolean;
};

export function ImportFlow({
  accounts,
  categories,
}: {
  accounts: AccountOption[];
  categories: CategoryOption[];
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);

  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [done, setDone] = useState<string | null>(null);

  async function upload(file: File) {
    if (file.size > MAX_MB * 1024 * 1024) {
      setError(`Файл больше ${MAX_MB} МБ`);
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);

    try {
      const query = new URLSearchParams({ accountId, fileName: file.name });
      const res = await fetch(`/api/finance/import?${query}`, {
        method: "POST",
        body: file,
        headers: { "content-type": "text/csv" },
      });
      const data = (await res.json()) as { error?: string; id?: string; status?: string; stats?: Stats };
      if (!res.ok || !data.id || !data.stats) {
        setError(data.error ?? "Не удалось разобрать выписку");
        return;
      }

      const detail = await fetch(`/api/finance/import/${data.id}`);
      const full = (await detail.json()) as { batch?: { parsedRows?: PreviewRow[] } };

      setPreview({
        id: data.id,
        status: data.status ?? "PREVIEW",
        stats: data.stats,
        rows: full.batch?.parsedRows ?? [],
      });
      setDecisions({});
    } catch {
      setError("Сеть недоступна — файл не загружен");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/finance/import/${preview.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "commit",
          fingerprint: preview.stats.fingerprint,
          acknowledgeWarnings: preview.status === "NEEDS_REVIEW",
          decisions: preview.rows.map((row) => ({
            index: row.index,
            include: decisions[row.index]?.include ?? true,
            categoryId: decisions[row.index]?.categoryId ?? row.categoryId,
            mergeTransfer: decisions[row.index]?.mergeTransfer ?? false,
            settlementAsIncome: decisions[row.index]?.settlementAsIncome ?? false,
          })),
        }),
      });
      const data = (await res.json()) as { error?: string; created?: number; merged?: number };
      if (!res.ok) {
        setError(data.error ?? "Импорт не удался");
        return;
      }

      setDone(`Импортировано операций: ${data.created ?? 0}` + (data.merged ? `, сведено переводов: ${data.merged}` : ""));
      setPreview(null);
      router.refresh();
    } catch {
      setError("Сеть недоступна — операции не записаны");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-4">
        <p className="flex items-center gap-2 text-sm text-ok">
          <CheckCircle2 aria-hidden className="size-4" />
          {done}
        </p>
        <button
          type="button"
          onClick={() => setDone(null)}
          className="rounded-md border border-line px-3 py-1.5 text-xs text-muted hover:text-fg"
        >
          Загрузить ещё выписку
        </button>
      </div>
    );
  }

  if (preview) {
    return (
      <Preview
        preview={preview}
        categories={categories}
        decisions={decisions}
        setDecisions={setDecisions}
        busy={busy}
        error={error}
        onCommit={() => void commit()}
        onCancel={() => {
          void fetch(`/api/finance/import/${preview.id}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "cancel" }),
          });
          setPreview(null);
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="label-xs text-muted">Счёт выписки</span>
        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="mt-1.5 w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        disabled={busy || accountId === ""}
        className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-line px-6 py-10 text-center transition-colors hover:border-accent disabled:opacity-50"
      >
        {busy ? (
          <Loader2 aria-hidden className="size-5 animate-spin text-accent" />
        ) : (
          <FileUp aria-hidden className="size-5 text-muted" />
        )}
        <span className="text-sm text-fg">{busy ? "Разбираю выписку…" : "Выбрать файл выписки"}</span>
        <span className="text-xs text-muted">CSV из банка, до {MAX_MB} МБ</span>
      </button>

      <input
        ref={fileInput}
        type="file"
        accept=".csv,.txt,text/csv,text/plain"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = "";
        }}
      />

      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

function Preview({
  preview,
  categories,
  decisions,
  setDecisions,
  busy,
  error,
  onCommit,
  onCancel,
}: {
  preview: Preview;
  categories: CategoryOption[];
  decisions: Record<number, Decision>;
  setDecisions: (fn: (prev: Record<number, Decision>) => Record<number, Decision>) => void;
  busy: boolean;
  error: string | null;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { stats } = preview;
  const visible = preview.rows.filter((r) => r.rowClass !== "duplicate");
  const duplicates = preview.rows.filter((r) => r.rowClass === "duplicate");
  const willImport = visible.filter((r) => decisions[r.index]?.include !== false).length;

  const update = (index: number, patch: Decision) =>
    setDecisions((prev) => ({ ...prev, [index]: { ...prev[index], ...patch } }));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Figure label="Новых" value={String(stats.fresh)} />
        <Figure label="Дублей" value={String(stats.duplicates)} hint="не импортируются" />
        {stats.settlements > 0 ? (
          <Figure
            label="Выводов ЮKassa"
            value={String(stats.settlements)}
            hint="переводом, не доходом"
          />
        ) : (
          <Figure label="Доходы" value={formatKop(stats.incomeKop)} />
        )}
        <Figure label="Расходы" value={formatKop(stats.expenseKop)} />
      </div>

      <ControlSumBanner control={stats.controlSum} />

      <p className="text-xs text-muted">
        {stats.bankLabel} · счёт «{stats.accountName}» · кодировка {stats.encoding}
        {stats.pending > 0 && ` · ${stats.pending} операц. в обработке — придут следующей выпиской`}
      </p>

      {stats.skipped.length > 0 && (
        <div className="rounded-md border border-warn/40 bg-surface-2 p-3">
          <p className="flex items-center gap-2 text-xs text-warn">
            <AlertTriangle aria-hidden className="size-3.5" />
            Не разобрано строк: {stats.skipped.length}
          </p>
          <ul className="mt-2 space-y-1 text-xs text-muted">
            {stats.skipped.slice(0, 5).map((s) => (
              <li key={s.lineNo}>
                строка {s.lineNo}: {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="max-h-96 overflow-y-auto rounded-md border border-line">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-surface-2 text-muted">
            <tr>
              <th className="px-3 py-2 font-normal">Брать</th>
              <th className="px-3 py-2 font-normal">Дата</th>
              <th className="px-3 py-2 font-normal">Операция</th>
              <th className="px-3 py-2 font-normal">Категория</th>
              <th className="px-3 py-2 text-right font-normal">Сумма</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {visible.map((row) => (
              <tr key={row.index}>
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={decisions[row.index]?.include !== false}
                    onChange={(e) => update(row.index, { include: e.target.checked })}
                    aria-label={`Импортировать строку ${row.lineNo}`}
                  />
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-muted">
                  {row.date.slice(8, 10)}.{row.date.slice(5, 7)}
                </td>
                <td className="max-w-[18rem] px-3 py-2">
                  <span className="block truncate text-fg">{row.description}</span>
                  {row.rowClass === "transfer" && (
                    <label className="mt-1 flex items-center gap-1.5 text-xs text-accent">
                      <input
                        type="checkbox"
                        checked={decisions[row.index]?.mergeTransfer ?? false}
                        onChange={(e) => update(row.index, { include: true, mergeTransfer: e.target.checked })}
                      />
                      свести с операцией на «{row.counterpartAccount}» как перевод
                    </label>
                  )}
                  {row.rowClass === "settlement" && (
                    <label className="mt-1 flex items-start gap-1.5 text-xs text-accent">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={decisions[row.index]?.settlementAsIncome !== true}
                        onChange={(e) =>
                          update(row.index, { include: true, settlementAsIncome: !e.target.checked })
                        }
                      />
                      <span>
                        вывод эквайринга — записать переводом со счёта «ЮKassa», а не доходом
                        <span className="block text-muted">
                          эта выручка уже учтена синком ЮKassa; сними галочку, если это настоящий
                          платёж клиента
                        </span>
                      </span>
                    </label>
                  )}
                  {row.rowClass !== "settlement" && row.settlementNote && (
                    <span className="block text-xs text-muted">{row.settlementNote}</span>
                  )}
                  {row.transferNote && <span className="text-xs text-muted">{row.transferNote}</span>}
                </td>
                <td className="px-3 py-2">
                  <select
                    value={decisions[row.index]?.categoryId ?? row.categoryId ?? ""}
                    onChange={(e) => update(row.index, { include: true, categoryId: e.target.value || null })}
                    className="w-full max-w-[10rem] rounded border border-line bg-surface-2 px-1.5 py-1 text-xs text-fg outline-none focus:border-accent"
                  >
                    <option value="">— без категории —</option>
                    {categories
                      .filter((c) => c.type === row.type)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </td>
                <td
                  className={cn(
                    "num px-3 py-2 text-right whitespace-nowrap",
                    row.type === "INCOME" ? "text-ok" : "text-fg",
                  )}
                >
                  {row.type === "INCOME" ? "+" : "−"}
                  {formatKop(row.amountKop)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <DuplicateRows rows={duplicates} />

      {error && <p className="text-xs text-danger">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCommit}
          disabled={busy || willImport === 0}
          className="flex-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg transition-opacity disabled:opacity-40"
        >
          {busy ? "Импортирую…" : `Импортировать ${willImport} операц.`}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-line px-3 py-2 text-sm text-muted hover:text-fg"
        >
          Отменить
        </button>
      </div>
    </div>
  );
}

/**
 * Баннер контрольной сверки.
 *
 * Три разных состояния и три разных вида. «Сверять не с чем» показывается
 * нейтрально и без галочки: галочка означала бы проверку, которой не было, и
 * владелец счёл бы импорт выверенным.
 */
/**
 * Дубли — списком, а не одним числом.
 *
 * Раньше строки-дубли выкидывались из таблицы совсем, и владелец видел только
 * счётчик «Дублей: N». Проверить это число было нечем: строки, которую съели,
 * на экране просто нет. Теперь она есть — приглушённая, без галочки (дубль не
 * пишется даже по прямой просьбе), но видимая и сверяемая с выпиской.
 */
function DuplicateRows({ rows }: { rows: PreviewRow[] }) {
  if (rows.length === 0) return null;

  return (
    <details className="rounded-md border border-line">
      <summary className="cursor-pointer px-3 py-2 text-xs text-muted">
        {rows.length} строк уже есть в базе — не импортируются. Показать
      </summary>
      <ul className="divide-y divide-line border-t border-line">
        {rows.map((row) => (
          <li key={row.index} className="flex items-baseline gap-3 px-3 py-2 text-xs text-muted">
            <span className="whitespace-nowrap">
              {row.date.slice(8, 10)}.{row.date.slice(5, 7)}
            </span>
            <span className="min-w-0 flex-1 truncate">{row.description}</span>
            <span className="num whitespace-nowrap">
              {row.type === "INCOME" ? "+" : "−"}
              {formatKop(row.amountKop)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ControlSumBanner({ control }: { control: ControlSum }) {
  if (control.status === "matched") {
    return (
      <p className="flex items-center gap-2 rounded-md border border-ok/40 bg-surface-2 p-3 text-xs text-ok">
        <CheckCircle2 aria-hidden className="size-3.5" />
        Итоги файла сходятся с разобранными строками.
      </p>
    );
  }

  if (control.status === "mismatch") {
    return (
      <p className="flex items-start gap-2 rounded-md border border-danger/40 bg-surface-2 p-3 text-xs text-danger">
        <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Итоги файла НЕ сходятся: в шапке {formatKop(control.declaredKop ?? 0)}, по строкам{" "}
          {formatKop(control.computedKop ?? 0)}, расхождение {formatKop(control.deltaKop ?? 0)}.
          Проверь выписку перед импортом.
        </span>
      </p>
    );
  }

  return (
    <p className="flex items-start gap-2 rounded-md border border-line bg-surface-2 p-3 text-xs text-muted">
      <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>
        В файле нет итоговой строки — сверять не с чем. Итоги ниже посчитаны по разобранным
        строкам; сверь их с приложением банка сам.
      </span>
    </p>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-line bg-surface-2 px-3 py-2">
      <p className="label-xs text-muted">{label}</p>
      <p className="num mt-1 text-sm text-fg">{value}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

export default ImportFlow;
