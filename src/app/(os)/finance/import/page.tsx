import type { Metadata } from "next";
import { Prisma } from "@prisma/client";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Panel } from "@/components/os/panel";
import { ImportFlow, type AccountOption, type CategoryOption } from "@/components/finance/import-flow";
import { ImportHistory, type BatchRow } from "@/components/finance/import-history";
import { prisma } from "@/core/db";
import { logWarn } from "@/core/observability/logger";
import { formatLocal } from "@/core/shared/time";

export const metadata: Metadata = { title: "Импорт выписки — Business OS" };

export const dynamic = "force-dynamic";

/**
 * Импорт банковской выписки.
 *
 * Вложенная страница раздела «Финансы». В боковое меню намеренно не выносится:
 * это действие, а не отдел, и делается оно раз в месяц. Ссылка стоит на самой
 * странице финансов.
 */
export default async function ImportPage() {
  const data = await loadPage();

  return (
    <div className="space-y-6">
      <section>
        <Link
          href="/finance"
          className="label-xs inline-flex items-center gap-1.5 text-muted transition-colors hover:text-fg"
        >
          <ArrowLeft aria-hidden className="size-3" />
          Финансы
        </Link>
        <h2 className="mt-2 text-xl font-medium text-fg">Импорт выписки</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          CSV из банка превращается в операции: повторная загрузка того же файла новых строк не
          создаёт, а любой импорт можно откатить целиком.
        </p>
      </section>

      {!data ? (
        <Panel title="База недоступна">
          <p className="text-sm text-muted">
            Импорт сейчас невозможен. Причина — в{" "}
            <code className="font-mono text-fg">/api/health</code>.
          </p>
        </Panel>
      ) : data.accounts.length === 0 ? (
        <Panel title="Нет счетов">
          <p className="text-sm text-muted">
            Выписку некуда импортировать: не заведено ни одного счёта.
          </p>
        </Panel>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <Panel title="Файл выписки">
            <ImportFlow accounts={data.accounts} categories={data.categories} />
          </Panel>

          <Panel title="История импортов">
            <ImportHistory batches={data.batches} />
          </Panel>
        </div>
      )}
    </div>
  );
}

interface PageData {
  accounts: AccountOption[];
  categories: CategoryOption[];
  batches: BatchRow[];
}

async function loadPage(): Promise<PageData | null> {
  try {
    const [accounts, categories, batches] = await Promise.all([
      prisma.account.findMany({
        where: { isArchived: false },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        select: { id: true, name: true },
      }),
      prisma.category.findMany({
        where: { isArchived: false },
        orderBy: { sortOrder: "asc" },
        select: { id: true, name: true, type: true },
      }),
      prisma.importBatch.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          fileName: true,
          status: true,
          error: true,
          createdAt: true,
          _count: { select: { transactions: true } },
        },
      }),
    ]);

    // Только признак «файл на месте», не сам файл: rawFile — это байты
    // выписки, и тянуть их в серверный компонент ради галочки незачем.
    // Prisma.join по пустому списку бросает — на пустой истории запрос не нужен.
    const withRaw = batches.length
      ? await prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "ImportBatch"
          WHERE "rawFile" IS NOT NULL AND id IN (${Prisma.join(batches.map((b) => b.id))})
        `
      : [];
    const hasRaw = new Set(withRaw.map((r) => r.id));

    return {
      accounts,
      categories,
      batches: batches.map((b) => ({
        id: b.id,
        fileName: b.fileName,
        status: b.status,
        error: b.error,
        createdAt: formatLocal(b.createdAt),
        transactions: b._count.transactions,
        hasRawFile: hasRaw.has(b.id),
      })),
    };
  } catch (e) {
    logWarn("finance.import_page_unavailable", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
