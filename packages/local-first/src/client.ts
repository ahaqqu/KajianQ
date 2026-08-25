export { createLeaderElection, type LeaderApi } from "./leader";
export { startSyncLoop, type SyncLoopDeps, type SyncStatus } from "./sync-loop";
export { requestPersistentStorage } from "./persistence";
export {
  migrateToLatest,
  migrateV1ToV2,
  migrateDownV2ToV1,
  type NotesState,
} from "./migrations";
