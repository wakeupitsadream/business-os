import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/core/db";
import { assertDisposableDatabase, liveDbEnabled } from "@/core/testing/live-db";
import { loadCalendar, parseMonthKey } from "./calendar";
import { ContentError, approvePost, reschedulePost, schedulePost, unschedulePost } from "./actions";

/**
 * Контент на живой базе.
 *
 * Здесь проверяется то, чего моками не проверить: что сетка календаря режется
 * по поясу владельца, что перенос сохраняет время суток и что правила статусов
 * не обойти — они и не дают опубликовать пост дважды.
 */

const AUG = new Date("2026-08-15T09:00:00Z");

async function makePost(over: Record<string, unknown> = {}) {
  return prisma.contentPost.create({
    data: {
      channel: "TELEGRAM",
      status: "IDEA",
      rubric: "CASE",
      title: "Тестовая тема",
      body: "Текст поста достаточной длины.",
      scheduledAt: new Date("2026-08-12T05:00:00Z"), // 10:00 по владельцу
      ...over,
    },
  });
}

describe.runIf(liveDbEnabled)("контент на живой базе", () => {
  beforeEach(async () => {
    assertDisposableDatabase();
    await prisma.contentPost.deleteMany({});
  });

  describe("сетка календаря", () => {
    it("шесть недель с понедельника, без прыжков высоты", async () => {
      const view = await loadCalendar(AUG, AUG);
      expect(view.days).toHaveLength(42);
      expect(view.weekdays[0]).toBe("Пн");
      expect(view.monthKey).toBe("2026-08");
    });

    it("пост в 02:00 местного попадает в свой день, а не во вчерашний", async () => {
      // 1 августа 02:00 по Екатеринбургу = 31 июля 21:00 UTC. По UTC это ещё
      // июль — сетка, посчитанная в браузере, показала бы его не там.
      const post = await makePost({ scheduledAt: new Date("2026-07-31T21:00:00Z") });

      const view = await loadCalendar(AUG, AUG);
      const day = view.days.find((d) => d.posts.some((p) => p.id === post.id));

      expect(day?.key).toBe("2026-08-01");
      expect(day?.inCurrentMonth).toBe(true);
    });

    it("время в карточке — местное владельца", async () => {
      const post = await makePost({ scheduledAt: new Date("2026-08-12T05:00:00Z") });
      const view = await loadCalendar(AUG, AUG);
      const card = view.days.flatMap((d) => d.posts).find((p) => p.id === post.id);
      expect(card?.timeLabel).toBe("10:00");
    });

    it("мусор в адресе не роняет страницу", () => {
      expect(parseMonthKey("не-месяц", AUG).getTime()).toBe(AUG.getTime());
      expect(parseMonthKey("2026-13", AUG).getTime()).toBe(AUG.getTime());
    });
  });

  describe("перенос по календарю", () => {
    it("сохраняет время суток, меняя только дату", async () => {
      const post = await makePost();
      const at = await reschedulePost(post.id, "2026-08-20");

      const view = await loadCalendar(AUG, AUG);
      const card = view.days.flatMap((d) => d.posts).find((p) => p.id === post.id);
      expect(card?.timeLabel).toBe("10:00");
      expect(at.toISOString()).toBe("2026-08-20T05:00:00.000Z");
    });

    it("опубликованный пост перенести нельзя", async () => {
      // Крон мог опубликовать его между рендером и перетаскиванием: карточка в
      // браузере устаревает молча, поэтому отказ приходит с сервера.
      const post = await makePost({ status: "PUBLISHED" });
      await expect(reschedulePost(post.id, "2026-08-20")).rejects.toThrow(ContentError);
    });

    it("пост из расписания в прошедший день не переносится", async () => {
      // Иначе крон опубликовал бы его на ближайшем тике, и это выглядело бы
      // как «календарь сам отправил пост в канал».
      const post = await makePost({
        status: "SCHEDULED",
        scheduledAt: new Date(Date.now() + 86_400_000),
      });
      await expect(reschedulePost(post.id, "2020-01-01")).rejects.toThrow(/прошло/i);
    });
  });

  describe("правила статусов", () => {
    it("в расписание идёт только одобренный пост", async () => {
      const post = await makePost();
      await expect(schedulePost(post.id, new Date(Date.now() + 86_400_000))).rejects.toThrow(
        /одобренн/i,
      );

      await approvePost(post.id);
      const at = await schedulePost(post.id, new Date(Date.now() + 86_400_000));
      expect(at).toBeInstanceOf(Date);

      const after = await prisma.contentPost.findUniqueOrThrow({ where: { id: post.id } });
      expect(after.status).toBe("SCHEDULED");
    });

    it("пост без текста одобрить нельзя", async () => {
      const post = await makePost({ body: null });
      await expect(approvePost(post.id)).rejects.toThrow(/нет текста/i);
    });

    it("пост, который уже забрал крон, снять с расписания не выйдет", async () => {
      const post = await makePost({ status: "PUBLISHING" });
      await expect(unschedulePost(post.id)).rejects.toThrow(/уходит в канал/i);
    });

    it("постановка в расписание обнуляет счётчик прошлых неудач", async () => {
      const post = await makePost({ status: "APPROVED", publishAttempts: 2, publishError: "было" });
      await schedulePost(post.id, new Date(Date.now() + 86_400_000));

      const after = await prisma.contentPost.findUniqueOrThrow({ where: { id: post.id } });
      expect(after.publishAttempts).toBe(0);
      expect(after.publishError).toBeNull();
    });
  });
});
