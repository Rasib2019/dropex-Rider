// Shift + attendance: API calls, GPS snapshot, formatting and React hooks.
//
// All business rules (which shift, late/present, geofence, duplicates, dates) are enforced by the
// Supabase RPCs in supabase/rider_attendance.sql. The app never sends a rider id and never writes to
// a table; it only shows what the server returns.

import { useCallback, useEffect, useRef, useState } from "react";

import { supabase } from "./supabaseClient";
import { getLatestRiderFix } from "./riderPosition";

export const BUSINESS_TZ = "Asia/Karachi";

// ---------------------------------------------------------------------------
// Types (shape of the JSON returned by the RPCs)
// ---------------------------------------------------------------------------

export type AttendanceStatus = "present" | "late" | "absent" | "leave" | "incomplete" | "manual_override";

export type AttendanceRecord = {
  id: string;
  status: AttendanceStatus;
  check_in_at: string | null;
  check_out_at: string | null;
  late_minutes: number;
  working_minutes: number | null;
};

export type ShiftInfo = {
  id: string;
  name: string;
  start_at: string;
  end_at: string;
  state: "upcoming" | "in_progress" | "ended";
  active: boolean;
  grace_minutes: number;
  geofence_policy: "off" | "warn" | "block";
  location_name: string | null;
  location_radius_m: number | null;
};

export type TodayShift = {
  server_now: string;
  timezone: string;
  work_date: string;
  has_shift: boolean;
  shift?: ShiftInfo;
  check_in_opens_at?: string;
  window_state?: "upcoming" | "open" | "ended";
  attendance?: AttendanceRecord | null;
  can_check_in: boolean;
  can_check_out: boolean;
  max_accuracy_meters: number;
  message: string | null;
};

export type HistoryRow = {
  id: string | null;
  date: string;
  shift_name: string;
  shift_start_at: string;
  shift_end_at: string;
  check_in_at: string | null;
  check_out_at: string | null;
  status: AttendanceStatus;
  late_minutes: number;
  working_minutes: number | null;
  derived: boolean;
};

export type MonthlySummary = {
  month: string;
  scheduled_days: number;
  present_days: number;
  late_days: number;
  absent_days: number;
  leave_days: number;
  completed_shifts: number;
  attendance_percentage: number | null;
  total_working_minutes: number;
  total_late_minutes: number;
};

type ActionResult = { ok: boolean; warning: string | null; context: TodayShift };

// ---------------------------------------------------------------------------
// Errors and messages
// ---------------------------------------------------------------------------

export const MSG_OFFLINE = "Internet connection required for attendance.";
export const MSG_PERMISSION = "Location permission is required to check in.";

export class AttendanceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Codes raised by the SQL functions (error.hint). Their messages are written for riders.
const SERVER_CODES = new Set([
  "no_shift",
  "already_checked_in",
  "already_checked_out",
  "not_checked_in",
  "outside_geofence",
  "invalid_shift",
  "too_early",
  "shift_ended",
  "attendance_locked",
  "poor_accuracy",
  "invalid_location",
  "invalid_range",
  "forbidden",
]);

function isNetworkMessage(msg: string): boolean {
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(msg);
}

async function attendanceRpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new AttendanceError("offline", MSG_OFFLINE);
  }
  let res;
  try {
    res = await supabase.rpc(name, args);
  } catch (e) {
    throw new AttendanceError("network", e instanceof Error && !isNetworkMessage(e.message) ? e.message : MSG_OFFLINE);
  }
  const { data, error } = res;
  if (error) {
    if (isNetworkMessage(error.message)) throw new AttendanceError("network", MSG_OFFLINE);
    if (error.hint && SERVER_CODES.has(error.hint)) throw new AttendanceError(error.hint, error.message);
    if (error.code === "42883" || error.code === "PGRST202") {
      throw new AttendanceError("not_installed", "Attendance is not set up yet. Please contact the DropEx office.");
    }
    // Messages raised by the rider guard (e.g. "Your account is not active") are fine to show.
    if (error.code === "P0001") throw new AttendanceError("error", error.message);
    // eslint-disable-next-line no-console
    console.error(`Attendance RPC ${name} failed:`, error);
    throw new AttendanceError("error", "Attendance is not available right now. Please try again.");
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// GPS snapshot taken at the moment of check-in / check-out
// ---------------------------------------------------------------------------

export type GpsSnapshot = { latitude: number; longitude: number; accuracy: number; timestamp: number };

function readPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 0, // always a fresh reading, never a cached one
    });
  });
}

