// Google Maps JS API setup for the Rider App. Needs VITE_GOOGLE_MAPS_KEY in .env
// (the same key the Customer App uses) with "Maps JavaScript API" and
// "Routes API" enabled. Without the key the delivery map is simply not shown.

import { setOptions } from "@googlemaps/js-api-loader";

export const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined;

// setOptions() may only be called once per page load.
let configured = false;
export function ensureGoogleMapsConfigured() {
  if (configured || !GOOGLE_MAPS_KEY) return;
  setOptions({ key: GOOGLE_MAPS_KEY });
  configured = true;
}
