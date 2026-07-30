/**
 * Память о владельце: устойчивые факты, которые агент накапливает и использует
 * в каждом разговоре.
 */

export {
  attachEmbedding,
  backfillEmbeddings,
  retireFact,
  saveFact,
  toVectorLiteral,
  type SaveFactInput,
  type SavedFact,
} from "./facts";

export {
  formatFactsForPrompt,
  recallFacts,
  type RecallOptions,
  type RecalledFact,
} from "./search";