/**
 * One-shot, high-accuracy reading (a few retries while the GPS settles). It is NOT a second tracker:
 * it never subscribes to anything and never touches the live-tracking watcher or rider_locations.
 * If a fresh reading cannot be obtained, the live watcher's very recent fix may be used instead.
 */
export async function captureGpsSnapshot(maxAccuracy: number, action: "check in" | "check out"): Promise<GpsSnapshot> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    throw new AttendanceError("gps_unavailable", "Location is not available on this device.");
  }

  let best: GpsSnapshot | null = null;
  let lastErr: GeolocationPositionError | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const pos = await readPosition();
      const snap = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp,
      };
      if (!best || snap.accuracy < best.accuracy) best = snap;
      if (best.accuracy <= maxAccuracy) break;
    } catch (e) {
      lastErr = e as GeolocationPositionError;
      if (lastErr.code === 1) {
        throw new AttendanceError("permission_denied", `Location permission is required to ${action}.`);
      }
    }
  }

  if (!best) {
    // Fresh reading failed (timeout / unavailable): use the live watcher's fix only if it is very recent.
    const live = getLatestRiderFix();
    if (live && Date.now() - live.timestamp < 15000 && live.accuracy <= maxAccuracy) {
      best = { latitude: live.lat, longitude: live.lng, accuracy: live.accuracy, timestamp: live.timestamp };
    }
  }

  if (!best) {
    if (lastErr?.code === 3) {
      throw new AttendanceError("gps_timeout", "Could not get your location in time. Please try again.");
    }
    throw new AttendanceError("gps_unavailable", "Your location is unavailable. Turn on GPS and try again.");
  }
  if (best.accuracy > maxAccuracy) {
    throw new AttendanceError(
      "poor_accuracy",
      `GPS signal is weak (accuracy ${Math.round(best.accuracy)} m). Move to an open area and try again.`,
    );
  }
  return best;
}

