/**
 * Отдел «Финансы»: учёт операций, справочники, агрегаты.
 *
 * Наружу модуль отдаёт инструменты для агента и функции чтения. Запись идёт
 * только через `createTransaction` — единственное место, где строки попадают
 * в Transaction.
 */

export { addTransaction, listRecentTransactions, queryFinance } from "./tools/transactions";
export {
  APPROVAL_THRESHOLD_KOP,
  buildDedupKey,
  createTransaction,
  findCategoryByName,
  resolveAccount,
  resolveProject,
  TransactionInputError,
  type CreateTransactionInput,
} from "./transactions";
export {
  loadCategoryOptions,
  matchCategoryByAliases,
  resolveCategory,
  type CategoryMatch,
  type CategoryOption,
} from "./categorize";
export { expandCategoryIds, listTransactions, sumByCategory, sumByType } from "./query";
export { explicitRange, resolvePeriod, PERIOD_NAMES, type PeriodName, type Range } from "./period";
