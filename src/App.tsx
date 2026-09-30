import { Bike, History, User, Wallet } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { supabase } from "./supabaseClient";
import dropexIcon from "./assets/dropex-icon.png";
import { publishRiderPosition, clearRiderPosition } from "./riderPosition";

// Lazy-loaded so the Google Maps JS API only downloads when a delivery is actually on the way.
const DeliveryMap = lazy(() => import("./DeliveryMap").then((m) => ({ default: m.DeliveryMap })));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Me = {
  id: string;
  full_name: string;
  phone: string | null;
  vehicle_type: string | null;
  vehicle_number: string | null;
  is_online: boolean;
  approval_status: string;
  cod_in_hand: number;
  delivered_today: number;
  earnings_today: number;
};

type Order = {
  id: string;
  order_number: string;
  status: string;
  created_at: string;
  updated_at: string;
  category: string | null;
  notes: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  pickup_address: string | null;
  drop_address: string | null;
  drop_lat: number | null;
  drop_lng: number | null;
  zone_name: string | null;
  distance_km: number | null;
  fare_amount: number | null;
  cod_amount: number | null;
  declared_weight_kg: number | null;
  confirmed_weight_kg: number | null;
  rider_earning: number | null;
  requires_otp: boolean;
  failure_reason: string | null;
};

type Action = "accept" | "reject" | "pickup" | "start" | "deliver";
type Screen = "loading" | "login" | "otp" | "home" | "blocked";
type Stage = "new" | "toPickup" | "toDeliver" | "onWay" | "done";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function callRpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

function formatPKR(n: number | null | undefined): string {
  return `Rs ${Math.round(Number(n ?? 0)).toLocaleString("en-PK")}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-PK", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function stageOf(status: string): Stage {
  switch (status) {
    case "assigned":
      return "new";
    case "accepted":
    case "arriving_pickup":
      return "toPickup";
    case "picked_up":
      return "toDeliver";
    case "in_transit":
    case "arriving_dropoff":
      return "onWay";
    default:
      return "done";
  }
}

const STAGE_RANK: Record<Stage, number> = { new: 0, toPickup: 1, toDeliver: 2, onWay: 3, done: 4 };

const STATUS_LABELS: Record<string, string> = {
  assigned: "New order",
  accepted: "Accepted",
  arriving_pickup: "Going to pickup",
  picked_up: "Picked up",
  in_transit: "On the way",
  arriving_dropoff: "Near drop-off",
  delivered: "Delivered",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  closed_refunded: "Closed",
};

function pillClass(status: string): string {
  if (status === "delivered" || status === "completed") return "pill success";
  if (status === "failed" || status === "cancelled" || status === "closed_refunded") return "pill danger";
  if (status === "assigned") return "pill warn";
  return "pill";
}

function mapsLink(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address + " Bahawalnagar")}`;
}

