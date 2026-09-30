import { importLibrary } from "@googlemaps/js-api-loader";
import { useEffect, useRef, useState } from "react";

import { ensureGoogleMapsConfigured, GOOGLE_MAPS_KEY } from "./googleMaps";
import { subscribeRiderPosition } from "./riderPosition";
import { createRouteTracker, type LatLng } from "./routesApi";

/**
 * Rider's live delivery map (shown on an order while it is "on the way"):
 * 🛵 rider's current position, 📍 customer drop-off, and the Google road route
 * Rider -> Drop-off.
 *
 * - Position comes from the existing GPS watcher (riderPosition.ts) — no second watcher.
 * - The marker moves on every GPS fix; the road route is only recalculated
 *   (Routes API) after ~40 m of movement, and only the newest response is drawn.
 * - Zoom/pan is never reset: bounds are fitted once (first route). The map
 *   softly follows the rider (only pans when the rider nears the screen edge);
 *   dragging the map pauses following until "Re-center" is tapped.
 */
export function DeliveryMap({ drop }: { drop: LatLng }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const riderPosRef = useRef<LatLng | null>(null);
  const followRef = useRef(true);
  const [hasFix, setHasFix] = useState(false);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    if (!GOOGLE_MAPS_KEY || !containerRef.current) return;
    ensureGoogleMapsConfigured();
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let tracker: ReturnType<typeof createRouteTracker> | null = null;
    let riderMarker: google.maps.Marker | null = null;
    let dropMarker: google.maps.Marker | null = null;
    let line: google.maps.Polyline | null = null;

    (async () => {
      const [{ Map }, { Marker }, { Polyline }, { LatLngBounds }] = await Promise.all([
        importLibrary("maps"),
        importLibrary("marker"),
        importLibrary("maps"),
        importLibrary("core"),
      ]);
      if (cancelled || !containerRef.current) return;

      const map = new Map(containerRef.current, {
        center: drop,
        zoom: 15,
        disableDefaultUI: true,
        zoomControl: true,
      });
      mapRef.current = map;
      dropMarker = new Marker({ map, position: drop, label: { text: "📍", fontSize: "20px" }, title: "Drop-off" });

      // Manual drag = the rider wants to look around; stop auto-following.
      map.addListener("dragstart", () => {
        followRef.current = false;
        setFollowing(false);
      });

      let fitted = false;

      function draw(path: LatLng[]) {
        if (cancelled) return;
        if (!line) line = new Polyline({ map, path, strokeColor: "#e11d48", strokeOpacity: 0.9, strokeWeight: 5 });
        else line.setPath(path); // replace, never stack
      }

      tracker = createRouteTracker({
        destination: drop,
        onRoute: (path) => {
          draw(path);
          if (!fitted) {
            fitted = true; // fit once only
            const bounds = new LatLngBounds();
            path.forEach((pt) => bounds.extend(pt));
            map.fitBounds(bounds, 40);
          }
        },
        onError: () => {
          // Routes API failed: keep the marker live; straight line only if no route exists yet.
          const rider = riderPosRef.current;
          if (!line && rider) draw([rider, drop]);
        },
      });

      unsubscribe = subscribeRiderPosition((pos) => {
        if (cancelled) return;
        riderPosRef.current = pos;
        setHasFix(true);
        if (!riderMarker) {
          riderMarker = new Marker({ map, position: pos, label: { text: "🛵", fontSize: "20px" }, title: "You" });
        } else {
          riderMarker.setPosition(pos);
        }
        // Soft follow: only pan when the rider is close to the edge of the visible map.
        const b = map.getBounds();
        if (followRef.current && b && fitted) {
          const ne = b.getNorthEast();
          const sw = b.getSouthWest();
          const padLat = (ne.lat() - sw.lat()) * 0.2;
          const padLng = (ne.lng() - sw.lng()) * 0.2;
          const inside =
            pos.lat > sw.lat() + padLat &&
            pos.lat < ne.lat() - padLat &&
            pos.lng > sw.lng() + padLng &&
            pos.lng < ne.lng() - padLng;
          if (!inside) map.panTo(pos);
        }
        tracker?.update(pos); // decides itself whether ~40 m of movement justifies a new route
      });
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      tracker?.dispose();
      line?.setMap(null);
      riderMarker?.setMap(null);
      dropMarker?.setMap(null);
      mapRef.current = null;
    };
  }, [drop.lat, drop.lng]);

  if (!GOOGLE_MAPS_KEY) return null; // no key configured: the existing "Open in Maps" links still work

  function recenter() {
    followRef.current = true;
    setFollowing(true);
    if (riderPosRef.current) mapRef.current?.panTo(riderPosRef.current);
  }

  return (
    <div className="delivery-map-wrap">
      <div ref={containerRef} className="delivery-map" />
      <div className="delivery-map-badge">{hasFix ? "🟢 Live route to drop-off" : "Waiting for GPS…"}</div>
      {!following ? (
        <button type="button" className="delivery-map-recenter" onClick={recenter}>
          Re-center
        </button>
      ) : null}
    </div>
  );
}
