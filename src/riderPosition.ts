// Tiny in-memory hand-off of the rider's latest GPS fix.
//
// The existing GPS watcher in App.tsx (navigator.geolocation.watchPosition ->
// rider_locations upsert) publishes each fix here, and the delivery map
// subscribes. This way there is only ONE GPS watcher, and App does not
// re-render on every GPS update.

import type { LatLng } from "./routesApi";

type Listener = (pos: LatLng) => void;

let last: LatLng | null = null;
const listeners = new Set<Listener>();

export function publishRiderPosition(pos: LatLng) {
  last = pos;
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

export function clearRiderPosition() {
  last = null;
}