function friendlyLoginError(message: string): string {
  if (/signups not allowed|not allowed for otp|user not found/i.test(message)) {
    return "This email is not registered as a rider. Please contact the DropEx office.";
  }
  return message;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

// Last location error shown to the rider, so the same message isn't repeated on every GPS tick.
let lastLocationError = "";

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [emailInput, setEmailInput] = useState("");
  const [pendingEmail, setPendingEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [me, setMe] = useState<Me | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [tab, setTab] = useState<"orders" | "history" | "earnings" | "account">("orders");
  const [blockedMsg, setBlockedMsg] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  const seenAssigned = useRef<Set<string> | null>(null);
  const ordersRef = useRef<Order[]>([]);
  ordersRef.current = orders;

  const loadAll = useCallback(async (silent: boolean) => {
    try {
      const m = await callRpc<Me>("rider_me");
      setMe(m);
      if (m.approval_status !== "approved") {
        setBlockedMsg(
          m.approval_status === "pending"
            ? "Your rider account is waiting for approval from the DropEx office."
            : `Your rider account is ${m.approval_status}. Please contact the DropEx office.`,
        );
        setScreen("blocked");
        return;
      }
      const list = (await callRpc<Order[] | null>("rider_my_orders")) ?? [];
      setOrders(list);
      setLoadError(null);
      setScreen("home");

      // Alert when a brand-new order is assigned while the app is open
      const assignedIds = new Set(list.filter((o) => o.status === "assigned").map((o) => o.id));
      if (seenAssigned.current !== null) {
        const fresh = [...assignedIds].some((id) => !seenAssigned.current!.has(id));
        if (fresh) {
          setNotice("New order assigned to you!");
          if (typeof navigator.vibrate === "function") navigator.vibrate([200, 100, 200]);
        }
      }
      seenAssigned.current = assignedIds;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not load your data.";
      if (/not a rider account/i.test(msg)) {
        setBlockedMsg("This account is not a rider account.");
        setScreen("blocked");
      } else if (/not active/i.test(msg)) {
        setBlockedMsg("Your account is not active. Please contact the DropEx office.");
        setScreen("blocked");
      } else if (silent) {
        setLoadError(msg);
      } else {
        setBlockedMsg(msg);
        setScreen("blocked");
      }
    }
  }, []);

  // First load: restore an existing session
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        await loadAll(false);
      } else {
        setScreen("login");
      }
    })();
  }, [loadAll]);

  // Keep the list fresh while the rider has the app open
  useEffect(() => {
    if (screen !== "home") return;
    const refresh = () => {
      if (document.visibilityState === "visible") void loadAll(true);
    };
    const timer = window.setInterval(refresh, 8000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [screen, loadAll]);

  // ---------------------------------------------------------------------------
  // LIVE GPS LOCATION TRACKING LOGIC (ADDED HERE)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    // صرف اس وقت لوکیشن بھیجیں جب رائڈر Home پر ہو اور Online ہو
    if (screen !== "home" || !me || !me.is_online) return;

    if (!navigator.geolocation) {
      console.warn("Geolocation is not supported by this browser/device.");
      return;
    }

    // لائیو GPS واچر انسٹال کریں
    const watchId = navigator.geolocation.watchPosition(
      async (pos) => {
        const { latitude, longitude, heading } = pos.coords;
        // پہلے ایکٹو آرڈر فائنڈ کریں (read at send time so the GPS watch isn't restarted on every refresh)
        const activeOrder = ordersRef.current.find((o) => stageOf(o.status) !== "done");
        // Hand the same fix to the delivery map (no second GPS watcher needed).
        publishRiderPosition({ lat: latitude, lng: longitude });

        try {
          // Supabase 'rider_locations' ٹیبل میں پوزیشن update/upsert کریں۔
          const { error: locErr } = await supabase.from("rider_locations").upsert(
            {
              rider_id: me.id,
              order_id: activeOrder ? activeOrder.id : null,
              latitude: latitude,
              longitude: longitude,
              heading: heading || 0,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "rider_id" } // ہر رائڈر کی صرف 1 تازہ رو رہے گی
          );
          // supabase-js does not throw on database errors; it returns them, so check explicitly.
          if (locErr) {
            console.error("Location upload failed:", locErr);
            const msg = `Location not saved: ${locErr.message}${locErr.code ? ` (${locErr.code})` : ""}`;
            if (msg !== lastLocationError) {
              lastLocationError = msg;
              setNotice(msg);
            }
          } else {
            lastLocationError = "";
          }
        } catch (e) {
          console.error("Location upload failed:", e);
        }
      },
      (err) => {
        console.warn("GPS error:", err.message);
        const msg = err.code === 1
          ? "Location permission is blocked. Allow location for this app, or orders cannot be assigned to you."
          : `GPS error: ${err.message}`;
        if (msg !== lastLocationError) {
          lastLocationError = msg;
          setNotice(msg);
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 5000,
      }
    );

    // سکرین تبدیل ہونے یا Offline ہونے پر GPS بند کریں
    return () => {
      navigator.geolocation.clearWatch(watchId);
      clearRiderPosition();
    };
  }, [screen, me?.id, me?.is_online]);

  // Keep the screen awake while the rider is online with the app open. A web page can only
  // send GPS while it is visible; with the screen off the browser pauses it.
  useEffect(() => {
    if (screen !== "home" || !me?.is_online) return;
    const held: { lock: WakeLockSentinel | null } = { lock: null };
    let cancelled = false;
    const acquire = async () => {
      try {
        if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) void lock.release();
        else held.lock = lock;
      } catch {
        /* unsupported or denied — nothing to do */
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void held.lock?.release();
    };
  }, [screen, me?.is_online]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(t);
  }, [notice]);

  async function sendOtp(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const clean = emailInput.trim().toLowerCase();
      const { error: otpErr } = await supabase.auth.signInWithOtp({
        email: clean,
        options: { shouldCreateUser: false },
      });
      if (otpErr) throw new Error(friendlyLoginError(otpErr.message));
      setPendingEmail(clean);
      setOtp("");
      setScreen("otp");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the code.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { error: vErr } = await supabase.auth.verifyOtp({
        email: pendingEmail,
        token: otp.trim(),
        type: "email",
      });
      if (vErr) throw new Error("That code is incorrect or has expired. Please try again.");
      seenAssigned.current = null;
      await loadAll(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not verify the code.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    setMe(null);
    setOrders([]);
    setEmailInput("");
    setPendingEmail("");
    setOtp("");
    setError(null);
    seenAssigned.current = null;
    setScreen("login");
  }

  async function toggleOnline() {
    if (!me) return;
    setToggleBusy(true);
    try {
      await callRpc("rider_set_online", { p_online: !me.is_online });
      await loadAll(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not change your status.");
    } finally {
      setToggleBusy(false);
    }
  }

  async function handleAction(orderId: string, action: Action, otpValue?: string, note?: string, weightKg?: number) {
    await callRpc("rider_update_order", {
      p_order_id: orderId,
      p_action: action,
      p_otp: otpValue ?? null,
      p_note: note ?? null,
      p_weight_kg: weightKg ?? null,
    });
    await loadAll(true);
  }

  // -------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------

  const header = (
    <div className="header">
      <div className="brand">
        <img className="brand-mark" src={dropexIcon} alt="" width={30} height={30} />
        <div className="brand-text">
          <span className="brand-name">DropEx</span>
          <small>Rider</small>
        </div>
      </div>
      {screen === "home" || screen === "blocked" ? (
        <button className="link" onClick={signOut}>
          Sign out
        </button>
      ) : null}
    </div>
  );

  if (screen === "loading") {
    return (
      <div className="app">
        {header}
        <div className="content">
          <p className="empty">Loading…</p>
        </div>
      </div>
    );
  }

  if (screen === "login") {
    return (
      <div className="app">
        {header}
        <div className="content">
          <div className="card">
            <h1>Rider sign in</h1>
            <p className="hint">Enter the email the DropEx office registered for you. We will send a 6-digit code.</p>
            <form onSubmit={sendOtp}>
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                required
              />
              {error ? <div className="error">{error}</div> : null}
              <button className="primary" type="submit" disabled={busy}>
                {busy ? "Sending…" : "Send code"}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "otp") {
    return (
      <div className="app">
        {header}
        <div className="content">
          <div className="card">
            <h1>Enter your code</h1>
            <p className="hint">We sent a 6-digit code to {pendingEmail}. Check your inbox (and spam folder).</p>
            <form onSubmit={verifyOtp}>
              <label htmlFor="otp">Verification code</label>
              <input
                id="otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="123456"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                required
              />
              {error ? <div className="error">{error}</div> : null}
              <button className="primary" type="submit" disabled={busy || otp.length < 6}>
                {busy ? "Checking…" : "Sign in"}
              </button>
            </form>
            <button className="secondary" onClick={() => setScreen("login")}>
              Use a different email
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "blocked") {
    return (
      <div className="app">
        {header}
        <div className="content">
          <div className="card">
            <h1>Cannot open the rider app</h1>
            <p className="hint">{blockedMsg}</p>
            <button className="primary" onClick={() => loadAll(false)}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Home
  const active = orders
    .filter((o) => stageOf(o.status) !== "done")
    .sort((a, b) => STAGE_RANK[stageOf(a.status)] - STAGE_RANK[stageOf(b.status)]);
  const history = orders.filter((o) => stageOf(o.status) === "done");
  const list = tab === "orders" ? active : history;

  return (
    <div className="app">
      {header}
      <div className="content">
        {notice ? <div className="banner">{notice}</div> : null}
        {loadError ? <div className="error">{loadError}</div> : null}

        <div className="card profile">
          <div>
            <div className="rider-name">{me?.full_name}</div>
            <div className="order-meta">
              {[me?.vehicle_type, me?.vehicle_number].filter(Boolean).join(" · ") || "Rider"}
            </div>
          </div>
          <button
            className={me?.is_online ? "toggle on" : "toggle"}
            onClick={toggleOnline}
            disabled={toggleBusy}
            aria-pressed={me?.is_online ? "true" : "false"}
          >
            {me?.is_online ? "Online" : "Offline"}
          </button>
        </div>

        {tab === "earnings" ? (
          <>
            <h1>Earnings</h1>
            <div className="stats">
              <div className="stat">
                <div className="stat-value">{me?.delivered_today ?? 0}</div>
                <div className="stat-label">Delivered today</div>
              </div>
              <div className="stat">
                <div className="stat-value">{formatPKR(me?.earnings_today)}</div>
                <div className="stat-label">Earned today</div>
              </div>
              <div className="stat">
                <div className="stat-value">{formatPKR(me?.cod_in_hand)}</div>
                <div className="stat-label">Cash in hand</div>
              </div>
            </div>
          </>
        ) : null}

        {tab === "account" ? (
          <>
            <h1>Account</h1>
            <div className="card">
              <div className="acct-row"><span>Name</span><span>{me?.full_name ?? "—"}</span></div>
              <div className="acct-row"><span>Phone</span><span>{me?.phone ?? "—"}</span></div>
              <div className="acct-row"><span>Vehicle</span><span>{[me?.vehicle_type, me?.vehicle_number].filter(Boolean).join(" · ") || "—"}</span></div>
            </div>
            <button className="secondary" style={{ marginTop: 12 }} onClick={signOut}>
              Sign out
            </button>
          </>
        ) : null}

        {tab === "orders" || tab === "history" ? (
          list.length === 0 ? (
            <p className="empty">
              {tab === "orders" ? "No active orders. New orders assigned to you will appear here." : "No past orders yet."}
            </p>
          ) : (
            list.map((o) => <OrderCard key={o.id} order={o} defaultOpen={tab === "orders"} onAct={handleAction} />)
          )
        ) : null}
      </div>

      <nav className="bottom-nav" aria-label="Main navigation">
        {(
          [
            { key: "orders", label: "Orders", Icon: Bike, badge: active.length },
            { key: "history", label: "History", Icon: History, badge: 0 },
            { key: "earnings", label: "Earnings", Icon: Wallet, badge: 0 },
            { key: "account", label: "Account", Icon: User, badge: 0 },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            className="bottom-nav-item"
            data-active={tab === t.key}
            aria-current={tab === t.key ? "page" : undefined}
            onClick={() => setTab(t.key)}
          >
            <span className="bottom-nav-icon">
              <t.Icon size={22} aria-hidden="true" />
              {t.badge > 0 ? <span className="bottom-nav-badge">{t.badge}</span> : null}
            </span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Order card
// ---------------------------------------------------------------------------

function OrderCard({
  order,
  defaultOpen,
  onAct,
}: {
  order: Order;
  defaultOpen: boolean;
  onAct: (orderId: string, action: Action, otp?: string, note?: string, weightKg?: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [otp, setOtp] = useState("");
  const [note, setNote] = useState("");
  const [weightInput, setWeightInput] = useState(
    order.declared_weight_kg != null ? String(order.declared_weight_kg) : "",
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const stage = stageOf(order.status);
  // Memoised so the map effect does not restart on every list refresh.
  const dropPoint = useMemo(
    () => ({ lat: Number(order.drop_lat), lng: Number(order.drop_lng) }),
    [order.drop_lat, order.drop_lng],
  );
  const cod = Number(order.cod_amount ?? 0);
  const phone = order.contact_phone || order.customer_phone || "";
  const contact = order.contact_name || order.customer_name || "Customer";

  async function act(action: Action, extra?: { otp?: string; note?: string; weightKg?: number }) {
    setErr(null);
    setBusy(true);
    try {
      await onAct(order.id, action, extra?.otp, extra?.note, extra?.weightKg);
      setOtp("");
      setNote("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  function reject() {
    if (!window.confirm("Reject this order? It will go back to the DropEx office to assign to someone else.")) return;
    const reason = window.prompt("Reason (optional)") ?? "";
    void act("reject", { note: reason });
  }

  return (
    <div className="card order-card">
      <button className="order-head" onClick={() => setOpen((v) => !v)}>
        <div>
          <div className="order-id">{order.order_number}</div>
          <div className="order-meta">
            {formatTime(order.created_at)}
            {order.zone_name ? ` · ${order.zone_name}` : ""}
          </div>
        </div>
        <div className="head-right">
          {cod > 0 ? <span className="cod-chip">COD {formatPKR(cod)}</span> : null}
          <span className={pillClass(order.status)}>{STATUS_LABELS[order.status] ?? order.status}</span>
        </div>
      </button>

      {open ? (
        <div className="order-body">
          <div className="addr">
            <div className="addr-label">Pickup</div>
            <div className="addr-text">{order.pickup_address ?? "—"}</div>
            {order.pickup_address ? (
              <a className="mini-link" href={mapsLink(order.pickup_address)} target="_blank" rel="noreferrer">
                Open in Maps
              </a>
            ) : null}
          </div>
          <div className="addr">
            <div className="addr-label">Drop-off</div>
            <div className="addr-text">{order.drop_address ?? "—"}</div>
            {order.drop_address ? (
              <a className="mini-link" href={mapsLink(order.drop_address)} target="_blank" rel="noreferrer">
                Open in Maps
              </a>
            ) : null}
          </div>

          {stage === "onWay" && typeof order.drop_lat === "number" && typeof order.drop_lng === "number" ? (
            // Delivery started: live Rider -> Drop-off route (unmounts, and stops all updates, once delivered).
            <Suspense fallback={<p className="hint">Loading map…</p>}>
              <DeliveryMap drop={dropPoint} />
            </Suspense>
          ) : null}

          <div className="kv">
            <span>Contact</span>
            <span>
              {contact}
              {phone ? (
                <>
                  {" · "}
                  <a className="mini-link" href={`tel:${phone}`}>
                    {phone}
                  </a>
                </>
              ) : null}
            </span>
          </div>
          {order.category ? (
            <div className="kv">
              <span>Item</span>
              <span>{order.category}</span>
            </div>
          ) : null}
          {order.declared_weight_kg != null ? (
            <div className="kv">
              <span>Weight (customer estimate)</span>
              <span>{order.declared_weight_kg} kg</span>
            </div>
          ) : null}
          {order.confirmed_weight_kg != null ? (
            <div className="kv">
              <span>Weight (confirmed)</span>
              <span>{order.confirmed_weight_kg} kg</span>
            </div>
          ) : null}
          {order.notes ? (
            <div className="kv">
              <span>Notes</span>
              <span>{order.notes}</span>
            </div>
          ) : null}
          <div className="kv">
            <span>Your earning</span>
            <span>{formatPKR(order.rider_earning)}</span>
          </div>
          {order.status === "failed" && order.failure_reason ? (
            <div className="kv">
              <span>Reason</span>
              <span>{order.failure_reason}</span>
            </div>
          ) : null}

          {cod > 0 && stage !== "done" ? (
            <div className="cod-banner">Collect {formatPKR(cod)} cash from the customer at drop-off.</div>
          ) : null}

          {err ? <div className="error">{err}</div> : null}

          {stage === "new" ? (
            <>
              <button className="primary" disabled={busy} onClick={() => act("accept")}>
                {busy ? "Please wait…" : "Accept order"}
              </button>
              <button className="secondary" disabled={busy} onClick={reject}>
                Reject
              </button>
            </>
          ) : null}

          {stage === "toPickup" ? (
            <>
              <label htmlFor={`weight-${order.id}`}>Confirm actual weight (kg)</label>
              <input
                id={`weight-${order.id}`}
                inputMode="decimal"
                value={weightInput}
                onChange={(e) => setWeightInput(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="e.g. 3"
              />
              <button
                className="primary"
                disabled={busy}
                onClick={() => act("pickup", { weightKg: Number(weightInput) || undefined })}
              >
                {busy ? "Please wait…" : "I have picked up the order"}
              </button>
              <button className="secondary" disabled={busy} onClick={reject}>
                I cannot do this order
              </button>
            </>
          ) : null}

          {stage === "toDeliver" ? (
            <>
              <button className="primary" disabled={busy} onClick={() => act("start")}>
                {busy ? "Please wait…" : "Start delivery"}
              </button>
              <p className="office-note">Can't complete this order? Call the office — it can't be reported from here.</p>
            </>
          ) : null}

          {stage === "onWay" ? (
            <>
              {order.requires_otp ? (
                <>
                  <label htmlFor={`otp-${order.id}`}>Delivery code (ask the customer)</label>
                  <input
                    id={`otp-${order.id}`}
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="Code"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                  />
                </>
              ) : null}
              <label htmlFor={`note-${order.id}`}>Note (optional)</label>
              <input
                id={`note-${order.id}`}
                placeholder="e.g. handed to the customer's brother"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                className="primary"
                disabled={busy || (order.requires_otp && otp.length === 0)}
                onClick={() => act("deliver", { otp, note })}
              >
                {busy ? "Please wait…" : cod > 0 ? `Delivered — cash ${formatPKR(cod)} collected` : "Confirm delivery"}
              </button>
              <p className="office-note">Can't complete this order? Call the office — it can't be reported from here.</p>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
