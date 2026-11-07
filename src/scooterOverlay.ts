// The live rider "vehicle" on the map: a top-down scooter picture that sits
// directly on the road line and rotates to face the direction of travel, like
// the car icon in Google Maps navigation. It is NOT a pin/marker — it is a
// small custom overlay (google.maps.OverlayView) with an inline SVG, so it
// rotates freely with CSS and needs no Map ID.
//
// The SVG is drawn with its nose pointing UP (north); `heading` is the compass
// bearing in degrees, so rotate(heading) points it the right way.

import type { LatLng } from "./riderMotion";

const W = 34;
const H = 56;

const SCOOTER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 56" width="${W}" height="${H}" aria-hidden="true">
  <!-- soft ground shadow -->
  <ellipse cx="17" cy="30" rx="12" ry="22" fill="#000" opacity=".18"/>
  <!-- rear wheel -->
  <rect x="13.5" y="40" width="7" height="14" rx="3.5" fill="#1f2937"/>
  <!-- front wheel -->
  <rect x="13.5" y="2" width="7" height="12" rx="3.5" fill="#1f2937"/>
  <!-- body / floorboard -->
  <path d="M10 18 C10 14 13 12 17 12 C21 12 24 14 24 18 L25 36 C25 41 21.5 45 17 45 C12.5 45 9 41 9 36 Z" fill="#e11d48" stroke="#fff" stroke-width="1.6"/>
  <!-- headlight -->
  <rect x="14.5" y="8" width="5" height="3" rx="1.5" fill="#fde68a" stroke="#fff" stroke-width=".8"/>
  <!-- handlebar -->
  <rect x="3" y="15" width="28" height="3.4" rx="1.7" fill="#111827" stroke="#fff" stroke-width=".8"/>
  <!-- seat -->
  <ellipse cx="17" cy="35" rx="5.5" ry="7" fill="#111827"/>
  <!-- rider: shoulders + arms to the handlebar, helmet on top -->
  <path d="M10.5 18.5 L12.5 28 C13 30 21 30 21.5 28 L23.5 18.5" fill="none" stroke="#fbbf24" stroke-width="3" stroke-linecap="round"/>
  <ellipse cx="17" cy="28" rx="6.5" ry="4.6" fill="#fbbf24" stroke="#fff" stroke-width=".8"/>
  <circle cx="17" cy="27.5" r="4.4" fill="#111827" stroke="#fff" stroke-width=".8"/>
</svg>`;

export type ScooterOverlay = {
  /** Move the scooter to `pos` and turn it to compass `heading` (degrees, 0 = north). */
  setPose(pos: LatLng, heading: number): void;
  getPosition(): google.maps.LatLng | null;
  remove(): void;
};

/**
 * Must be called after the Maps JS API has loaded (`importLibrary("maps")`),
 * because the overlay class extends google.maps.OverlayView.
 */
export function createScooterOverlay(map: google.maps.Map, pos: LatLng, heading: number): ScooterOverlay {
  class Overlay extends google.maps.OverlayView {
    private root: HTMLDivElement | null = null;
    private pic: HTMLDivElement | null = null;
    private latLng = new google.maps.LatLng(pos.lat, pos.lng);
    private angle = heading;

    onAdd() {
      const root = document.createElement("div");
      root.style.cssText = `position:absolute;width:${W}px;height:${H}px;pointer-events:none;will-change:transform;`;
      const pic = document.createElement("div");
      pic.style.cssText = `width:${W}px;height:${H}px;transform-origin:50% 50%;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35));`;
      pic.innerHTML = SCOOTER_SVG;
      root.appendChild(pic);
      this.root = root;
      this.pic = pic;
      this.getPanes()?.overlayMouseTarget.appendChild(root); // above the route line
      this.paint();
    }

    draw() {
      this.paint();
    }

    onRemove() {
      this.root?.remove();
      this.root = null;
      this.pic = null;
    }

    pose(p: LatLng, h: number) {
      this.latLng = new google.maps.LatLng(p.lat, p.lng);
      this.angle = h;
      this.paint();
    }

    position() {
      return this.latLng;
    }

    private paint() {
      const proj = this.getProjection();
      if (!proj || !this.root || !this.pic) return;
      const px = proj.fromLatLngToDivPixel(this.latLng);
      if (!px) return;
      // Centre of the picture sits exactly on the road point.
      this.root.style.left = `${px.x - W / 2}px`;
      this.root.style.top = `${px.y - H / 2}px`;
      this.pic.style.transform = `rotate(${this.angle}deg)`;
    }
  }

  const overlay = new Overlay();
  overlay.setMap(map);
  return {
    setPose: (p, h) => overlay.pose(p, h),
    getPosition: () => overlay.position(),
    remove: () => overlay.setMap(null),
  };
}
