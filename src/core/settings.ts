import { prisma } from "@/core/db";
import { OWNER_TZ } from "@/core/shared/time";

/**
 * Настройки владельца — singleton с фиксированным id.
 *
 * Создаётся по требованию, а не сидом: система не должна зависеть от того,
 * вспомнил ли кто-то запустить seed после развёртывания новой базы. Первый
 * же вызов создаёт строку с дефолтами.
 */
export const OWNER_SETTINGS_ID = "owner";

export interface OwnerProfile {
  /** Короткая «конституция» для системного промпта: ценности, график, границы. */
  constitution?: string;
  /** Чем занимается владелец — контекст для советов агента. */
  businessContext?: string;
  /** Предпочтения по тону общения. */
  tone?: string;
}

export async function getSettings() {
  return prisma.settings.upsert({
    where: { id: OWNER_SETTINGS_ID },
    update: {},
    create: { id: OWNER_SETTINGS_ID, timezone: OWNER_TZ },
  });
}

/** Таймзона владельца с безопасным дефолтом: БД недоступна — не роняем вызов. */
export async function getOwnerTimezone(): Promise<string> {
  try {
    const s = await getSettings();
    return s.timezone || OWNER_TZ;
  } catch {
    return OWNER_TZ;
  }
}

export async function getOwnerProfile(): Promise<OwnerProfile> {
  const s = await getSettings();
  const raw = s.ownerProfile;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as OwnerProfile) : {};
}

export async function updateOwnerProfile(patch: OwnerProfile): Promise<OwnerProfile> {
  const current = await getOwnerProfile();
  const next = { ...current, ...patch };
  await prisma.settings.update({
    where: { id: OWNER_SETTINGS_ID },
    data: { ownerProfile: next as never },
  });
  return next;
}
