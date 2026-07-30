/**
 * Server-bias clock discipline. The sync response carries `serverNow`; the
 * client keeps `clockFloor = max(local now, serverNow)` and never stamps a
 * future `updatedAt` below that floor — so a slow local clock cannot stamp
 * updates in the past and silently lose every LWW merge.
 */

/** Raise the stored floor after observing the server clock. */
export function raiseClockFloor(
  current: number | undefined,
  serverNow: number,
  localNow = Date.now(),
): number {
  return Math.max(current ?? 0, serverNow, localNow);
}

/** Stamp for a new local write: local now, never below the floor. */
export function stampNow(floor: number | undefined, localNow = Date.now()): number {
  return Math.max(localNow, floor ?? 0);
}
