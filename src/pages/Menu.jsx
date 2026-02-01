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
  const [cart, setCart] = useState({});
  const [ordering, setOrdering] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const { adminId, roomNumber, guestName } = state || {};

  useEffect(() => {
    if (!state) navigate("/guest");
  }, [state, navigate]);

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

  const categories = ["all", ...new Set(menuItems.map((item) => item.category).filter(Boolean))];

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
      setCart({});
      navigate("/dashboard", { state });
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

  const totalItems = Object.values(cart).reduce((sum, count) => sum + count, 0);

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
        <div style={styles.cartBadge}>
          {totalItems > 0 && <span style={styles.badge}>{totalItems}</span>}
        </div>
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
            <div style={styles.categoriesContainer}>
              <div style={styles.categories}>
                {categories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    style={{
                      ...styles.categoryTab,
                      ...(selectedCategory === cat ? styles.categoryTabActive : {}),
                    }}
                  >
                    {getCategoryLabel(cat)}
                  </button>
                ))}
              </div>
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
                  <div style={styles.itemContent}>
                    <div style={styles.itemHeader}>
                      <div style={styles.itemName}>{item.name || "Unnamed Item"}</div>
                      <div style={styles.itemPrice}>
                        ₹{typeof item.price === "number" ? item.price : "—"}
                      </div>
                    </div>
                    {item.description && (
                      <div style={styles.itemDesc}>{item.description}</div>
                    )}
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
                      −
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

      {/* Cart Footer */}
      {totalAmount > 0 && (
        <div style={styles.footer}>
          <div style={styles.cartInfo}>
            <div style={styles.cartLeft}>
              <div style={styles.totalLabel}>Total</div>
              <div style={styles.totalValue}>₹{totalAmount.toFixed(2)}</div>
            </div>
            <div style={styles.itemCount}>
              {totalItems} {totalItems === 1 ? "item" : "items"}
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
            {ordering ? "⏳ Placing..." : "🛒 Place Order"}
          </button>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    backgroundColor: "#F9FAFB",
    padding: "12px 12px",
    fontFamily:
      '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,Arial,sans-serif',
    position: "relative",
    overflowY: "auto",
    WebkitTouchCallout: "none",
    WebkitUserSelect: "none",
    paddingBottom: totalAmount > 0 ? "140px" : "24px",
  },
  
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "16px",
    paddingTop: "8px",
  },
  
  backBtn: {
    background: "none",
    border: "none",
    fontSize: "16px",
    color: "#2563EB",
    fontWeight: "600",
    cursor: "pointer",
    padding: "8px",
    borderRadius: "8px",
    transition: "background-color 0.2s",
    WebkitTouchCallout: "none",
  },
  
  title: {
    fontSize: "20px",
    fontWeight: "700",
    textAlign: "center",
    flex: 1,
    color: "#111827",
  },
  
  cartBadge: {
    width: "40px",
    display: "flex",
    justifyContent: "flex-end",
    alignItems: "center",
  },
  
  badge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#DC2626",
    color: "#fff",
    borderRadius: "50%",
    width: "24px",
    height: "24px",
    fontSize: "12px",
    fontWeight: "700",
  },

  loadingState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    marginTop: "100px",
    textAlign: "center",
    gap: "12px",
  },
  
  spinner: {
    fontSize: "48px",
    animation: "spin 2s linear infinite",
  },
  
  loadingText: {
    fontSize: "16px",
    fontWeight: "600",
    color: "#6B7280",
  },
  
  loadingSubtext: {
    fontSize: "14px",
    color: "#9CA3AF",
  },

  errorState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    marginTop: "40px",
    textAlign: "center",
    gap: "12px",
    padding: "16px",
  },
  
  errorIcon: {
    fontSize: "56px",
    marginBottom: "8px",
  },
  
  errorText: {
    fontSize: "18px",
    fontWeight: "700",
    color: "#DC2626",
    marginTop: "8px",
  },
  
  errorSubtext: {
    fontSize: "13px",
    color: "#6B7280",
    lineHeight: 1.6,
    marginTop: "8px",
    padding: "12px 14px",
    backgroundColor: "#FEE2E2",
    borderRadius: "8px",
    border: "1px solid #FCA5A5",
    width: "100%",
  },
  
  errorHelp: {
    fontSize: "12px",
    color: "#374151",
    textAlign: "left",
    marginTop: "12px",
    padding: "12px",
    backgroundColor: "#F3F4F6",
    borderRadius: "8px",
    width: "100%",
  },
  
  errorList: {
    textAlign: "left",
    marginTop: "8px",
    paddingLeft: "16px",
    lineHeight: 1.8,
    fontSize: "12px",
  },
  
  retryBtn: {
    marginTop: "16px",
    padding: "10px 20px",
    backgroundColor: "#2563EB",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: "600",
    cursor: "pointer",
    transition: "background-color 0.2s",
  },

  categoriesContainer: {
    marginBottom: "16px",
    paddingBottom: "8px",
  },
  
  categories: {
    display: "flex",
    gap: "8px",
    overflowX: "auto",
    paddingBottom: "4px",
    WebkitOverflowScrolling: "touch",
    scrollBehavior: "smooth",
  },
  
  categoryTab: {
    padding: "8px 14px",
    borderRadius: "20px",
    backgroundColor: "#fff",
    color: "#6B7280",
    fontWeight: "600",
    fontSize: "13px",
    cursor: "pointer",
    border: "1px solid #E5E7EB",
    transition: "all 0.2s",
    whiteSpace: "nowrap",
    flexShrink: 0,
    WebkitTouchCallout: "none",
  },
  
  categoryTabActive: {
    backgroundColor: "rgba(37, 99, 235, 0.1)",
    color: "#2563EB",
    borderColor: "#2563EB",
    fontWeight: "700",
  },

  menuList: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    marginBottom: "20px",
  },
  
  menuItem: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    padding: "14px",
    borderRadius: "12px",
    backgroundColor: "#fff",
    boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
    border: "1px solid #E5E7EB",
    gap: "12px",
    transition: "box-shadow 0.2s",
  },
  
  itemContent: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
  
  itemHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "8px",
  },
  
  itemName: {
    fontSize: "15px",
    fontWeight: "700",
    color: "#111827",
    flex: 1,
    lineHeight: 1.3,
  },
  
  itemDesc: {
    fontSize: "12px",
    color: "#6B7280",
    lineHeight: 1.4,
    marginTop: "2px",
  },
  
  itemPrice: {
    fontSize: "14px",
    color: "#16A34A",
    fontWeight: "700",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  
  categoryBadge: {
    display: "inline-block",
    padding: "4px 8px",
    borderRadius: "10px",
    backgroundColor: "#F3F4F6",
    color: "#6B7280",
    fontSize: "11px",
    fontWeight: "600",
    textTransform: "capitalize",
    width: "fit-content",
  },
  
  itemActions: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    flexShrink: 0,
  },
  
  minusBtn: {
    width: "32px",
    height: "32px",
    borderRadius: "8px",
    backgroundColor: "rgba(220, 38, 38, 0.1)",
    color: "#DC2626",
    border: "1px solid #DC2626",
    fontSize: "18px",
    fontWeight: "700",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    transition: "all 0.2s",
    WebkitTouchCallout: "none",
    padding: 0,
  },
  
  plusBtn: {
    width: "32px",
    height: "32px",
    borderRadius: "8px",
    backgroundColor: "rgba(37, 99, 235, 0.1)",
    color: "#2563EB",
    border: "1px solid #2563EB",
    fontSize: "18px",
    fontWeight: "700",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "all 0.2s",
    WebkitTouchCallout: "none",
    padding: 0,
  },
  
  quantity: {
    width: "28px",
    textAlign: "center",
    fontWeight: "700",
    fontSize: "14px",
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
    padding: "12px 12px 16px 12px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    zIndex: 1000,
    animation: "slideUp 0.3s ease-out",
  },
  
  cartInfo: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    paddingX: "4px",
  },
  
  cartLeft: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  
  totalLabel: {
    fontSize: "12px",
    color: "#6B7280",
    fontWeight: "600",
  },
  
  totalValue: {
    color: "#16A34A",
    fontSize: "20px",
    fontWeight: "900",
    lineHeight: 1.2,
  },
  
  itemCount: {
    fontSize: "13px",
    color: "#6B7280",
    fontWeight: "600",
    textAlign: "right",
  },
  
  orderBtn: {
    width: "100%",
    padding: "14px 16px",
    borderRadius: "10px",
    backgroundColor: "#16A34A",
    color: "#fff",
    border: "none",
    fontWeight: "700",
    fontSize: "15px",
    transition: "background-color 0.2s",
    boxShadow: "0 4px 12px rgba(22, 163, 74, 0.25)",
    cursor: "pointer",
    WebkitTouchCallout: "none",
  },

  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    marginTop: "80px",
    textAlign: "center",
    gap: "8px",
    padding: "20px",
  },
  
  emptyIcon: {
    fontSize: "56px",
    marginBottom: "8px",
  },
  
  emptyText: {
    fontSize: "17px",
    fontWeight: "700",
    color: "#6B7280",
    marginTop: "8px",
  },
  
  emptySubtext: {
    fontSize: "13px",
    color: "#9CA3AF",
    lineHeight: 1.6,
    marginTop: "8px",
  },
  
  debugInfo: {
    marginTop: "20px",
    padding: "12px",
    backgroundColor: "#F3F4F6",
    borderRadius: "8px",
    color: "#374151",
    fontSize: "11px",
    textAlign: "left",
    width: "100%",
    lineHeight: 1.8,
  },

  empty: {
    textAlign: "center",
    color: "#6B7280",
    fontSize: "14px",
    padding: "24px 16px",
    marginTop: "12px",
  },
};
