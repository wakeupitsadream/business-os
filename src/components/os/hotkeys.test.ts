import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Горячие клавиши.
 *
 * Проверяется не поведение React (для этого нужен браузер), а те решения,
 * которые легко потерять при правке и которые дорого обходятся: перехват
 * клавиш во время набора текста и воровство системных сочетаний.
 */

const source = readFileSync("src/components/os/hotkeys.tsx", "utf8");

describe("клавиши не мешают работать", () => {
  it("во время набора текста цифры не перехватываются", () => {
    // Иначе цифра в поле суммы уводила бы владельца на другой экран посреди
    // ввода — и он бы решил, что приложение живёт своей жизнью.
    expect(source).toContain("isTyping");
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(source, tag).toContain(tag);
    }
    expect(source).toContain("isContentEditable");
  });

  it("сочетания с модификаторами отдаются браузеру", () => {
    // Cmd+1 переключает вкладку. Перехватывать это — воровать привычное.
    expect(source).toMatch(/metaKey\s*\|\|\s*e\.ctrlKey\s*\|\|\s*e\.altKey/);
  });

  it("внутри диалога клавиатура не трогается", () => {
    expect(source).toContain('closest("[role=dialog]")');
  });
});

describe("набор клавиш", () => {
  it("покрывает все отделы", () => {
    for (const path of ["/secretary", "/finance", "/sales", "/settings"]) {
      expect(source, path).toContain(`"${path}"`);
    }
  });

  it("нет хоткеев на действия — только навигация", () => {
    // Действия у владельца редкие и осознанные, а случайное нажатие в
    // необратимом действии дороже сэкономленной секунды.
    expect(source).not.toMatch(/fetch\(|method:\s*"POST"/);
  });
});
