import { SkeletonScreen } from "@/components/os/skeleton";

/** Скелетон на время загрузки серверного экрана. */
export default function Loading() {
  return <SkeletonScreen kpis={4} rows={5} />;
}
