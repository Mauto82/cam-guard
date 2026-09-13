export type {
  ActionAdapters,
  ActionSpec,
  ActionType,
  Box,
  Detection,
  Detector,
  EncodedImage,
  Frame,
  ImageMime,
  Source,
  Subject,
} from "./types.js";

export { parseDuration } from "./policy/duration.js";
export {
  loadPolicyConfig,
  parsePolicyConfig,
  policyConfigSchema,
  PolicyConfigError,
  ruleFrames,
  unknownLabels,
  type PolicyConfig,
  type PolicyConfigInput,
  type Rule,
} from "./policy/config.js";
export {
  PolicyEngine,
  type Decision,
  type DecisionLevel,
  type RuleCounters,
  type UserState,
} from "./policy/engine.js";

export { Scheduler, type SchedulerOptions } from "./scheduler.js";

export {
  EvidenceStore,
  type ActionOutcome,
  type ActionResult,
  type EvidenceFilter,
  type EvidenceFrame,
  type EvidenceFrameMeta,
  type EvidenceRecord,
  type EvidenceStoreOptions,
  type ReviewStatus,
} from "./evidence.js";

export { TypedEmitter } from "./events.js";
export {
  CamGuard,
  type ActionEvent,
  type CamGuardEvents,
  type CamGuardOptions,
  type DetectionEvent,
  type GuardMode,
  type ReportEvent,
  type WatchEvent,
} from "./guard.js";
