// Tiny in-memory hand-off of the rider's latest GPS fix.
//
// The existing GPS watcher in App.tsx (navigator.geolocation.watchPosition ->
// rider_locations upsert) publishes each fix here, and the delivery map
// subscribes. This way there is only ONE GPS watcher, and App does not
// re-render on every GPS update.
//
// The optional `meta` (accuracy + device timestamp) is kept so the attendance feature can fall back
// to the watcher's most recent fix when a fresh one-shot reading is not available. Attendance never
// publishes into this module, so a check-in/out reading cannot disturb live tracking.

import type { LatLng } from "./routesApi";

type Listener = (pos: LatLng) => void;

export type FixMeta = { accuracy: number; timestamp: number };
export type RiderFix = LatLng & FixMeta;

let last: LatLng | null = null;
let lastMeta: FixMeta | null = null;
const listeners = new Set<Listener>();

export function publishRiderPosition(pos: LatLng, meta?: FixMeta) {
  last = pos;
  lastMeta = meta ?? null;
  listeners.forEach((fn) => fn(pos));
}

/** Subscribes to fixes; immediately replays the latest one if there is one. Returns unsubscribe. */
export function subscribeRiderPosition(fn: Listener): () => void {
  listeners.add(fn);
  if (last) fn(last);
  return () => {
    listeners.delete(fn);
  };
}

/** The watcher's latest fix with its accuracy/timestamp, or null if none (or it carried no metadata). */
export function getLatestRiderFix(): RiderFix | null {
  if (!last || !lastMeta) return null;
  return { ...last, ...lastMeta };
}

export function clearRiderPosition() {
  last = null;
  lastMeta = null;
}
