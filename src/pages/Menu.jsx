import { useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  collection,
  query,
  onSnapshot,
  addDoc,
  serverTimestamp,
  getDocs,
} from "firebase/firestore";
import { db } from "../firebase";

export default function Menu() {
  const { state } = useLocation();
  const navigate = useNavigate();

  const [menuItems, setMenuItems] = useState([]);
  const [cart, setCart] = useState({}); // { itemId: count }
  const [ordering, setOrdering] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const { adminId, roomNumber, guestName } = state || {};

  useEffect(() => {
    if (!state) navigate("/guest");
  }, [state, navigate]);

  // Fetch menu items from admin's menuItems collection
  useEffect(() => {
    if (!adminId) {
      setLoading(false);
      setError("No admin ID provided");
      return;
    }

    console.log("🔍 Fetching menu items for adminId:", adminId);
    console.log("📍 Path:", `users/${adminId}/menuItems`);
    setLoading(true);
    setError(null);

    // Try with real-time listener first
    const menuRef = collection(db, "users", adminId, "menuItems");
    const q = query(menuRef);

    const unsub = onSnapshot(
      q,
      (snapshot) => {
        console.log("📦 Snapshot received, size:", snapshot.size);
        
        if (snapshot.empty) {
          console.log("⚠️ No menu items found");
          setMenuItems([]);
          setLoading(false);
          return;
        }

        const items = [];
        snapshot.forEach((doc) => {
          const data = doc.data();
          console.log("📄 Menu item:", doc.id, data);
          
          // Only include available items
          if (data.isAvailable !== false) {
            items.push({
              id: doc.id,
              ...data,
            });
          }
        });

        console.log("✅ Total available items:", items.length);
        setMenuItems(items);
        setLoading(false);
      },
      (err) => {
        console.error("❌ Firestore error:", err);
        console.error("Error code:", err.code);
        console.error("Error message:", err.message);
        
        // Provide helpful error messages
        if (err.code === "permission-denied") {
          setError(
            "Permission denied. Please check Firebase security rules. The menu items path must allow public read access."
          );
        } else {
          setError(`Error: ${err.message}`);
        }
        setLoading(false);
      }
    );

    return () => {
      console.log("🧹 Cleaning up menu listener");
      unsub();
    };
  }, [adminId]);

  // Get unique categories from menu items
  const categories = ["all", ...new Set(menuItems.map((item) => item.category).filter(Boolean))];

  // Filter items by category
  const filteredItems =
    selectedCategory === "all"
      ? menuItems
      : menuItems.filter((item) => item.category === selectedCategory);

  const addToCart = (itemId) => {
    setCart((prev) => ({
      ...prev,
      [itemId]: (prev[itemId] || 0) + 1,
    }));
  };

  const removeFromCart = (itemId) => {
    setCart((prev) => {
      const newCart = { ...prev };
      if (newCart[itemId] > 1) {
        newCart[itemId] -= 1;
      } else {
        delete newCart[itemId];
      }
      return newCart;
    });
  };

  const totalAmount = Object.entries(cart).reduce((sum, [id, count]) => {
    const item = menuItems.find((m) => m.id === id);
    return sum + (item?.price || 0) * count;
  }, 0);

  const placeOrder = async () => {
    if (!adminId) {
      alert("Missing admin ID");
      return;
    }
    
    if (Object.keys(cart).length === 0) {
      alert("Your cart is empty!");
      return;
    }

    setOrdering(true);

    try {
      const items = Object.entries(cart).map(([id, count]) => {
        const item = menuItems.find((m) => m.id === id);
        return {
          name: item?.name || "Unknown",
          price: item?.price || 0,
          count,
          category: item?.category || "unknown",
        };
      });

      console.log("📤 Placing order:", {
        roomNumber,
        guestName,
        items,
        totalPrice: totalAmount,
      });

      const orderRef = collection(db, "users", adminId, "foodOrders");
      await addDoc(orderRef, {
        roomNumber: roomNumber || "N/A",
        guestName: guestName || "Guest",
        item: items.map((i) => `${i.count}x ${i.name}`).join(", "),
        details: items,
        totalPrice: totalAmount,
        progress: 0,
        status: "pending",
        createdAt: serverTimestamp(),
      });

      console.log("✅ Order placed successfully");
      alert("✅ Order placed successfully!");
      setCart({}); // Clear cart
      navigate("/dashboard", { state }); // Go back to dashboard with state
    } catch (e) {
      console.error("❌ Error placing order:", e);
      console.error("Error code:", e.code);
      console.error("Error message:", e.message);
      
      if (e.code === "permission-denied") {
        alert("Permission denied. Please check Firebase security rules for foodOrders.");
      } else {
        alert("Failed to place order: " + e.message);
      }
    } finally {
      setOrdering(false);
    }
  };

  const getCategoryLabel = (category) => {
    const labels = {
      breakfast: "🍳 Breakfast",
      lunch: "🍱 Lunch",
      dinner: "🍽️ Dinner",
      all: "All Items",
    };
    return labels[category] || category;
  };

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <button
          onClick={() => navigate("/dashboard", { state })}
          style={styles.backBtn}
        >
          ← Back
        </button>
        <div style={styles.title}>Food Menu</div>
        <div style={{ width: 40 }} /> {/* Spacer */}
      </div>

      {/* Loading State */}
      {loading && (
        <div style={styles.loadingState}>
          <div style={styles.spinner}>⏳</div>
          <div style={styles.loadingText}>Loading menu...</div>
          <div style={styles.loadingSubtext}>Connecting to database...</div>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div style={styles.errorState}>
          <div style={styles.errorIcon}>⚠️</div>
          <div style={styles.errorText}>Cannot Load Menu</div>
          <div style={styles.errorSubtext}>{error}</div>
          <div style={styles.errorHelp}>
            <strong>Troubleshooting:</strong>
            <ul style={styles.errorList}>
              <li>Check Firebase console security rules</li>
              <li>Ensure menuItems collection has public read access</li>
              <li>Verify adminId: {adminId}</li>
            </ul>
          </div>
          <button
            onClick={() => window.location.reload()}
            style={styles.retryBtn}
          >
            🔄 Retry
          </button>
        </div>
      )}

      {/* Content */}
      {!loading && !error && (
        <>
          {/* Categories */}
          {menuItems.length > 0 && (
            <div style={styles.categories}>
              {categories.map((cat) => (
                <div
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  style={{
                    ...styles.categoryTab,
                    ...(selectedCategory === cat ? styles.categoryTabActive : {}),
                  }}
                >
                  {getCategoryLabel(cat)}
                </div>
              ))}
            </div>
          )}

          {/* Menu List */}
          <div style={styles.menuList}>
            {filteredItems.length === 0 && menuItems.length > 0 ? (
              <div style={styles.empty}>
                No {getCategoryLabel(selectedCategory).toLowerCase()} items
                available.
              </div>
            ) : (
              filteredItems.map((item) => (
                <div key={item.id} style={styles.menuItem}>
                  <div style={styles.itemInfo}>
                    <div style={styles.itemName}>{item.name || "Unnamed Item"}</div>
                    {item.description && (
                      <div style={styles.itemDesc}>{item.description}</div>
                    )}
                    <div style={styles.itemPrice}>
                      ₹{typeof item.price === "number" ? item.price : "—"}
                    </div>
                    {item.category && (
                      <div style={styles.categoryBadge}>
                        {getCategoryLabel(item.category)}
                      </div>
                    )}
                  </div>
                  <div style={styles.itemActions}>
                    <button
                      onClick={() => removeFromCart(item.id)}
                      style={{
                        ...styles.minusBtn,
                        opacity: !cart[item.id] ? 0.5 : 1,
                        cursor: !cart[item.id] ? "not-allowed" : "pointer",
                      }}
                      disabled={!cart[item.id]}
                    >
                      -
                    </button>
                    <span style={styles.quantity}>{cart[item.id] || 0}</span>
                    <button onClick={() => addToCart(item.id)} style={styles.plusBtn}>
                      +
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Cart Footer */}
          {totalAmount > 0 && (
            <div style={styles.footer}>
              <div style={styles.cartInfo}>
                <div style={styles.totalRow}>
                  <span>Total:</span>
                  <span style={styles.totalValue}>₹{totalAmount}</span>
                </div>
                <div style={styles.itemCount}>
                  {Object.values(cart).reduce((sum, count) => sum + count, 0)}{" "}
                  items
                </div>
              </div>
              <button
                onClick={placeOrder}
                disabled={ordering}
                style={{
                  ...styles.orderBtn,
                  opacity: ordering ? 0.7 : 1,
                  cursor: ordering ? "not-allowed" : "pointer",
                }}
              >
                {ordering ? "Placing Order..." : "🛒 Place Order"}
              </button>
            </div>
          )}

          {/* Empty State */}
          {menuItems.length === 0 && (
            <div style={styles.emptyState}>
              <div style={styles.emptyIcon}>🍽️</div>
              <div style={styles.emptyText}>No Menu Items Available</div>
              <div style={styles.emptySubtext}>
                The hotel hasn't added any menu items yet. Please check back later
                or contact the front desk.
              </div>
              <div style={styles.debugInfo}>
                <div><strong>Debug Info:</strong></div>
                <div>Admin ID: {adminId || "Not set"}</div>
                <div>Room: {roomNumber || "Not set"}</div>
                <div>Guest: {guestName || "Not set"}</div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    backgroundColor: "#F9FAFB",
    padding: 16,
    fontFamily:
      '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,Arial,sans-serif',
    position: "relative",
    overflowY: "auto",
    paddingBottom: 120,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  backBtn: {
    background: "none",
    border: "none",
    fontSize: 16,
    color: "#2563EB",
    fontWeight: "bold",
    cursor: "pointer",
    textDecoration: "underline",
  },
  title: {
    fontSize: 20,
    fontWeight: "bold",
    textAlign: "center",
  },

  loadingState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 100,
    textAlign: "center",
    gap: 12,
  },
  spinner: {
    fontSize: 48,
  },
  loadingText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#6B7280",
  },
  loadingSubtext: {
    fontSize: 14,
    color: "#9CA3AF",
  },

  errorState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 60,
    textAlign: "center",
    gap: 12,
    padding: 20,
    maxWidth: 500,
    margin: "60px auto",
  },
  errorIcon: {
    fontSize: 64,
  },
  errorText: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#DC2626",
    marginTop: 16,
  },
  errorSubtext: {
    fontSize: 14,
    color: "#6B7280",
    lineHeight: 1.5,
    marginTop: 8,
    padding: "12px 16px",
    backgroundColor: "#FEE2E2",
    borderRadius: 8,
    border: "1px solid #FCA5A5",
  },
  errorHelp: {
    fontSize: 13,
    color: "#374151",
    textAlign: "left",
    marginTop: 16,
    padding: 16,
    backgroundColor: "#F3F4F6",
    borderRadius: 8,
    width: "100%",
  },
  errorList: {
    textAlign: "left",
    marginTop: 8,
    paddingLeft: 20,
  },
  retryBtn: {
    marginTop: 16,
    padding: "12px 24px",
    backgroundColor: "#2563EB",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: "600",
    cursor: "pointer",
  },

  categories: {
    display: "flex",
    gap: 8,
    marginBottom: 16,
    flexWrap: "wrap",
  },
  categoryTab: {
    padding: "8px 16px",
    borderRadius: 20,
    backgroundColor: "#fff",
    color: "#6B7280",
    fontWeight: "600",
    fontSize: 14,
    cursor: "pointer",
    border: "1px solid #E5E7EB",
    transition: "all 0.2s",
  },
  categoryTabActive: {
    backgroundColor: "rgba(37, 99, 235, 0.1)",
    color: "#2563EB",
    borderColor: "#2563EB",
    fontWeight: "bold",
  },

  menuList: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    marginBottom: 20,
  },
  menuItem: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    borderRadius: 12,
    backgroundColor: "#fff",
    boxShadow: "0 2px 8px rgba(0,0,0,0.05)",
    border: "1px solid #E5E7EB",
  },
  itemInfo: {
    flex: 1,
    minWidth: 0,
    marginRight: 12,
  },
  itemName: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#111827",
    marginBottom: 4,
  },
  itemDesc: {
    fontSize: 13,
    color: "#6B7280",
    marginTop: 4,
    marginBottom: 6,
    lineHeight: 1.4,
  },
  itemPrice: {
    fontSize: 15,
    color: "#16A34A",
    fontWeight: "bold",
    marginTop: 4,
  },
  categoryBadge: {
    display: "inline-block",
    padding: "4px 10px",
    borderRadius: 12,
    backgroundColor: "#F3F4F6",
    color: "#6B7280",
    fontSize: 11,
    fontWeight: "600",
    marginTop: 6,
    textTransform: "capitalize",
  },
  itemActions: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
  },
  minusBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(220, 38, 38, 0.1)",
    color: "#DC2626",
    border: "1px solid #DC2626",
    fontSize: 18,
    fontWeight: "bold",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  plusBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(37, 99, 235, 0.1)",
    color: "#2563EB",
    border: "1px solid #2563EB",
    fontSize: 18,
    fontWeight: "bold",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  quantity: {
    width: 28,
    textAlign: "center",
    fontWeight: "bold",
    fontSize: 14,
    color: "#111827",
  },

  footer: {
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#fff",
    borderTop: "2px solid #E5E7EB",
    boxShadow: "0 -4px 12px rgba(0,0,0,0.08)",
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  cartInfo: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  totalRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 16,
    fontWeight: "bold",
  },
  totalValue: {
    color: "#16A34A",
    fontSize: 20,
    fontWeight: "900",
  },
  itemCount: {
    fontSize: 13,
    color: "#6B7280",
    fontWeight: "600",
  },
  orderBtn: {
    width: "100%",
    padding: 14,
    borderRadius: 12,
    backgroundColor: "#16A34A",
    color: "#fff",
    border: "none",
    fontWeight: "bold",
    fontSize: 16,
    transition: "background-color 0.2s",
    boxShadow: "0 4px 12px rgba(22, 163, 74, 0.25)",
  },

  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 80,
    textAlign: "center",
    gap: 8,
  },
  emptyIcon: {
    fontSize: 64,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#6B7280",
    marginTop: 16,
  },
  emptySubtext: {
    fontSize: 14,
    color: "#9CA3AF",
    maxWidth: 300,
    lineHeight: 1.5,
    marginTop: 8,
  },
  debugInfo: {
    marginTop: 24,
    padding: 16,
    backgroundColor: "#F3F4F6",
    borderRadius: 8,
    color: "#374151",
    fontSize: 12,
    textAlign: "left",
    width: "100%",
    maxWidth: 300,
    lineHeight: 1.6,
  },

  empty: {
    textAlign: "center",
    color: "#6B7280",
    fontSize: 14,
    padding: 20,
    marginTop: 20,
  },
};