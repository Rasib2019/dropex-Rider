// Dynamic "rider -> drop-off" road route, shared logic (same file lives in the
// Customer App and the Rider App).
//
// - Uses the Google Routes API (REST) with the existing VITE_GOOGLE_MAPS_KEY.
// - The rider MARKER is moved by the caller on every GPS/Realtime update.
//   This module only decides WHEN the road route is worth recalculating:
//   only after the rider has moved >= MIN_MOVE_METERS since the last successful
//   route calculation (so GPS jitter never costs an API call).
// - Only the latest response is ever applied (request counter + AbortController),
//   so a slow old response can never overwrite a newer route.

export type LatLng = { lat: number; lng: number };

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined;
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";

/** Rider must move at least this far (metres) before the route is recalculated. */
export const MIN_MOVE_METERS = 40;
/** After a failed Routes API call, wait this long before trying again. */
const RETRY_AFTER_ERROR_MS = 15_000;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Decodes a Google encoded polyline (precision 5). */
export function decodePolyline(encoded: string): LatLng[] {
  const out: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of ["lat", "lng"] as const) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === "lat") lat += delta;
      else lng += delta;
    }
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}

/** One Routes API call: road route origin -> destination as a list of points. */
export async function computeRoute(origin: LatLng, destination: LatLng, signal?: AbortSignal): Promise<LatLng[]> {
  if (!GOOGLE_MAPS_KEY) throw new Error("Google Maps key missing");
  const res = await fetch(ROUTES_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_MAPS_KEY,
      // Ask only for the polyline -> cheapest field set.
      "X-Goog-FieldMask": "routes.polyline.encodedPolyline",
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
      destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE", // basic (cheapest) SKU; no traffic-aware surcharge
      polylineQuality: "OVERVIEW",
    }),
  });
  if (!res.ok) throw new Error(`Routes API ${res.status}`);
  const json = (await res.json()) as { routes?: Array<{ polyline?: { encodedPolyline?: string } }> };
  const encoded = json.routes?.[0]?.polyline?.encodedPolyline;
  if (!encoded) throw new Error("Routes API returned no route");
  const path = decodePolyline(encoded);
  if (path.length < 2) throw new Error("Routes API returned an empty route");
  return path;
}

/**
 * Feed every rider position into `update()`. It calls `onRoute` only when a
 * (re)calculation was really needed and succeeded, with the newest result only.
 */
export function createRouteTracker(opts: {
  destination: LatLng;
  onRoute: (path: LatLng[]) => void;
  /** Called when a route request fails (caller keeps showing the old route). */
  onError?: (err: unknown) => void;
  minMoveMeters?: number;
}) {
  const minMove = opts.minMoveMeters ?? MIN_MOVE_METERS;
  let lastRoutedFrom: LatLng | null = null; // rider position used for the last successful route
  let latest: LatLng | null = null; // newest known rider position
  let requestId = 0; // version counter: only the newest request may apply its result
  let controller: AbortController | null = null;
  let inFlight = false;
  let retryNotBefore = 0;
  let disposed = false;

  async function run(from: LatLng) {
    const myId = ++requestId;
    controller?.abort();
    controller = new AbortController();
    inFlight = true;
    try {
      const path = await computeRoute(from, opts.destination, controller.signal);
      if (disposed || myId !== requestId) return; // stale response -> ignore
      lastRoutedFrom = from;
      opts.onRoute(path);
    } catch (err) {
      if (disposed || myId !== requestId) return; // aborted / superseded -> not an error
      retryNotBefore = Date.now() + RETRY_AFTER_ERROR_MS;
      opts.onError?.(err);
    } finally {
      if (myId === requestId) {
        inFlight = false;
        // Rider kept moving while we waited? Re-check against the newest position.
        if (!disposed && latest) maybeRoute();
      }
    }
  }

  function maybeRoute() {
    if (disposed || inFlight || !latest) return;
    if (Date.now() < retryNotBefore) return;
    if (lastRoutedFrom && haversineMeters(lastRoutedFrom, latest) < minMove) return;
    void run(latest);
  }

  return {
    update(pos: LatLng) {
      latest = pos;
      maybeRoute();
    },
    dispose() {
      disposed = true;
      controller?.abort();
    },
  };
}
