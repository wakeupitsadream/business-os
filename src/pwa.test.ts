import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Установка на телефон.
 *
 * Браузер считает приложение устанавливаемым по формальным признакам, и любой
 * из них легко потерять незаметно: манифест с пустым списком иконок выглядит
 * совершенно нормально, пока не попробуешь установить. Здесь они закреплены.
 */

const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8")) as {
  name: string;
  short_name: string;
  start_url: string;
  display: string;
  icons: Array<{ src: string; sizes: string; purpose?: string }>;
};

const sw = readFileSync("public/sw.js", "utf8");

describe("манифест", () => {
  it("несёт всё, что требует установка", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  it("иконки 192 и 512 на месте", () => {
    // Именно этих двух размеров требует установка; без них манифест выглядит
    // исправным, но кнопка «установить» не появляется.
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });

  it("есть maskable-иконка, иначе Android обрежет её как попало", () => {
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("файлы иконок действительно существуют", () => {
    for (const icon of manifest.icons) {
      expect(() => readFileSync(`public${icon.src}`), icon.src).not.toThrow();
    }
  });
});

describe("service worker не кэширует данные", () => {
  it("есть обработчик fetch — без него установка невозможна", () => {
    expect(sw).toContain('addEventListener("fetch"');
  });

  it("api исключён из кэша явно", () => {
    // Кэшированный остаток счёта выглядит как настоящий. Это главное правило
    // всего файла, и оно должно быть видно проверкой, а не только глазами.
    expect(sw).toContain('url.pathname.startsWith("/api/")');
  });

  it("оффлайн ведёт на честную страницу, а не на старые цифры", () => {
    // Проверка по смыслу, а не по расстановке переносов: форматтер иначе
    // сломает тест, ничего не изменив по существу.
    expect(sw).toMatch(/match\(\s*"\/offline"\s*\)/);
    expect(sw).toContain('request.mode === "navigate"');
  });
});
