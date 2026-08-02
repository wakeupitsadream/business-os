"use client";

import { useState } from "react";
import { PipelineBoard, type BoardStage } from "./pipeline-board";
import { LeadDrawer } from "./lead-drawer";

/**
 * Доска плюс карточка лида.
 *
 * Тонкая клиентская обёртка: страница продаж остаётся серверным компонентом и
 * по-прежнему считает все цифры на сервере, а состояние «какой лид открыт»
 * живёт здесь — держать его в URL значило бы перезагружать доску на каждый
 * просмотр лида.
 */

export function SalesWorkspace({ stages }: { stages: BoardStage[] }) {
  const [openLeadId, setOpenLeadId] = useState<string | null>(null);

  return (
    <>
      <PipelineBoard stages={stages} onOpenLead={setOpenLeadId} />
      {openLeadId && <LeadDrawer leadId={openLeadId} onClose={() => setOpenLeadId(null)} />}
    </>
  );
}

export default SalesWorkspace;
