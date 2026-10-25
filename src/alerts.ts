// New-order alerts: sound + (optional) system notification.
// Note: these work while the app is open or in the background of the browser/PWA.
// Alerts when the app is fully closed need server-side Web Push (not included here).

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx) ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

/** Browsers only allow audio after a user gesture — call this from a tap/click handler. */
export function unlockAudio(): void {
  const c = getCtx();
  if (c && c.state === "suspended") void c.resume().catch(() => undefined);
}

/** Three short rising beeps. Silent (no throw) if audio is unavailable or still locked. */
export function playNewOrderSound(): void {
  const c = getCtx();
  if (!c || c.state !== "running") return;
  const start = c.currentTime + 0.02;
  [880, 1100, 1320].forEach((freq, i) => {
    const t = start + i * 0.22;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  });
}

export type AlertPermission = NotificationPermission | "unsupported";

export function alertPermission(): AlertPermission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Must be called from a tap/click. Also unlocks sound and plays a test beep. */
export async function enableAlerts(): Promise<AlertPermission> {
  unlockAudio();
  playNewOrderSound();
  if (typeof Notification === "undefined") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export async function showNewOrderNotification(): Promise<void> {
  if (alertPermission() !== "granted") return;
  const title = "New DropEx order";
  const options: NotificationOptions = {
    body: "A new order was assigned to you. Open the app to accept it.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: "dropex-new-order",
  };
  try {
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg) await reg.showNotification(title, { ...options, requireInteraction: true } as NotificationOptions);
    else new Notification(title, options);
  } catch {
    /* notifications are best-effort */
  }
}
