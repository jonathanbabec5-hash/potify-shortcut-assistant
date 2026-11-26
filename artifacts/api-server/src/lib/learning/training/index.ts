/**
 * Offline training surface.
 *
 * ⚠️  This subtree is offline-only and must never be reachable from the request
 *     path. `training-isolation.test.ts` walks the import graph from `app.ts`
 *     and fails if anything here appears in it.
 *
 * Importing from this barrel is how an offline script gets at batching,
 * benchmarking, and the bounded loop. If you find yourself wanting one of these
 * inside a route handler, the answer is no — that is production inference
 * reaching into training, which is the exact coupling this layer exists to
 * prevent.
 */

export {
  DEFAULT_SELECTION,
  TRAINABLE_SCOPES,
  contentHashOf,
  freezeTrainingBatch,
  markBatchStatus,
  verifyBatchIntegrity,
  type BatchIntegrity,
  type BatchSelection,
  type FrozenBatch,
} from "./batch";

export { AdapterMintError, mintAdapterBlock } from "./adapter-block";

export {
  compareChallenger,
  runBenchmark,
  type BenchmarkArtifacts,
  type BenchmarkResult,
  type CaseResult,
  type CaseRunner,
  type ChallengerComparison,
} from "./benchmark";

export {
  CandidateBuildError,
  DEFAULT_MAX_EXEMPLARS,
  DEFAULT_RETRIEVAL,
  buildCandidate,
  candidateExists,
  persistCandidate,
  renderExemplarBlock,
  type CandidateAdapter,
  type CandidateOptions,
  type CandidateProvenance,
  type Exemplar,
  type ExclusionTally,
  type RetrievalParams,
} from "./candidate";

export {
  CALLER_SUPPLIED_GATES,
  LoopBoundError,
  MAX_ITERATIONS,
  runCycle,
  type CycleInput,
  type CycleResult,
} from "./loop";
