// Pure helpers for the live rider marker: heading (which way the scooter
// faces), snapping a GPS fix onto the road route, and smooth angle blending.
// No Google Maps / React imports, so everything here is unit-testable.

export type LatLng = { lat: number; lng: number };

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LNG = 111_320;

/** Initial compass bearing a -> b in degrees, 0 = north, clockwise, range [0, 360). */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/** Flat-earth distance in metres; accurate enough for the few-hundred-metre gaps used here. */
export function distMeters(a: LatLng, b: LatLng): number {
  const dx = (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)) * M_PER_DEG_LNG;
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

export type Snap = {
  /** Closest point on the route. */
  point: LatLng;
  /** Index of the segment (path[i] -> path[i + 1]) the point lies on. */
  segIndex: number;
  /** How far the original fix was from the route, in metres. */
  distance: number;
};

/** Closest point on a polyline to `p`. Returns null for a path with fewer than 2 points. */
export function snapToPath(p: LatLng, path: LatLng[]): Snap | null {
  if (path.length < 2) return null;
  const cosLat = Math.cos(p.lat * (Math.PI / 180));
  // Project to local metres around p (x east, y north).
  const toXY = (q: LatLng) => ({ x: (q.lng - p.lng) * cosLat * M_PER_DEG_LNG, y: (q.lat - p.lat) * M_PER_DEG_LAT });
  let best: Snap | null = null;
  let prev = toXY(path[0]);
  for (let i = 0; i < path.length - 1; i++) {
    const a = prev;
    const b = toXY(path[i + 1]);
    prev = b;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len2));
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    const d = Math.hypot(cx, cy);
    if (!best || d < best.distance) {
      best = {
        distance: d,
        segIndex: i,
        point: {
          lat: path[i].lat + t * (path[i + 1].lat - path[i].lat),
          lng: path[i].lng + t * (path[i + 1].lng - path[i].lng),
        },
      };
    }
  }
  return best;
}

/**
 * Direction of travel along the route at a snapped point: bearing from the
 * point to a spot `lookAheadM` metres further along the road. Looking ahead
 * (instead of using the raw segment) keeps the scooter from twitching on the
 * tiny zig-zag segments of a curved road.
 */
export function headingOnPath(path: LatLng[], snap: Pick<Snap, "point" | "segIndex">, lookAheadM = 25): number {
  let from = snap.point;
  let remaining = lookAheadM;
  for (let i = snap.segIndex + 1; i < path.length; i++) {
    const next = path[i];
    const seg = distMeters(from, next);
    if (seg >= remaining && seg > 0) {
      const f = remaining / seg;
      const target = { lat: from.lat + f * (next.lat - from.lat), lng: from.lng + f * (next.lng - from.lng) };
      return bearingDeg(snap.point, target);
    }
    remaining -= seg;
    from = next;
  }
  // Fewer than lookAheadM left (arriving): face the last stretch of road.
  const last = path[path.length - 1];
  if (distMeters(snap.point, last) > 1) return bearingDeg(snap.point, last);
  const before = path[path.length - 2];
  return bearingDeg(before, last);
}

/** Blend angle a -> b along the shortest way round (so 350° -> 10° turns 20°, not 340°). */
export function lerpAngle(a: number, b: number, t: number): number {
  const diff = ((((b - a) % 360) + 540) % 360) - 180;
  return (a + diff * t + 360) % 360;
}
