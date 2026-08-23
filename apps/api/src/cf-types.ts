/** Minimal CF types so root tsc works without global workers types. */
import type { R2Like } from "@app/infra";

/** Canonical R2 bucket shape lives in @app/infra (object-store adapter). */
export type R2Bucket = R2Like;
