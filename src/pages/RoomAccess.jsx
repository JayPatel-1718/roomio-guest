import { useNavigate, useSearchParams } from "react-router-dom";
import { useMemo, useState } from "react";
import { collection, query, where, getDocs, updateDoc, doc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";

export default function RoomAccess() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const adminEmail = params.get("admin");

  const [mobile, setMobile] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const maskedAdmin = useMemo(() => {
    if (!adminEmail) return "Unknown";
    const [name, domain] = adminEmail.split("@");
    if (!domain) return adminEmail;
    return `${name.slice(0, 2)}***@${domain}`;
  }, [adminEmail]);

  const handleContinue = async () => {
    setError("");

    if (!/^[0-9]{10}$/.test(mobile)) {
      setError("Enter a valid 10-digit mobile number");
      return;
    }

    if (!adminEmail) {
      setError("Invalid QR: admin missing");
      return;
    }

    setLoading(true);

    try {
      const q = query(
        collection(db, "guests"),
        where("adminEmail", "==", adminEmail),
        where("mobile", "==", mobile),
        where("isActive", "==", true)
      );

      const snap = await getDocs(q);

      if (snap.empty) {
        setError("No active booking found.");
        return;
      }

      const guestDoc = snap.docs[0];
      const guest = guestDoc.data();

      // ✅ CHECK IF ALREADY LOGGED IN
      if (guest.isLoggedIn) {
        setError("This mobile number is already logged in on another device.");
        return;
      }

      // ✅ UPDATE: Mark as logged in
      await updateDoc(guestDoc.ref, {
        isLoggedIn: true,
        lastLogin: serverTimestamp()
      });

      navigate("/dashboard", {
        state: {
          guestName: guest.guestName,
          roomNumber: guest.roomNumber,
          adminEmail,
          mobile,
          adminId: guest.adminId,
          guestDocId: guestDoc.id, // Store for logout
        },
      });
    } catch (e) {
      console.error("VERIFY ERROR:", e);
      setError(e?.message || "Failed to verify guest");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.page}>
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
            <div style={styles.greeting}>GUEST ACCESS</div>
            <div style={styles.title}>Roomio</div>
          </div>

          <div style={styles.badge}>
            <span style={styles.badgeDot} />
            <span style={styles.badgeText}>SECURE</span>
          </div>
        </div>

        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <div style={styles.cardIcon}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path
                  d="M7 10V7a5 5 0 0 1 10 0v3"
                  stroke="#2563EB"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <path
                  d="M6 10h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z"
                  stroke="#2563EB"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div>
              <div style={styles.cardTitle}>Room Access</div>
              <div style={styles.cardSubtitle}>
                Enter your registered mobile number to continue
              </div>
            </div>
          </div>

          <div style={styles.infoPill}>
            <div style={styles.infoLeft}>
              <div style={styles.infoIcon}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M3 21V9a2 2 0 0 1 2-2h3V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2h3a2 2 0 0 1 2 2v12"
                    stroke="#2563EB"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M7 21v-4M12 21v-4M17 21v-4"
                    stroke="#2563EB"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              <div>
                <div style={styles.infoLabel}>Hotel Admin</div>
                <div style={styles.infoValue}>{maskedAdmin}</div>
              </div>
            </div>
            <div style={styles.infoRight}>
              <div style={styles.statusDot} />
              <div style={styles.statusText}>Online</div>
            </div>
          </div>

          <div style={styles.field}>
            <div style={styles.label}>Mobile Number</div>
            <div style={styles.inputWrap}>
              <div style={styles.inputIcon}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M7 2h10v20H7z"
                    stroke="#2563EB"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M10 19h4"
                    stroke="#2563EB"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </div>

              <input
                type="tel"
                inputMode="numeric"
                value={mobile}
                maxLength={10}
                onChange={(e) => setMobile(e.target.value.replace(/\D/g, ""))}
                placeholder="Enter 10-digit mobile number"
                style={styles.input}
              />
            </div>

            {error ? (
              <div style={styles.errorBox}>
                <div style={styles.errorIcon}>!</div>
                <div style={styles.errorText}>{error}</div>
              </div>
            ) : (
              <div style={styles.helper}>
                Tip: use the same number registered at reception
              </div>
            )}
          </div>

          <button
            onClick={handleContinue}
            style={{
              ...styles.button,
              ...(loading ? styles.buttonDisabled : null),
            }}
            disabled={loading}
          >
            <span style={styles.buttonRow}>
              {loading ? (
                <>
                  <span style={styles.spinner} aria-hidden="true" />
                  <span>Verifying...</span>
                </>
              ) : (
                <>
                  <span>Continue</span>
                  <span style={styles.arrow} aria-hidden="true">
                    →
                  </span>
                </>
              )}
            </span>
          </button>

          <div style={styles.securityNotice}>
            <span style={styles.securityIcon} aria-hidden="true">
              🔒
            </span>
            <span style={styles.securityText}>Secured guest verification</span>
          </div>
        </div>

        <div style={styles.footer}>
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

const styles = {
  page: {
    minHeight: "100vh",
    backgroundColor: "#F9FAFB",
    position: "relative",
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    fontFamily:
      '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,Arial,sans-serif',
  },
  backgroundDecor: { position: "absolute", inset: 0, pointerEvents: "none" },
  bgCircle1: { position: "absolute", top: -100, right: -60, width: 220, height: 220, borderRadius: 110, backgroundColor: "rgba(37, 99, 235, 0.08)" },
  bgCircle2: { position: "absolute", top: 140, left: -100, width: 180, height: 180, borderRadius: 90, backgroundColor: "rgba(37, 99, 235, 0.05)" },
  bgCircle3: { position: "absolute", bottom: 20, right: -40, width: 140, height: 140, borderRadius: 70, backgroundColor: "rgba(37, 99, 235, 0.06)" },

  shell: { width: "100%", maxWidth: 420, position: "relative", zIndex: 1 },

  header: { display: "flex", alignItems: "center", justifyContent: "space-between", flexDirection: "row", marginBottom: 14 },
  logoWrap: { width: 44, height: 44, borderRadius: 14, backgroundColor: "rgba(37, 99, 235, 0.10)", display: "flex", alignItems: "center", justifyContent: "center" },
  logoCircle: { width: 34, height: 34, borderRadius: 17, backgroundColor: "#2563EB", color: "#FFFFFF", fontWeight: 800, fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 6px 16px rgba(37, 99, 235, 0.25)" },
  headerText: { display: "flex", flexDirection: "column", gap: 2 },
  greeting: { fontSize: 11, fontWeight: 700, letterSpacing: 1.4, color: "#6B7280" },
  title: { fontSize: 20, fontWeight: 800, color: "#111827", lineHeight: "22px" },
  badge: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 999, backgroundColor: "rgba(22, 163, 74, 0.10)", border: "1px solid rgba(22, 163, 74, 0.20)" },
  badgeDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#16A34A" },
  badgeText: { fontSize: 11, fontWeight: 800, color: "#16A34A", letterSpacing: 1 },

  card: { backgroundColor: "#FFFFFF", borderRadius: 20, padding: 18, border: "1px solid #E5E7EB", boxShadow: "0 12px 30px rgba(17, 24, 39, 0.08)" },
  cardHeader: { display: "flex", flexDirection: "row", gap: 12, alignItems: "center", marginBottom: 14 },
  cardIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: "rgba(37, 99, 235, 0.10)", display: "flex", alignItems: "center", justifyContent: "center" },
  cardTitle: { fontSize: 18, fontWeight: 800, color: "#111827", marginBottom: 2 },
  cardSubtitle: { fontSize: 13, color: "#6B7280", lineHeight: "18px" },

  infoPill: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, backgroundColor: "#F9FAFB", border: "1px solid #E5E7EB", borderRadius: 16, padding: 12, marginBottom: 14 },
  infoLeft: { display: "flex", flexDirection: "row", gap: 10, alignItems: "center" },
  infoIcon: { width: 38, height: 38, borderRadius: 14, backgroundColor: "rgba(37, 99, 235, 0.08)", display: "flex", alignItems: "center", justifyContent: "center" },
  infoLabel: { fontSize: 11, color: "#6B7280", fontWeight: 700 },
  infoValue: { fontSize: 13, color: "#111827", fontWeight: 800 },
  infoRight: { display: "flex", flexDirection: "row", alignItems: "center", gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#16A34A" },
  statusText: { fontSize: 12, fontWeight: 700, color: "#16A34A" },

  field: { textAlign: "left" },
  label: { fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 8 },
  inputWrap: { display: "flex", flexDirection: "row", alignItems: "center", borderRadius: 14, border: "1.5px solid #E5E7EB", backgroundColor: "#F9FAFB", overflow: "hidden" },
  inputIcon: { width: 48, height: 52, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(37, 99, 235, 0.05)" },
  input: { flex: 1, border: "none", outline: "none", backgroundColor: "transparent", padding: "16px 12px", fontSize: 16, color: "#111827" },
  helper: { marginTop: 10, fontSize: 12, color: "#9CA3AF" },

  errorBox: { marginTop: 10, display: "flex", flexDirection: "row", gap: 10, alignItems: "center", backgroundColor: "rgba(220, 38, 38, 0.10)", border: "1px solid rgba(220, 38, 38, 0.18)", borderRadius: 12, padding: 12 },
  errorIcon: { width: 22, height: 22, borderRadius: 11, backgroundColor: "#DC2626", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 13, flexShrink: 0 },
  errorText: { color: "#DC2626", fontWeight: 700, fontSize: 13 },

  button: { marginTop: 16, width: "100%", height: 54, borderRadius: 14, border: "none", backgroundColor: "#2563EB", color: "#FFFFFF", fontSize: 16, fontWeight: 800, cursor: "pointer", boxShadow: "0 10px 18px rgba(37, 99, 235, 0.25)" },
  buttonDisabled: { opacity: 0.75, cursor: "not-allowed" },
  buttonRow: { display: "inline-flex", alignItems: "center", gap: 10, justifyContent: "center" },
  arrow: { fontSize: 18, marginTop: -1 },

  spinner: { width: 16, height: 16, borderRadius: 999, border: "2px solid rgba(255,255,255,0.45)", borderTopColor: "#FFFFFF", display: "inline-block", animation: "spin 0.9s linear infinite" },

  securityNotice: { marginTop: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "#6B7280", fontSize: 12 },
  securityIcon: { fontSize: 14 },
  securityText: { fontWeight: 700 },

  footer: { marginTop: 14, display: "flex", justifyContent: "center" },
  versionRow: { display: "flex", alignItems: "center", gap: 8, justifyContent: "center" },
  version: { fontSize: 11, color: "#9CA3AF", fontWeight: 700, letterSpacing: 0.8 },
  versionDivider: { width: 4, height: 4, borderRadius: 2, backgroundColor: "#D1D5DB" },
};

// Inject keyframes for spinner once
if (typeof document !== "undefined" && !document.getElementById("spin-kf")) {
  const styleEl = document.createElement("style");
  styleEl.id = "spin-kf";
  styleEl.innerHTML = `@keyframes spin { to { transform: rotate(360deg); } }`;
  document.head.appendChild(styleEl);
}