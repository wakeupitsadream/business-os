import { defineConfig } from "vitest/config";

/**
 * Отдельный конфиг: тесты витрин НЕ должны попадать в прогон business-os.
 *
 * Корневой vitest берёт только `src/**` от корня репозитория, поэтому эти
 * файлы туда не попадают сами по себе. Конфиг нужен, чтобы их можно было
 * запустить отдельной командой, не поднимая второй node_modules: движок
 * намеренно написан без зависимостей.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
  },
});
