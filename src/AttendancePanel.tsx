import { CalendarCheck, Clock, MapPin } from "lucide-react";

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
          <CalendarCheck size={14} aria-hidden="true" /> Today's shift
        </div>
        {loadError ? (
          <>
            <div className="error">{loadError}</div>
            <button className="secondary" onClick={() => void att.refresh()}>
              Try again
            </button>
          </>
        ) : (
          <p className="hint att-loading">Loading your shift…</p>
        )}
      </div>
    );
  }

  if (!data.has_shift || !data.shift) {
    return (
      <div className="card att-card">
        <div className="att-eyebrow">
          <CalendarCheck size={14} aria-hidden="true" /> Today's shift
        </div>
        <div className="att-shift-name">No shift today</div>
        <p className="hint att-nohint">{data.message ?? "No shift is assigned to you today."}</p>
      </div>
    );
  }

  const shift = data.shift;
  const rec = data.attendance ?? null;
  const checkedIn = !!rec?.check_in_at;
  const checkedOut = !!rec?.check_out_at;
  const working = phase !== "idle";
  const geofenced = shift.geofence_policy !== "off" && !!shift.location_name;

  const badge = rec ? STATUS_LABEL[rec.status] ?? rec.status : "Not checked in";
  const badgeClass = rec ? statusPillClass(rec.status) : "pill muted";

  let buttonLabel = "CHECK IN";
  if (phase === "locating") buttonLabel = "Detecting GPS…";
  else if (phase === "submitting") buttonLabel = checkedIn ? "Checking out…" : "Checking in…";
  else if (checkedIn && !checkedOut) buttonLabel = "CHECK OUT";

  const canAct = checkedIn ? data.can_check_out : data.can_check_in;
  const showButton = !checkedOut && !(rec && !checkedIn);
  const disabled = working || !online || !canAct;

  // Why the button is disabled (when the server already knows).
  const blockedReason = !online
    ? "Internet connection required for attendance."
    : !canAct && !working && !checkedIn
      ? data.message
      : null;

  return (
    <div className="card att-card">
      <div className="att-top">
        <div className="att-eyebrow">
          <CalendarCheck size={14} aria-hidden="true" /> Today's shift
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
          <span>Assigned date</span>
          <span>{fmtDate(data.work_date, true)}</span>
        </div>
        <div className="kv">
          <span>Shift status</span>
          <span>{SHIFT_STATE_LABEL[shift.state]}</span>
        </div>
        <div className="kv">
          <span>Checked in</span>
          <span>{checkedIn ? fmtTime(rec!.check_in_at) : "Not yet"}</span>
        </div>
        <div className="kv">
          <span>Checked out</span>
          <span>{checkedOut ? fmtTime(rec!.check_out_at) : "Not yet"}</span>
        </div>
        {checkedIn && rec!.late_minutes > 0 ? (
          <div className="kv">
            <span>Late by</span>
            <span>{rec!.late_minutes} min</span>
          </div>
        ) : null}
        {checkedOut ? (
          <div className="kv">
            <span>Working</span>
            <span>{fmtDuration(rec!.working_minutes)}</span>
          </div>
        ) : null}
        {geofenced ? (
          <div className="kv">
            <span>Attendance area</span>
            <span className="att-area">
              <MapPin size={13} aria-hidden="true" /> {shift.location_name}
            </span>
          </div>
        ) : null}
      </div>

      {success ? <div className="att-success">{success}</div> : null}
      {warning ? <div className="banner att-warning">{warning}</div> : null}
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
        <p className="office-note att-blocked">Shift completed. Thank you!</p>
      ) : data.message ? (
        <p className="office-note att-blocked">{data.message}</p>
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
        <span className={statusPillClass(row.status)}>{STATUS_LABEL[row.status] ?? row.status}</span>
      </div>
      {row.derived ? (
        <p className="office-note att-derived">No check-in was recorded for this shift.</p>
      ) : (
        <div className="att-history-grid">
          <div>
            <span>Check-in</span>
            <strong>{fmtTime(row.check_in_at)}</strong>
          </div>
          <div>
            <span>Check-out</span>
            <strong>{fmtTime(row.check_out_at)}</strong>
          </div>
          <div>
            <span>Late</span>
            <strong>{row.late_minutes > 0 ? `${row.late_minutes} min` : "—"}</strong>
          </div>
          <div>
            <span>Working</span>
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
    ? new Date(`${s.month}T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", month: "long", year: "numeric" })
    : "This month";

  return (
    <>
      <h1>Attendance</h1>

      <div className="att-month">{monthLabel}</div>
      <div className="stats att-stats">
        <div className="stat">
          <div className="stat-value">{s?.attendance_percentage != null ? `${s.attendance_percentage}%` : "—"}</div>
          <div className="stat-label">Attendance</div>
        </div>
        <div className="stat">
          <div className="stat-value">{s ? s.present_days + s.late_days : 0}</div>
          <div className="stat-label">Days worked</div>
        </div>
        <div className="stat">
          <div className="stat-value">{s?.late_days ?? 0}</div>
          <div className="stat-label">Late days</div>
        </div>
        <div className="stat">
          <div className="stat-value">{s?.absent_days ?? 0}</div>
          <div className="stat-label">Absent</div>
        </div>
        <div className="stat">
          <div className="stat-value">{s?.leave_days ?? 0}</div>
          <div className="stat-label">Leave</div>
        </div>
        <div className="stat">
          <div className="stat-value">{fmtDuration(s?.total_working_minutes ?? 0)}</div>
          <div className="stat-label">Hours worked</div>
        </div>
      </div>

      <h2 className="att-subtitle">Last 30 days</h2>
      {error ? (
        <div className="error">
          {error}{" "}
          <button className="link" onClick={() => void history.reload()}>
            Retry
          </button>
        </div>
      ) : null}
      {loading && rows.length === 0 && !error ? <p className="empty">Loading…</p> : null}
      {!loading && rows.length === 0 && !error ? <p className="empty">No attendance records yet.</p> : null}
      {rows.map((r) => (
        <HistoryItem key={r.id ?? `d-${r.date}`} row={r} />
      ))}
    </>
  );
}