// ---------------------------------------------------------------------------
// Formatting (always Asia/Karachi, never the device's own timezone)
// ---------------------------------------------------------------------------

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: BUSINESS_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/** "2026-10-04" (a Karachi calendar date) or an ISO timestamp -> "Sun, 04 Oct". */
export function fmtDate(value: string | null | undefined, withYear = false): string {
  if (!value) return "—";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  return d.toLocaleDateString("en-GB", {
    timeZone: /^\d{4}-\d{2}-\d{2}$/.test(value) ? "UTC" : BUSINESS_TZ,
    weekday: "short",
    day: "2-digit",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

export function fmtDuration(minutes: number | null | undefined): string {
  if (minutes == null) return "—";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

export const STATUS_LABEL: Record<string, string> = {
  present: "Present",
  late: "Late",
  absent: "Absent",
  leave: "Leave",
  incomplete: "Incomplete",
  manual_override: "Manual override",
};

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export type AttendancePhase = "idle" | "locating" | "submitting";

export type AttendanceController = {
  data: TodayShift | null;
  loading: boolean;
  loadError: string | null;
  online: boolean;
  phase: AttendancePhase;
  actionError: string | null;
  warning: string | null;
  success: string | null;
  /** Bumps whenever attendance changed, so dependent lists know to reload. */
  version: number;
  refresh: () => Promise<void>;
  checkIn: () => Promise<void>;
  checkOut: () => Promise<void>;
};

const POLL_MS = 30000;

export function useAttendance(active: boolean): AttendanceController {
  const [data, setData] = useState<TodayShift | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [phase, setPhase] = useState<AttendancePhase>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  // Synchronous lock: a second tap (or a refresh) can never overlap an in-flight check-in/out.
  const busy = useRef(false);
  const dataRef = useRef<TodayShift | null>(null);
  dataRef.current = data;
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    try {
      const res = await attendanceRpc<TodayShift>("rider_today_shift");
      if (busy.current) return; // an action started meanwhile; its result is newer
      setData(res);
      setLoadError(null);
    } catch (e) {
      if (!dataRef.current) setLoadError(e instanceof Error ? e.message : "Could not load your shift.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Load and keep fresh while the rider is signed in on the home screen.
  useEffect(() => {
    if (!active) {
      // Signed out / left the app: never keep one rider's attendance around for the next login.
      setData(null);
      setLoadError(null);
      setActionError(null);
      setWarning(null);
      setSuccess(null);
      return;
    }
    setLoading(dataRef.current === null);
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onOnline = () => {
      setOnline(true);
      void refresh();
    };
    const onOffline = () => setOnline(false);
    const poll = window.setInterval(onVisible, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [active, refresh]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const run = useCallback(
    async (kind: "in" | "out") => {
      if (busy.current) return;
      busy.current = true;
      setActionError(null);
      setWarning(null);
      setSuccess(null);
      window.clearTimeout(timer.current);
      let resync = false;
      try {
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          throw new AttendanceError("offline", MSG_OFFLINE);
        }
        const maxAcc = dataRef.current?.max_accuracy_meters ?? 100;
        setPhase("locating");
        const fix = await captureGpsSnapshot(maxAcc, kind === "in" ? "check in" : "check out");
        setPhase("submitting");
        const res = await attendanceRpc<ActionResult>(kind === "in" ? "rider_check_in" : "rider_check_out", {
          p_latitude: fix.latitude,
          p_longitude: fix.longitude,
          p_accuracy: fix.accuracy,
          p_fix_at: new Date(fix.timestamp).toISOString(),
        });
        setData(res.context);
        setWarning(res.warning);
        const rec = res.context.attendance;
        setSuccess(
          kind === "in"
            ? `Checked in at ${fmtTime(rec?.check_in_at)}${rec?.status === "late" ? ` — late by ${rec.late_minutes} min` : ""}.`
            : `Checked out at ${fmtTime(rec?.check_out_at)}. Worked ${fmtDuration(rec?.working_minutes)}.`,
        );
        setVersion((v) => v + 1);
        timer.current = window.setTimeout(() => setSuccess(null), 8000);
      } catch (e) {
        const err = e instanceof AttendanceError ? e : new AttendanceError("error", "Something went wrong. Please try again.");
        setActionError(err.message);
        // A lost connection may have lost only the reply: re-read the truth from the server.
        resync = err.code === "network" || ["already_checked_in", "already_checked_out", "not_checked_in", "attendance_locked", "no_shift", "invalid_shift", "too_early", "shift_ended"].includes(err.code);
      } finally {
        setPhase("idle");
        busy.current = false;
      }
      if (resync) {
        await refresh();
        setVersion((v) => v + 1);
      }
    },
    [refresh],
  );

  const checkIn = useCallback(() => run("in"), [run]);
  const checkOut = useCallback(() => run("out"), [run]);

  return { data, loading, loadError, online, phase, actionError, warning, success, version, refresh, checkIn, checkOut };
}

export type AttendanceHistoryState = {
  rows: HistoryRow[];
  summary: MonthlySummary | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
};

/** The rider's last 30 days plus this month's summary. Reloads when the tab is shown or `version` changes; cleared on sign-out. */
export function useAttendanceHistory(signedIn: boolean, visible: boolean, version: number): AttendanceHistoryState {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [summary, setSummary] = useState<MonthlySummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const [list, sum] = await Promise.all([
        attendanceRpc<HistoryRow[]>("rider_my_attendance"),
        attendanceRpc<MonthlySummary[]>("attendance_monthly_summary"),
      ]);
      if (mine !== seq.current) return;
      setRows(list ?? []);
      setSummary((sum ?? [])[0] ?? null);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e instanceof Error ? e.message : "Could not load your attendance.");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!signedIn) {
      seq.current++;
      setRows([]);
      setSummary(null);
      setError(null);
      setLoading(false);
    }
  }, [signedIn]);

  useEffect(() => {
    if (signedIn && visible) void reload();
  }, [signedIn, visible, version, reload]);

  return { rows, summary, loading, error, reload };
}
