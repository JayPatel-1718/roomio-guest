import { useSearchParams, useNavigate } from "react-router-dom";
import { useState } from "react";

export default function GuestAccess() {
  const [searchParams] = useSearchParams();
  const admin = searchParams.get("admin");
  const navigate = useNavigate();

  const [mobile, setMobile] = useState("");

  const handleContinue = () => {
    navigate(`/dashboard?admin=${admin}&mobile=${mobile}`);
  };

  return (
    <div style={styles.container}>
      <h2 style={styles.brand}>Roomio</h2>

      <h1 style={styles.title}>Room Access</h1>
      <p style={styles.subtitle}>
        Please enter your registered mobile number to unlock your room features.
      </p>

      <div style={styles.icon}>🚪</div>

      <label style={styles.label}>Mobile Number</label>
      <input
        type="tel"
        placeholder="Enter registered mobile number"
        value={mobile}
        onChange={(e) => setMobile(e.target.value)}
        style={styles.input}
      />

      <p style={styles.error}>Invalid or expired access code</p>

      <button style={styles.button} onClick={handleContinue}>
        Continue
      </button>

      <p style={styles.support}>
        Having trouble? <span style={styles.link}>Contact Support</span>
      </p>
    </div>
  );
}

const styles = {
  container: {
    minHeight: "100vh",
    padding: 24,
    maxWidth: 420,
    margin: "0 auto",
    fontFamily: "sans-serif",
  },
  brand: {
    textAlign: "center",
    marginBottom: 40,
  },
  title: {
    fontSize: 26,
    fontWeight: 700,
  },
  subtitle: {
    color: "#6b7280",
    marginTop: 6,
  },
  icon: {
    fontSize: 40,
    margin: "30px 0",
    textAlign: "center",
  },
  label: {
    fontWeight: 600,
  },
  input: {
    width: "100%",
    padding: 14,
    marginTop: 8,
    borderRadius: 10,
    border: "1px solid #d1d5db",
    fontSize: 14,
  },
  error: {
    color: "#ef4444",
    fontSize: 13,
    marginTop: 8,
  },
  button: {
    marginTop: 20,
    width: "100%",
    padding: 14,
    borderRadius: 12,
    backgroundColor: "#2563EB",
    color: "#fff",
    border: "none",
    fontSize: 16,
    fontWeight: 600,
  },
  support: {
    marginTop: 30,
    textAlign: "center",
    fontSize: 13,
  },
  link: {
    color: "#2563EB",
    fontWeight: 600,
  },
};
