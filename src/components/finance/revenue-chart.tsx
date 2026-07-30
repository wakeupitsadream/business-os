"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatKop, kopToRubles } from "@/core/shared/money";
import { usePrivacy } from "./privacy";

/**
 * Доходы, расходы и прибыль по месяцам.
 *
 * График получает рубли, а не копейки: ось с числами вида 12000000 нечитаема.
 * На расчёты это не влияет — они остались в целых копейках на сервере, сюда
 * приходит уже посчитанный ряд.
 */

export interface ChartPoint {
  label: string;
  incomeKop: number;
  expenseKop: number;
  profitKop: number;
}

const AXIS_TICK = { fill: "var(--color-muted)", fontSize: 11 };

export function RevenueChart({ data }: { data: ChartPoint[] }) {
  const { hidden } = usePrivacy();

  const points = data.map((p) => ({
    label: p.label,
    Доходы: kopToRubles(p.incomeKop),
    Расходы: kopToRubles(p.expenseKop),
    Прибыль: kopToRubles(p.profitKop),
  }));

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid stroke="var(--color-line)" vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} />
          <YAxis
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={hidden ? 24 : 56}
            // В режиме приватности молчит и ось: иначе оборот читается по шкале.
            tickFormatter={(v: number) => (hidden ? "" : compact(v))}
          />
          <Tooltip
            cursor={{ fill: "var(--color-surface-2)" }}
            contentStyle={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-line)",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: "var(--color-muted)" }}
            formatter={(value, name) => [
              hidden ? "••• ₽" : formatKop(Math.round(Number(value ?? 0) * 100)),
              String(name ?? ""),
            ]}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: "var(--color-muted)" }} />
          <Bar dataKey="Доходы" fill="var(--color-accent)" radius={[3, 3, 0, 0]} maxBarSize={28} />
          <Bar dataKey="Расходы" fill="var(--color-line)" radius={[3, 3, 0, 0]} maxBarSize={28} />
          <Line
            type="monotone"
            dataKey="Прибыль"
            stroke="var(--color-ok)"
            strokeWidth={2}
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Короткая подпись оси: 1 200 000 → «1,2 млн». */
export function compact(rubles: number): string {
  const abs = Math.abs(rubles);
  if (abs >= 1_000_000) return `${trim(rubles / 1_000_000)} млн`;
  if (abs >= 1_000) return `${trim(rubles / 1_000)} тыс`;
  return String(Math.round(rubles));
}

function trim(n: number): string {
  return n.toFixed(1).replace(/[.,]0$/, "").replace(".", ",");
}

export default RevenueChart;
