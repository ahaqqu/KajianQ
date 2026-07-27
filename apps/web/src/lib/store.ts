/** @deprecated use notes-store — kept for health greeting seed */
import { SCHEMA_VERSION } from "@app/sync-protocol";

export function getGreeting(): string {
  return "Hello World";
}

export function getSchemaVersion(): number {
  return SCHEMA_VERSION;
}
