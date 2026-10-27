import { CalendarCheck, Clock, MapPin } from "lucide-react";

import { locale, tr } from "./i18n";
import {
  fmtDate,
  fmtDuration,
  fmtTime,
  STATUS_LABEL,
  type AttendanceController,
  type AttendanceHistoryState,
  type HistoryRow,
} from "./attendance";

function statusPillClass(status: string): string {
  if (status === "present") return "pill success";
  if (status === "late" || status === "incomplete") return "pill warn";
  if (status === "absent") return "pill danger";
  return "pill muted"; // leave, manual override, not checked in
}

const SHIFT_STATE_LABEL = { upcoming: "Not started", in_progress: "In progress", ended: "Ended" } as const;

// ---------------------------------------------------------------------------
// Today's shift + Check In / Check Out
// ---------------------------------------------------------------------------

export function AttendanceCard({ att }: { att: AttendanceController }) {
  const { data, loading, loadError, online, phase, actionError, warning, success } = att;

  if (!data) {
    return (
      <div className="card att-card" aria-busy={loading}>
        <div className="att-eyebrow">
          <CalendarCheck size={14} aria-hidden="true" /> {tr("Today's shift")}
        </div>
        {loadError ? (
          <>
            <div className="error">{loadError}</div>
            <button className="secondary" onClick={() => void att.refresh()}>
              {tr("Try again")}
            </button>
          </>
        ) : (
          <p className="hint att-loading">{tr("Loading your shift…")}</p>
        )}
      </div>
    );
  }

  if (!data.has_shift || !data.shift) {
    return (
      <div className="card att-card">
        <div className="att-eyebrow">
          <CalendarCheck size={14} aria-hidden="true" /> {tr("Today's shift")}
        </div>
        <div className="att-shift-name">{tr("No shift today")}</div>
        <p className="hint att-nohint">{tr(data.message ?? "No shift is assigned to you today.")}</p>
      </div>
    );
  }

  const shift = data.shift;
  const rec = data.attendance ?? null;
  const checkedIn = !!rec?.check_in_at;
  const checkedOut = !!rec?.check_out_at;
  const working = phase !== "idle";
  const geofenced = shift.geofence_policy !== "off" && !!shift.location_name;

  const badge = tr(rec ? STATUS_LABEL[rec.status] ?? rec.status : "Not checked in");
  const badgeClass = rec ? statusPillClass(rec.status) : "pill muted";

  let buttonLabel = "CHECK IN";
  if (phase === "locating") buttonLabel = tr("Detecting GPS…");
  else if (phase === "submitting") buttonLabel = checkedIn ? tr("Checking out…") : tr("Checking in…");
  else if (checkedIn && !checkedOut) buttonLabel = "CHECK OUT";

  const canAct = checkedIn ? data.can_check_out : data.can_check_in;
  const showButton = !checkedOut && !(rec && !checkedIn);
  const disabled = working || !online || !canAct;

  // Why the button is disabled (when the server already knows).
  const blockedReason = !online
    ? tr("Internet connection required for attendance.")
    : !canAct && !working && !checkedIn
      ? data.message
        ? tr(data.message)
        : null
      : null;

  return (
    <div className="card att-card">
      <div className="att-top">
        <div className="att-eyebrow">
          <CalendarCheck size={14} aria-hidden="true" /> {tr("Today's shift")}
        </div>
        <span className={badgeClass}>{badge}</span>
      </div>

      <div className="att-shift-name">{shift.name}</div>
      <div className="att-shift-time">
        <Clock size={15} aria-hidden="true" />
        {fmtTime(shift.start_at)} – {fmtTime(shift.end_at)}
      </div>

      <div className="att-rows">
        <div className="kv">
          <span>{tr("Assigned date")}</span>
          <span>{fmtDate(data.work_date, true)}</span>
        </div>
        <div className="kv">
          <span>{tr("Shift status")}</span>
          <span>{tr(SHIFT_STATE_LABEL[shift.state])}</span>
        </div>
        <div className="kv">
          <span>{tr("Checked in")}</span>
          <span>{checkedIn ? fmtTime(rec!.check_in_at) : tr("Not yet")}</span>
        </div>
        <div className="kv">
          <span>{tr("Checked out")}</span>
          <span>{checkedOut ? fmtTime(rec!.check_out_at) : tr("Not yet")}</span>
        </div>
        {checkedIn && rec!.late_minutes > 0 ? (
          <div className="kv">
            <span>{tr("Late by")}</span>
            <span>{tr("{n} min", { n: rec!.late_minutes })}</span>
          </div>
        ) : null}
        {checkedOut ? (
          <div className="kv">
            <span>{tr("Working")}</span>
            <span>{fmtDuration(rec!.working_minutes)}</span>
          </div>
        ) : null}
        {geofenced ? (
          <div className="kv">
            <span>{tr("Attendance area")}</span>
            <span className="att-area">
              <MapPin size={13} aria-hidden="true" /> {shift.location_name}
            </span>
          </div>
        ) : null}
      </div>

      {success ? <div className="att-success">{success}</div> : null}
      {warning ? <div className="banner att-warning">{tr(warning)}</div> : null}
      {actionError ? <div className="error">{actionError}</div> : null}

      {showButton ? (
        <>
          <button
            className={checkedIn ? "att-button out" : "att-button"}
            onClick={() => void (checkedIn ? att.checkOut() : att.checkIn())}
            disabled={disabled}
            aria-busy={working}
          >
            {working ? <span className="att-spinner" aria-hidden="true" /> : null}
            {buttonLabel}
          </button>
          {blockedReason ? <p className="office-note att-blocked">{blockedReason}</p> : null}
        </>
      ) : checkedOut ? (
        <p className="office-note att-blocked">{tr("Shift completed. Thank you!")}</p>
      ) : data.message ? (
        <p className="office-note att-blocked">{tr(data.message)}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// History + monthly summary
// ---------------------------------------------------------------------------

function HistoryItem({ row }: { row: HistoryRow }) {
  return (
    <div className="card att-history-item">
      <div className="att-history-head">
        <div>
          <div className="order-id">{fmtDate(row.date)}</div>
          <div className="order-meta">
            {row.shift_name} · {fmtTime(row.shift_start_at)} – {fmtTime(row.shift_end_at)}
          </div>
        </div>
        <span className={statusPillClass(row.status)}>{tr(STATUS_LABEL[row.status] ?? row.status)}</span>
      </div>
      {row.derived ? (
        <p className="office-note att-derived">{tr("No check-in was recorded for this shift.")}</p>
      ) : (
        <div className="att-history-grid">
          <div>
            <span>{tr("Check-in")}</span>
            <strong>{fmtTime(row.check_in_at)}</strong>
          </div>
          <div>
            <span>{tr("Check-out")}</span>
            <strong>{fmtTime(row.check_out_at)}</strong>
          </div>
          <div>
            <span>{tr("Late")}</span>
            <strong>{row.late_minutes > 0 ? tr("{n} min", { n: row.late_minutes }) : "—"}</strong>
          </div>
          <div>
            <span>{tr("Working")}</span>
            <strong>{fmtDuration(row.working_minutes)}</strong>
          </div>
        </div>
      )}
    </div>
  );
}

export function AttendanceHistory({ history }: { history: AttendanceHistoryState }) {
  const { rows, summary, loading, error } = history;
  const s = summary;
  const monthLabel = s
    ? new Date(`${s.month}T12:00:00Z`).toLocaleDateString(locale() === "en-PK" ? "en-GB" : locale(), { timeZone: "UTC", month: "long", year: "numeric" })
    : tr("This month");

  return (
    <>
      <h1>{tr("Attendance")}</h1>

      <div className="att-month">{monthLabel}</div>
      <div className="stats att-stats">
        <div className="stat">
          <div className="stat-value">{s?.attendance_percentage != null ? `${s.attendance_percentage}%` : "—"}</div>
          <div className="stat-label">{tr("Attendance")}</div>
        </div>
        <div className="stat">
          <div className="stat-value">{s ? s.present_days + s.late_days : 0}</div>
          <div className="stat-label">{tr("Days worked")}</div>
        </div>
        <div className="stat">
          <div className="stat-value">{s?.late_days ?? 0}</div>
          <div className="stat-label">{tr("Late days")}</div>
        </div>
        <div className="stat">
          <div className="stat-value">{s?.absent_days ?? 0}</div>
          <div className="stat-label">{tr("Absent")}</div>
        </div>
        <div className="stat">
          <div className="stat-value">{s?.leave_days ?? 0}</div>
          <div className="stat-label">{tr("Leave")}</div>
        </div>
        <div className="stat">
          <div className="stat-value">{fmtDuration(s?.total_working_minutes ?? 0)}</div>
          <div className="stat-label">{tr("Hours worked")}</div>
        </div>
      </div>

      <h2 className="att-subtitle">{tr("Last 30 days")}</h2>
      {error ? (
        <div className="error">
          {error}{" "}
          <button className="link" onClick={() => void history.reload()}>
            {tr("Retry")}
          </button>
        </div>
      ) : null}
      {loading && rows.length === 0 && !error ? <p className="empty">{tr("Loading…")}</p> : null}
      {!loading && rows.length === 0 && !error ? <p className="empty">{tr("No attendance records yet.")}</p> : null}
      {rows.map((r) => (
        <HistoryItem key={r.id ?? `d-${r.date}`} row={r} />
      ))}
    </>
  );
}
