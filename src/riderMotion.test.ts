import { describe, expect, it } from "vitest";

import { bearingDeg, headingOnPath, lerpAngle, snapToPath, type LatLng } from "./riderMotion";

const O: LatLng = { lat: 29.6339, lng: 73.1445 };
// ~111 m per 0.001° of latitude
const north = (m: number): LatLng => ({ lat: O.lat + m / 110_540, lng: O.lng });
const east = (p: LatLng, m: number): LatLng => ({ lat: p.lat, lng: p.lng + m / (111_320 * Math.cos((p.lat * Math.PI) / 180)) });

describe("bearingDeg", () => {
  it("returns compass directions", () => {
    expect(bearingDeg(O, north(100))).toBeCloseTo(0, 0);
    expect(bearingDeg(O, east(O, 100))).toBeCloseTo(90, 0);
    expect(bearingDeg(north(100), O)).toBeCloseTo(180, 0);
    expect(bearingDeg(east(O, 100), O)).toBeCloseTo(270, 0);
  });
});

describe("snapToPath", () => {
  const path = [O, north(200), east(north(200), 200)]; // north 200 m, then east 200 m

  it("projects an off-road fix onto the nearest road segment", () => {
    const fix = east(north(100), 12); // 12 m east of the northbound road
    const s = snapToPath(fix, path)!;
    expect(s.segIndex).toBe(0);
    expect(s.distance).toBeCloseTo(12, 0);
    expect(s.point.lng).toBeCloseTo(O.lng, 6);
    expect(s.point.lat).toBeCloseTo(north(100).lat, 5);
  });

  it("picks the closer of two segments at a corner", () => {
    const s = snapToPath(east(north(200), 100), path)!;
    expect(s.segIndex).toBe(1);
  });

  it("returns null for a path that is not a line", () => {
    expect(snapToPath(O, [O])).toBeNull();
  });
});

describe("headingOnPath", () => {
  const path = [O, north(200), east(north(200), 200)];

  it("faces along the segment the scooter is on", () => {
    const s = snapToPath(north(50), path)!;
    expect(headingOnPath(path, s)).toBeCloseTo(0, 0);
  });

  it("looks ahead round a corner", () => {
    const s = snapToPath(north(190), path)!; // 10 m before the turn, look-ahead 25 m
    const h = headingOnPath(path, s, 25);
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThan(90);
  });

  it("faces the final stretch when almost at the destination", () => {
    const end = path[path.length - 1];
    const s = snapToPath(east(end, -3), path)!;
    expect(headingOnPath(path, s)).toBeCloseTo(90, 0);
  });
});

describe("lerpAngle", () => {
  it("turns the short way round", () => {
    expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(0, 5);
    expect(lerpAngle(10, 350, 0.5)).toBeCloseTo(0, 5);
    expect(lerpAngle(0, 90, 1)).toBeCloseTo(90, 5);
    expect(lerpAngle(90, 0, 0)).toBeCloseTo(90, 5);
  });
});
