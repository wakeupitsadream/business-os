import type { KitchenId, LoadSnapshot } from "../types";
import type { KitchenLoadSource } from "./contract";

/**
 * Демо-источник загрузки: те же два числа, но из памяти.
 *
 * Нужен на трёх этапах сразу — показать демо владельцу до интеграции,
 * гонять тесты диспетчера и работать запасным вариантом, пока боевой источник
 * недоступен. Поэтому это не «времянка до iiko», а полноправная реализация
 * контракта.
 *
 * Время снятия среза задаётся снаружи (`now`), а не берётся из `Date.now()`:
 * иначе протухание невозможно проверить тестом, не подменяя системные часы.
 */
export class MockKitchenLoadSource implements KitchenLoadSource {
  readonly name = "Демо-данные";

  #snapshots: Map<KitchenId, LoadSnapshot>;
  #stopList: Set<string>;

  constructor(args: {
    snapshots: readonly LoadSnapshot[];
    stopList?: readonly string[];
  }) {
    this.#snapshots = new Map(args.snapshots.map((s) => [s.kitchenId, s]));
    this.#stopList = new Set(args.stopList ?? []);
  }

  async loadSnapshots(): Promise<readonly LoadSnapshot[]> {
    return [...this.#snapshots.values()];
  }

  async stopList(): Promise<ReadonlySet<string>> {
    return new Set(this.#stopList);
  }

  /** Ручное изменение загрузки — этим живёт интерактив в демо. */
  set(snapshot: LoadSnapshot): void {
    this.#snapshots.set(snapshot.kitchenId, snapshot);
  }
}
