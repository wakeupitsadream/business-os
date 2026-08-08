import { SkeletonScreen } from "@/components/os/skeleton";

/** Панель ходит во внешние API — до ответа показываем форму, а не пустоту. */
export default function DevLoading() {
  return <SkeletonScreen kpis={4} rows={6} />;
}
