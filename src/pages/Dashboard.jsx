import { useLocation, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  serverTimestamp,
  query,
  where,
  onSnapshot,
  getDocs,
  doc,
  updateDoc,
} from "firebase/firestore";
import { db } from "../firebase";

const LAUNDRY_COOLDOWN_MS = 60 * 60 * 1000; // ✅ 1 hour

function formatRemaining(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

export default function Dashboard() {
  const { state } = useLocation();
  const navigate = useNavigate();

  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);

  // ✅ Tabs
  const [activeTab, setActiveTab] = useState("services"); // "services" | "requests"

  // ✅ Request tracking state
  const [requestIds, setRequestIds] = useState([]);
  const [requestsMap, setRequestsMap] = useState({}); // { [id]: {id, ...data} }
  const unsubRef = useRef(new Map()); // Map<id, unsubscribe>

  // ✅ Laundry cooldown state
  const [laundryBlocked, setLaundryBlocked] = useState(false);
  const [laundryRemainingMs, setLaundryRemainingMs] = useState(0);

  useEffect(() => {
    if (!state) navigate("/guest");
  }, [state, navigate]);

  const safeGuestName = state?.guestName || "Guest";
  const safeRoomNumber = state?.roomNumber ?? "—";
  const safeMobile = state?.mobile || "—";
  const safeAdminEmail = state?.adminEmail || "—";
  const adminId = state?.adminId || null;
  const roomNumberForQuery = state?.roomNumber ?? null;
  const guestDocId = state?.guestDocId || null;

  const maskedAdmin = useMemo(() => {
    if (!safeAdminEmail || safeAdminEmail === "—") return "—";
    const [name, domain] = safeAdminEmail.split("@");
    if (!domain) return safeAdminEmail;
    return `${name.slice(0, 2)}***@${domain}`;
  }, [safeAdminEmail]);

  // 🔑 localStorage key for this guest session
  const storageKey = useMemo(() => {
    if (!adminId) return null;
    if (!safeMobile || safeMobile === "—") return null;
    if (roomNumberForQuery === null || roomNumberForQuery === "—") return null;
    return `roomio:requests:${adminId}:${safeMobile}:${roomNumberForQuery}`;
  }, [adminId, safeMobile, roomNumberForQuery]);

  const laundryCooldownKey = useMemo(() => {
    if (!storageKey) return null;
    return `${storageKey}:laundry`;
  }, [storageKey]);

  // ✅ Session cleanup function
  const cleanupSession = async () => {
    if (!guestDocId) return;
    
    try {
      await updateDoc(doc(db, "guests", guestDocId), {
        isLoggedIn: false,
        lastLogout: serverTimestamp()
      });
      console.log("Session cleaned up successfully");
    } catch (e) {
      console.error("Failed to cleanup session:", e);
    }
  };

  // ✅ Handle logout
  const handleLogout = async () => {
    await cleanupSession();
    
    // Navigate back to guest login
    navigate("/guest", { 
      state: { 
        admin: safeAdminEmail 
      } 
    });
  };

  // ✅ REAL-TIME SESSION MONITORING
  useEffect(() => {
    if (!guestDocId || !adminId || !safeMobile) return;

    // Listen to the guest document in real-time
    const guestDocRef = doc(db, "guests", guestDocId);
    
    const unsubscribe = onSnapshot(guestDocRef, (snapshot) => {
      if (!snapshot.exists()) {
        // Document deleted (admin checked out)
        setSessionExpired(true);
        alert("Your session has expired. Admin has checked you out.");
        navigate("/guest", { replace: true });
        return;
      }

      const guestData = snapshot.data();
      
      // Check if someone else logged in (isLoggedIn changed to false by another login)
      if (!guestData.isLoggedIn) {
        setSessionExpired(true);
        alert("Someone else logged in with your mobile number. Your session has been terminated.");
        navigate("/guest", { replace: true });
        return;
      }

      // Check if admin marked as inactive
      if (!guestData.isActive) {
        setSessionExpired(true);
        alert("Your booking is no longer active. Please contact reception.");
        navigate("/guest", { replace: true });
        return;
      }
    }, (error) => {
      console.error("Session monitoring error:", error);
    });

    return () => unsubscribe();
  }, [guestDocId, adminId, safeMobile, navigate]);

  // ✅ Session management useEffect for cleanup
  useEffect(() => {
    const handleBeforeUnload = async (e) => {
      await cleanupSession();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [guestDocId]);

  // Load stored request IDs
  const loadStoredRequestIds = () => {
    if (!storageKey) return [];
    try {
      const raw = localStorage.getItem(storageKey);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  };

  const saveStoredRequestIds = (ids) => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(ids));
    } catch {}
  };

  const addRequestIdToStorage = (id) => {
    if (!storageKey) return;
    const current = loadStoredRequestIds();
    const next = [id, ...current.filter((x) => x !== id)].slice(0, 30); // keep max 30
    saveStoredRequestIds(next);
    setRequestIds(next);
  };

  const clearRequestHistory = () => {
    if (!storageKey) return;
    try {
      localStorage.removeItem(storageKey);
    } catch {}
    setRequestIds([]);
    setRequestsMap({});
  };

  // ✅ Booking query to validate session
  const bookingQuery = useMemo(() => {
    if (!adminId) return null;
    if (!safeMobile || safeMobile === "—") return null;
    if (roomNumberForQuery === null || roomNumberForQuery === "—") return null;

    return query(
      collection(db, "guests"),
      where("adminId", "==", adminId),
      where("mobile", "==", safeMobile),
      where("roomNumber", "==", roomNumberForQuery),
      where("isActive", "==", true)
    );
  }, [adminId, safeMobile, roomNumberForQuery]);

  // ✅ AUTO-KICK if booking removed
  useEffect(() => {
    if (!state) return;
    if (!bookingQuery) return;

    const unsub = onSnapshot(bookingQuery, (snap) => {
      if (snap.empty) {
        // Also cleanup session when booking is removed
        cleanupSession();
        navigate("/guest", { replace: true });
      }
    });

    return () => unsub();
  }, [state, bookingQuery, navigate]);

  // ✅ Load stored request IDs on mount
  useEffect(() => {
    if (!state) return;
    const ids = loadStoredRequestIds();
    setRequestIds(ids);
  }, [state, storageKey]);

  // ✅ Laundry cooldown timer
  useEffect(() => {
    if (!laundryCooldownKey) return;

    const tick = () => {
      try {
        const last = Number(localStorage.getItem(laundryCooldownKey) || 0);
        const nextAllowed = last + LAUNDRY_COOLDOWN_MS;
        const now = Date.now();

        if (last > 0 && now < nextAllowed) {
          setLaundryBlocked(true);
          setLaundryRemainingMs(nextAllowed - now);
        } else {
          setLaundryBlocked(false);
          setLaundryRemainingMs(0);
        }
      } catch {
        setLaundryBlocked(false);
      }
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [laundryCooldownKey]);

  // ✅ Live listeners for requests
  useEffect(() => {
    const existing = unsubRef.current;

    // cleanup removed listeners
    for (const [id, unsub] of existing.entries()) {
      if (!requestIds.includes(id)) {
        try {
          unsub();
        } catch {}
        existing.delete(id);
      }
    }

    // add listeners for new IDs
    requestIds.forEach((id) => {
      if (existing.has(id)) return;

      const ref = doc(db, "serviceRequests", id);

      const unsub = onSnapshot(
        ref,
        (snap) => {
          if (!snap.exists()) {
            setRequestsMap((prev) => {
              const copy = { ...prev };
              copy[id] = { id, status: "deleted" };
              return copy;
            });
            return;
          }
          const data = snap.data();
          setRequestsMap((prev) => ({
            ...prev,
            [id]: { id, ...data },
          }));
        },
        (err) => {
          console.error("Request snapshot error:", err);
          setRequestsMap((prev) => ({
            ...prev,
            [id]: { id, status: "restricted" },
          }));
        }
      );

      existing.set(id, unsub);
    });

    return () => {
      for (const unsub of existing.values()) {
        try {
          unsub();
        } catch {}
      }
      existing.clear();
    };
  }, [requestIds]);

  // ✅ Show session expired message
  if (sessionExpired) {
    return (
      <div style={styles.expiredContainer}>
        <div style={styles.expiredCard}>
          <div style={styles.expiredIcon}>🔒</div>
          <div style={styles.expiredTitle}>Session Expired</div>
          <div style={styles.expiredMessage}>
            Someone else logged in with your mobile number.
          </div>
          <button
            onClick={() => navigate("/guest", { state: { admin: safeAdminEmail } })}
            style={styles.expiredButton}
          >
            Back to Login
          </button>
        </div>
      </div>
    );
  }

  if (!state) return null;

  // ✅ Toast helper
  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  // ✅ Create Service Request (Laundry)
  const requestLaundryPickup = async () => {
    if (!adminId) {
      alert("Missing adminId. Please verify again from QR.");
      return;
    }

    if (!bookingQuery) {
      alert("Booking not active. Please verify again.");
      navigate("/guest");
      return;
    }

    if (laundryBlocked) {
      showToast(`⏳ Available in ${formatRemaining(laundryRemainingMs)}`);
      return;
    }

    setSending(true);
    setToast("");

    try {
      const bookingSnap = await getDocs(bookingQuery);
      if (bookingSnap.empty) {
        alert("Your booking is no longer active.");
        navigate("/guest");
        return;
      }

      const docRef = await addDoc(collection(db, "serviceRequests"), {
        adminId,
        type: "Laundry Pickup",
        roomNumber: safeRoomNumber,
        guestName: safeGuestName,
        guestMobile: safeMobile,
        status: "pending",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        source: "guest-web",
      });

      addRequestIdToStorage(docRef.id);
      
      // Start cooldown
      if (laundryCooldownKey) {
        localStorage.setItem(laundryCooldownKey, String(Date.now()));
      }

      showToast("✅ Laundry pickup request sent!");
      setActiveTab("requests");
    } catch (err) {
      console.error("Laundry request error:", err);
      alert("Failed to send request. Check internet / permissions.");
    } finally {
      setSending(false);
    }
  };

  const requestsList = useMemo(() => {
    const arr = requestIds
      .map((id) => requestsMap[id] || { id, status: "loading" })
      .map((r) => ({
        ...r,
        createdMs: r?.createdAt?.toMillis?.() ?? 0,
      }))
      .sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0));

    return arr;
  }, [requestIds, requestsMap]);

  const statusChip = (status) => {
    const s = (status || "pending").toLowerCase();
    if (s === "accepted") return { bg: "rgba(37,99,235,0.12)", text: "#2563EB", label: "ACCEPTED" };
    if (s === "completed") return { bg: "rgba(22,163,74,0.12)", text: "#16A34A", label: "COMPLETED" };
    if (s === "in-progress") return { bg: "rgba(37,99,235,0.12)", text: "#2563EB", label: "IN PROGRESS" };
    if (s === "restricted") return { bg: "rgba(220,38,38,0.10)", text: "#DC2626", label: "NO ACCESS" };
    if (s === "deleted") return { bg: "rgba(107,114,128,0.12)", text: "#6B7280", label: "REMOVED" };
    if (s === "loading") return { bg: "rgba(107,114,128,0.12)", text: "#6B7280", label: "LOADING" };
    return { bg: "rgba(245,158,11,0.14)", text: "#F59E0B", label: "PENDING" };
  };

  const formatTime = (t) => {
    try {
      const d = t?.toDate?.();
      return d ? d.toLocaleString() : "Just now";
    } catch {
      return "Just now";
    }
  };

  // ✅ Navigate to Menu Page
  const goToMenu = () => {
    navigate("/menu", { state });
  };

  return (
    <div style={styles.page} className="safeArea">
      <GlobalStyles />

      <div style={styles.backgroundDecor} aria-hidden="true">
        <div style={styles.bgCircle1} />
        <div style={styles.bgCircle2} />
        <div style={styles.bgCircle3} />
      </div>

      <div style={styles.shell}>
        <div style={styles.header}>
          <div style={styles.logoWrap}>
            <div style={styles.logoCircle}>R</div>
          </div>
          <div style={styles.headerText}>
            <div style={styles.greeting}>GUEST DASHBOARD</div>
            <div style={styles.brand}>Roomio</div>
          </div>
          <button
            onClick={handleLogout}
            style={styles.headerButton}
            title="Logout"
            className="tapButton"
          >
            Logout
          </button>
        </div>

        <div style={styles.card}>
          <div style={styles.cardTop}>
            <div style={styles.welcomeBlock}>
              <div style={styles.welcomeTitle}>Welcome, {safeGuestName} 👋</div>
              <div style={styles.welcomeSub}>Your room services are ready</div>
            </div>
            <div style={styles.roomBadge}>
              <div style={styles.roomBadgeIcon}>🏨</div>
              <div>
                <div style={styles.roomBadgeLabel}>ROOM</div>
                <div style={styles.roomBadgeValue}>{safeRoomNumber}</div>
              </div>
            </div>
          </div>

          <div style={styles.pillsRow} className="pillsRow">
            <div style={styles.pill}>
              <div style={styles.pillIconWrapBlue}>
                <span style={styles.pillIcon}>📱</span>
              </div>
              <div style={styles.pillText}>
                <div style={styles.pillLabel}>Registered Mobile</div>
                <div style={styles.pillValue}>{safeMobile}</div>
              </div>
            </div>
            <div style={styles.pill}>
              <div style={styles.pillIconWrapGreen}>
                <span style={styles.pillIcon}>🔒</span>
              </div>
              <div style={styles.pillText}>
                <div style={styles.pillLabel}>Session</div>
                <div style={styles.pillValueGreen}>
                  {sessionExpired ? "Expired" : "Active"}
                </div>
              </div>
            </div>
          </div>

          <div style={styles.adminStrip}>
            <div style={styles.adminLeft}>
              <div style={styles.adminIcon}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M3 21V9a2 2 0 0 1 2-2h3V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2h3a2 2 0 0 1 2 2v12" stroke="#2563EB" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M7 21v-4M12 21v-4M17 21v-4" stroke="#2563EB" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
              <div style={styles.adminText}>
                <div style={styles.adminLabel}>Hotel Admin</div>
                <div style={styles.adminValue}>{maskedAdmin}</div>
              </div>
            </div>
            <div style={styles.adminRight}>
              <div style={styles.statusDot} />
              <div style={styles.statusText}>Online</div>
            </div>
          </div>

          {toast ? <div style={styles.toast}>{toast}</div> : null}
        </div>

        <div style={styles.tabRow}>
          <button
            className="tapButton"
            onClick={() => setActiveTab("services")}
            style={{
              ...styles.tabBtn,
              ...(activeTab === "services" ? styles.tabBtnActive : null),
            }}
          >
            Services
          </button>
          <button
            className="tapButton"
            onClick={() => setActiveTab("requests")}
            style={{
              ...styles.tabBtn,
              ...(activeTab === "requests" ? styles.tabBtnActive : null),
            }}
          >
            Requests
            {requestIds.length ? (
              <span style={styles.tabBadge}>{requestIds.length}</span>
            ) : null}
          </button>
        </div>

        {activeTab === "services" ? (
          <div style={styles.grid} className="servicesGrid">
            {/* ✅ Navigate to Menu Page */}
            <ServiceCard
              icon="🍽"
              title="Food Menu"
              subtitle="Breakfast, Lunch, Dinner"
              accent="#16A34A"
              onClick={goToMenu}
            />

            <ServiceCard
              icon="🧺"
              title={laundryBlocked ? "Cooldown" : "Laundry"}
              subtitle={laundryBlocked ? formatRemaining(laundryRemainingMs) : "Pickup & delivery"}
              accent="#2563EB"
              disabled={sending || laundryBlocked}
              onClick={requestLaundryPickup}
            />

            <ServiceCard
              icon="🧹"
              title="Housekeeping"
              subtitle="Room cleaning"
              accent="#F59E0B"
              onClick={() => showToast("Request sent to housekeeping!")}
            />

            <ServiceCard
              icon="📞"
              title="Support"
              subtitle="Front desk help"
              accent="#6B7280"
              onClick={() => showToast("Front desk alerted!")}
            />
          </div>
        ) : null}

        {activeTab === "requests" ? (
          <>
            <div style={styles.sectionHeader}>
              <div style={styles.sectionLeft}>
                <div style={styles.sectionIcon}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path d="M6 2h12v20H6z" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
                    <path d="M9 6h6M9 10h6M9 14h6" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </div>
                <div style={styles.sectionTitle}>Request Tracker</div>
              </div>
              <button
                className="tapButton"
                onClick={clearRequestHistory}
                style={styles.clearBtn}
                disabled={!requestIds.length}
                title="Clear local history"
              >
                Clear
              </button>
            </div>

            {requestIds.length === 0 ? (
              <div style={styles.emptyBox}>
                <div style={styles.emptyTitle}>No requests yet</div>
                <div style={styles.emptySub}>
                  Send a service request and track it here in real-time.
                </div>
              </div>
            ) : (
              <div style={styles.reqList}>
                {requestsList.map((r) => {
                  const chip = statusChip(r.status);
                  return (
                    <div key={r.id} style={styles.reqCard}>
                      <div style={styles.reqTop}>
                        <div style={styles.reqType}>
                          {r.type || r.serviceType || "Service Request"}
                        </div>
                        <div style={{ ...styles.reqStatus, backgroundColor: chip.bg, color: chip.text }}>
                          {chip.label}
                        </div>
                      </div>
                      <div style={styles.reqMeta}>
                        Room {r.roomNumber ?? safeRoomNumber} • {formatTime(r.createdAt)}
                      </div>
                      <div style={styles.reqIdRow}>
                        <div style={styles.reqIdLabel}>ID</div>
                        <div style={styles.reqIdValue}>{r.id}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : null}

        <div style={styles.footer}>
          <div style={styles.footerRow}>
            <div style={styles.footerPill}>
              <div style={styles.footerDot} />
              <div style={styles.footerText}>System Operational</div>
            </div>
          </div>
          <div style={styles.versionRow}>
            <span style={styles.version}>VERSION 2.4.0</span>
            <span style={styles.versionDivider} />
            <span style={styles.version}>GUEST WEB</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ServiceCard({ icon, title, subtitle, accent, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="tapCard"
      style={{
        ...styles.serviceCard,
        borderLeftColor: accent,
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <div
        style={{ ...styles.serviceIconWrap, backgroundColor: `${accent}15` }}
        aria-hidden="true"
      >
        <span style={styles.serviceIcon}>{icon}</span>
      </div>
      <div style={styles.serviceText}>
        <div style={styles.serviceTitle}>{title}</div>
        <div style={styles.serviceSubtitle}>{subtitle}</div>
      </div>
      <div style={styles.serviceAction}>
        <span style={styles.serviceActionText}>Open</span>
        <span style={styles.serviceArrow}>→</span>
      </div>
    </button>
  );
}

function GlobalStyles() {
  return (
    <style>{`
      :root{ --sat: env(safe-area-inset-top, 0px); --sar: env(safe-area-inset-right, 0px); --sab: env(safe-area-inset-bottom, 0px); --sal: env(safe-area-inset-left, 0px); }
      html, body { margin: 0; padding: 0; background: #F9FAFB; }
      * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
      .safeArea { padding-top: calc(16px + var(--sat)); padding-left: calc(16px + var(--sal)); padding-right: calc(16px + var(--sar)); padding-bottom: calc(16px + var(--sab)); }
      @media (max-width: 520px) { .pillsRow { grid-template-columns: 1fr !important; } .servicesGrid { grid-template-columns: 1fr !important; } }
      .tapCard:active { transform: scale(0.99); }
      .tapCard { transition: transform 120ms ease, box-shadow 120ms ease; }
      .tapCard:hover { box-shadow: 0 10px 22px rgba(17, 24, 39, 0.10); }
      .tapButton:active { transform: scale(0.98); }
    `}</style>
  );
}

// ✅ Add expired session styles
const styles = {
  expiredContainer: {
    minHeight: "100vh",
    backgroundColor: "#F9FAFB",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,Arial,sans-serif'
  },
  expiredCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 24,
    border: "1px solid #E5E7EB",
    boxShadow: "0 12px 30px rgba(17, 24, 39, 0.08)",
    maxWidth: 400,
    width: "100%",
    textAlign: "center"
  },
  expiredIcon: {
    fontSize: 48,
    marginBottom: 16
  },
  expiredTitle: {
    fontSize: 22,
    fontWeight: 900,
    color: "#111827",
    marginBottom: 8
  },
  expiredMessage: {
    fontSize: 14,
    color: "#6B7280",
    marginBottom: 24,
    lineHeight: 1.5
  },
  expiredButton: {
    backgroundColor: "#2563EB",
    color: "#fff",
    border: "none",
    padding: "12px 24px",
    borderRadius: 12,
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
    width: "100%"
  },
  page: { minHeight: "100vh", backgroundColor: "#F9FAFB", position: "relative", overflow: "hidden", fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,Arial,sans-serif' },
  backgroundDecor: { position: "absolute", inset: 0, pointerEvents: "none" },
  bgCircle1: { position: "absolute", top: -100, right: -60, width: 220, height: 220, borderRadius: 110, backgroundColor: "rgba(37, 99, 235, 0.08)" },
  bgCircle2: { position: "absolute", top: 140, left: -100, width: 180, height: 180, borderRadius: 90, backgroundColor: "rgba(37, 99, 235, 0.05)" },
  bgCircle3: { position: "absolute", bottom: 20, right: -40, width: 140, height: 140, borderRadius: 70, backgroundColor: "rgba(37, 99, 235, 0.06)" },
  shell: { width: "100%", maxWidth: 640, margin: "0 auto", position: "relative", zIndex: 1 },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 },
  logoWrap: { width: 44, height: 44, borderRadius: 14, backgroundColor: "rgba(37, 99, 235, 0.10)", display: "flex", alignItems: "center", justifyContent: "center" },
  logoCircle: { width: 34, height: 34, borderRadius: 17, backgroundColor: "#2563EB", color: "#fff", fontWeight: 800, fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 6px 16px rgba(37, 99, 235, 0.25)" },
  headerText: { display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 },
  greeting: { fontSize: 11, fontWeight: 700, letterSpacing: 1.4, color: "#6B7280" },
  brand: { fontSize: 20, fontWeight: 800, color: "#111827" },
  headerButton: { height: 40, padding: "0 14px", borderRadius: 12, border: "1px solid #E5E7EB", backgroundColor: "#fff", color: "#DC2626", fontWeight: 800, cursor: "pointer", boxShadow: "0 2px 10px rgba(17, 24, 39, 0.05)" },
  card: { backgroundColor: "#fff", borderRadius: 20, padding: 18, border: "1px solid #E5E7EB", boxShadow: "0 12px 30px rgba(17, 24, 39, 0.08)", marginBottom: 14 },
  cardTop: { display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 14, flexWrap: "wrap" },
  welcomeBlock: { minWidth: 200 },
  welcomeTitle: { fontSize: 20, fontWeight: 900, color: "#111827", wordBreak: "break-word" },
  welcomeSub: { fontSize: 13, color: "#6B7280", marginTop: 4 },
  roomBadge: { display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 16, backgroundColor: "rgba(37, 99, 235, 0.10)", border: "1px solid rgba(37, 99, 235, 0.15)" },
  roomBadgeIcon: { fontSize: 20 },
  roomBadgeLabel: { fontSize: 10, fontWeight: 900, letterSpacing: 1.6, color: "#2563EB" },
  roomBadgeValue: { fontSize: 18, fontWeight: 900, color: "#2563EB" },
  pillsRow: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 },
  pill: { display: "flex", alignItems: "center", gap: 10, padding: 12, borderRadius: 16, border: "1px solid #E5E7EB", backgroundColor: "#F9FAFB", minWidth: 0 },
  pillIconWrapBlue: { width: 40, height: 40, borderRadius: 14, backgroundColor: "rgba(37, 99, 235, 0.10)", display: "flex", alignItems: "center", justifyContent: "center" },
  pillIconWrapGreen: { width: 40, height: 40, borderRadius: 14, backgroundColor: "rgba(22, 163, 74, 0.10)", display: "flex", alignItems: "center", justifyContent: "center" },
  pillIcon: { fontSize: 18 },
  pillLabel: { fontSize: 11, fontWeight: 800, color: "#6B7280" },
  pillValue: { fontSize: 13, fontWeight: 900, color: "#111827", marginTop: 2 },
  pillValueGreen: { fontSize: 13, fontWeight: 900, color: "#16A34A", marginTop: 2 },
  adminStrip: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, backgroundColor: "#F9FAFB", border: "1px solid #E5E7EB", borderRadius: 16, padding: 12, flexWrap: "wrap" },
  adminLeft: { display: "flex", gap: 10, alignItems: "center", minWidth: 0 },
  adminText: { minWidth: 0 },
  adminIcon: { width: 38, height: 38, borderRadius: 14, backgroundColor: "rgba(37, 99, 235, 0.08)", display: "flex", alignItems: "center", justifyContent: "center" },
  adminLabel: { fontSize: 11, color: "#6B7280", fontWeight: 800 },
  adminValue: { fontSize: 13, color: "#111827", fontWeight: 900 },
  adminRight: { display: "flex", gap: 8, alignItems: "center" },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#16A34A" },
  statusText: { fontSize: 12, fontWeight: 900, color: "#16A34A" },
  toast: { marginTop: 12, padding: 12, borderRadius: 14, backgroundColor: "rgba(22, 163, 74, 0.12)", border: "1px solid rgba(22, 163, 74, 0.25)", color: "#16A34A", fontWeight: 900, fontSize: 13, textAlign: "center" },
  tabRow: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 },
  tabBtn: { height: 44, borderRadius: 14, border: "1px solid #E5E7EB", backgroundColor: "#fff", fontWeight: 900, color: "#6B7280", cursor: "pointer", boxShadow: "0 2px 10px rgba(17, 24, 39, 0.05)" },
  tabBtnActive: { backgroundColor: "#2563EB", borderColor: "#2563EB", color: "#fff" },
  tabBadge: { marginLeft: 8, display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 18, height: 18, padding: "0 6px", borderRadius: 999, backgroundColor: "rgba(255,255,255,0.25)", color: "#fff", fontSize: 12, fontWeight: 900 },
  sectionHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 10, marginBottom: 10, flexWrap: "wrap" },
  sectionLeft: { display: "flex", alignItems: "center", gap: 10 },
  sectionIcon: { width: 30, height: 30, borderRadius: 10, backgroundColor: "#2563EB", display: "flex", alignItems: "center", justifyContent: "center" },
  sectionTitle: { fontSize: 16, fontWeight: 900, color: "#111827" },
  sectionBadge: { backgroundColor: "#fff", border: "1px solid #E5E7EB", padding: "6px 10px", borderRadius: 12, boxShadow: "0 2px 10px rgba(17, 24, 39, 0.05)" },
  sectionBadgeText: { color: "#2563EB", fontWeight: 900, fontSize: 12 },
  clearBtn: { height: 36, padding: "0 12px", borderRadius: 12, border: "1px solid #E5E7EB", backgroundColor: "#fff", color: "#6B7280", fontWeight: 900, cursor: "pointer" },
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  serviceCard: { width: "100%", textAlign: "left", padding: 14, borderRadius: 16, border: "1px solid #E5E7EB", backgroundColor: "#fff", boxShadow: "0 6px 18px rgba(17, 24, 39, 0.06)", cursor: "pointer", display: "flex", gap: 12, alignItems: "center", borderLeftWidth: 4, borderLeftStyle: "solid", minWidth: 0 },
  serviceIconWrap: { width: 44, height: 44, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center" },
  serviceIcon: { fontSize: 22 },
  serviceText: { flex: 1, minWidth: 0 },
  serviceTitle: { fontSize: 14, fontWeight: 900, color: "#111827" },
  serviceSubtitle: { fontSize: 12, color: "#6B7280", marginTop: 4 },
  serviceAction: { display: "flex", alignItems: "center", gap: 6, color: "#2563EB", fontWeight: 900, fontSize: 12 },
  serviceActionText: { color: "#2563EB" },
  serviceArrow: { fontSize: 16, marginTop: -1 },
  emptyBox: { backgroundColor: "#fff", border: "1px solid #E5E7EB", borderRadius: 16, padding: 16, boxShadow: "0 6px 18px rgba(17, 24, 39, 0.06)" },
  emptyTitle: { fontWeight: 900, color: "#111827" },
  emptySub: { marginTop: 6, color: "#6B7280", fontWeight: 700, fontSize: 12 },
  reqList: { display: "grid", gap: 10 },
  reqCard: { backgroundColor: "#fff", borderRadius: 16, border: "1px solid #E5E7EB", padding: 14, boxShadow: "0 6px 18px rgba(17, 24, 39, 0.06)" },
  reqTop: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 },
  reqType: { fontWeight: 900, color: "#111827", fontSize: 14 },
  reqStatus: { padding: "6px 10px", borderRadius: 999, fontWeight: 900, fontSize: 11, letterSpacing: 0.8 },
  reqMeta: { marginTop: 8, color: "#6B7280", fontWeight: 700, fontSize: 12 },
  reqIdRow: { marginTop: 10, display: "flex", gap: 6, alignItems: "center" },
  reqIdLabel: { fontSize: 11, fontWeight: 900, color: "#9CA3AF", letterSpacing: 1.1 },
  reqIdValue: { fontSize: 11, fontWeight: 900, color: "#2563EB", wordBreak: "break-word" },
  footer: { marginTop: 16, paddingBottom: 18 },
  footerRow: { display: "flex", justifyContent: "center", marginBottom: 10 },
  footerPill: { display: "flex", alignItems: "center", gap: 8, backgroundColor: "rgba(22, 163, 74, 0.10)", padding: "10px 14px", borderRadius: 999 },
  footerDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#16A34A" },
  footerText: { fontSize: 12, fontWeight: 800, color: "#16A34A" },
  versionRow: { display: "flex", justifyContent: "center", gap: 8, alignItems: "center" },
  version: { fontSize: 11, color: "#9CA3AF", fontWeight: 800, letterSpacing: 0.8 },
  versionDivider: { width: 4, height: 4, borderRadius: 2, backgroundColor: "#D1D5DB" },
};