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

  const getCategoryIcon = (category) => {
    const icons = {
      breakfast: "🍳",
      lunch: "🍱",
      dinner: "🍽️",
      all: "📋",
    };
    return icons[category] || "🍴";
  };

  return (
    <div style={styles.page}>
      {/* Header with fixed position */}
      <div style={styles.header}>
        <button
          onClick={() => navigate("/dashboard", { state })}
          style={styles.backBtn}
        >
          ←
        </button>
        <div style={styles.titleContainer}>
          <div style={styles.title}>Food Menu</div>
          <div style={styles.subtitle}>Room {roomNumber || "—"}</div>
        </div>
        <div style={styles.cartIndicator}>
          {Object.keys(cart).length > 0 && (
            <div style={styles.cartBadge}>
              {Object.values(cart).reduce((sum, count) => sum + count, 0)}
            </div>
          )}
        </div>
      </div>

      {/* Loading State */}
      {loading && (
        <div style={styles.loadingState}>
          <div style={styles.spinnerContainer}>
            <div style={styles.spinner}></div>
          </div>
          <div style={styles.loadingText}>Loading menu...</div>
          <div style={styles.loadingSubtext}>Please wait</div>
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
          {/* Categories - Horizontal Scroll */}
          {menuItems.length > 0 && (
            <div style={styles.categoriesContainer}>
              <div style={styles.categoriesScroll}>
                {categories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    style={{
                      ...styles.categoryTab,
                      ...(selectedCategory === cat ? styles.categoryTabActive : {}),
                    }}
                  >
                    <span style={styles.categoryIcon}>
                      {getCategoryIcon(cat)}
                    </span>
                    <span style={styles.categoryText}>
                      {getCategoryLabel(cat)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Menu List */}
          <div style={styles.menuList}>
            {filteredItems.length === 0 && menuItems.length > 0 ? (
              <div style={styles.emptyCategory}>
                <div style={styles.emptyCategoryIcon}>🍽️</div>
                <div style={styles.emptyCategoryText}>
                  No {getCategoryLabel(selectedCategory).toLowerCase()} items available.
                </div>
              </div>
            ) : (
              filteredItems.map((item) => (
                <div key={item.id} style={styles.menuItem}>
                  <div style={styles.itemContent}>
                    <div style={styles.itemHeader}>
                      <div style={styles.itemName}>{item.name || "Unnamed Item"}</div>
                      {item.category && (
                        <div style={styles.itemCategoryTag}>
                          {getCategoryIcon(item.category)} {getCategoryLabel(item.category)}
                        </div>
                      )}
                    </div>
                    
                    {item.description && (
                      <div style={styles.itemDesc}>{item.description}</div>
                    )}
                    
                    <div style={styles.itemFooter}>
                      <div style={styles.itemPrice}>
                        <span style={styles.priceSymbol}>₹</span>
                        <span style={styles.priceValue}>
                          {typeof item.price === "number" ? item.price : "—"}
                        </span>
                      </div>
                      <div style={styles.itemActions}>
                        <button
                          onClick={() => removeFromCart(item.id)}
                          style={{
                            ...styles.actionBtn,
                            ...styles.minusBtn,
                            opacity: !cart[item.id] ? 0.5 : 1,
                            cursor: !cart[item.id] ? "not-allowed" : "pointer",
                          }}
                          disabled={!cart[item.id]}
                        >
                          −
                        </button>
                        <div style={styles.quantityDisplay}>
                          <span style={styles.quantity}>{cart[item.id] || 0}</span>
                        </div>
                        <button 
                          onClick={() => addToCart(item.id)} 
                          style={{
                            ...styles.actionBtn,
                            ...styles.plusBtn,
                          }}
                        >
                          +
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Empty State - No Menu Items */}
          {menuItems.length === 0 && (
            <div style={styles.emptyState}>
              <div style={styles.emptyIcon}>🍽️</div>
              <div style={styles.emptyTitle}>Menu Not Available</div>
              <div style={styles.emptyMessage}>
                The hotel hasn't added any menu items yet. Please check back later
                or contact the front desk.
              </div>
            </div>
          )}
        </>
      )}

      {/* Fixed Cart Footer */}
      {totalAmount > 0 && (
        <div style={styles.cartFooter}>
          <div style={styles.cartSummary}>
            <div style={styles.cartItemsCount}>
              {Object.values(cart).reduce((sum, count) => sum + count, 0)} items
            </div>
            <div style={styles.cartTotal}>
              <span style={styles.totalLabel}>Total:</span>
              <span style={styles.totalAmount}>₹{totalAmount}</span>
            </div>
          </div>
          <button
            onClick={placeOrder}
            disabled={ordering}
            style={{
              ...styles.orderBtn,
              opacity: ordering ? 0.7 : 1,
            }}
          >
            {ordering ? (
              <>
                <span style={styles.orderSpinner}></span>
                Placing Order...
              </>
            ) : (
              "Place Order"
            )}
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
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, Arial, sans-serif',
    position: "relative",
    paddingBottom: "env(safe-area-inset-bottom, 0px)",
    WebkitTapHighlightColor: "transparent",
  },

  // Header
  header: {
    position: "sticky",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    backgroundColor: "#FFFFFF",
    borderBottom: "1px solid #E5E7EB",
    padding: "12px 16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
    paddingTop: "max(12px, env(safe-area-inset-top))",
  },
  backBtn: {
    width: "44px",
    height: "44px",
    borderRadius: "12px",
    backgroundColor: "rgba(37, 99, 235, 0.1)",
    color: "#2563EB",
    border: "none",
    fontSize: "20px",
    fontWeight: "bold",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
  },
  titleContainer: {
    flex: 1,
    marginLeft: "12px",
  },
  title: {
    fontSize: "18px",
    fontWeight: "700",
    color: "#111827",
    textAlign: "center",
    letterSpacing: "-0.02em",
  },
  subtitle: {
    fontSize: "13px",
    color: "#6B7280",
    textAlign: "center",
    marginTop: "2px",
    fontWeight: "500",
  },
  cartIndicator: {
    width: "44px",
    height: "44px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  cartBadge: {
    width: "20px",
    height: "20px",
    borderRadius: "10px",
    backgroundColor: "#DC2626",
    color: "#FFFFFF",
    fontSize: "12px",
    fontWeight: "bold",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  // Loading State
  loadingState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "80px 20px",
    textAlign: "center",
  },
  spinnerContainer: {
    width: "60px",
    height: "60px",
    marginBottom: "20px",
  },
  spinner: {
    width: "100%",
    height: "100%",
    borderRadius: "50%",
    border: "3px solid rgba(37, 99, 235, 0.1)",
    borderTopColor: "#2563EB",
    animation: "spin 1s linear infinite",
  },
  loadingText: {
    fontSize: "17px",
    fontWeight: "600",
    color: "#374151",
    marginBottom: "8px",
  },
  loadingSubtext: {
    fontSize: "14px",
    color: "#9CA3AF",
  },

  // Error State
  errorState: {
    padding: "40px 20px",
    maxWidth: "400px",
    margin: "0 auto",
    textAlign: "center",
  },
  errorIcon: {
    fontSize: "48px",
    marginBottom: "16px",
  },
  errorText: {
    fontSize: "18px",
    fontWeight: "700",
    color: "#DC2626",
    marginBottom: "12px",
  },
  errorSubtext: {
    fontSize: "14px",
    color: "#6B7280",
    lineHeight: "1.5",
    backgroundColor: "#FEE2E2",
    padding: "12px",
    borderRadius: "8px",
    marginBottom: "20px",
  },
  errorHelp: {
    fontSize: "13px",
    color: "#374151",
    textAlign: "left",
    backgroundColor: "#F3F4F6",
    padding: "16px",
    borderRadius: "8px",
    marginBottom: "20px",
  },
  errorList: {
    margin: "8px 0 0 0",
    paddingLeft: "20px",
    lineHeight: "1.6",
  },
  retryBtn: {
    width: "100%",
    padding: "14px",
    backgroundColor: "#2563EB",
    color: "#FFFFFF",
    border: "none",
    borderRadius: "12px",
    fontSize: "16px",
    fontWeight: "600",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
  },

  // Categories
  categoriesContainer: {
    backgroundColor: "#FFFFFF",
    borderBottom: "1px solid #E5E7EB",
    padding: "12px 16px",
    position: "sticky",
    top: "69px",
    zIndex: 50,
  },
  categoriesScroll: {
    display: "flex",
    overflowX: "auto",
    gap: "8px",
    paddingBottom: "4px",
    WebkitOverflowScrolling: "touch",
    scrollbarWidth: "none",
    msOverflowStyle: "none",
  },
  categoriesScroll: {
    "&::-webkit-scrollbar": {
      display: "none",
    },
  },
  categoryTab: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "10px 16px",
    backgroundColor: "#F9FAFB",
    border: "1px solid #E5E7EB",
    borderRadius: "20px",
    fontSize: "14px",
    fontWeight: "500",
    color: "#6B7280",
    whiteSpace: "nowrap",
    cursor: "pointer",
    transition: "all 0.2s",
    flexShrink: 0,
    outline: "none",
  },
  categoryTabActive: {
    backgroundColor: "rgba(37, 99, 235, 0.1)",
    color: "#2563EB",
    borderColor: "#2563EB",
    fontWeight: "600",
  },
  categoryIcon: {
    fontSize: "16px",
  },
  categoryText: {
    fontSize: "14px",
  },

  // Menu List
  menuList: {
    padding: "16px",
    paddingBottom: "100px",
  },
  menuItem: {
    backgroundColor: "#FFFFFF",
    borderRadius: "16px",
    marginBottom: "12px",
    padding: "16px",
    border: "1px solid #E5E7EB",
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
    transition: "transform 0.2s",
    ":active": {
      transform: "scale(0.995)",
    },
  },
  itemContent: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  itemHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "12px",
  },
  itemName: {
    fontSize: "16px",
    fontWeight: "600",
    color: "#111827",
    lineHeight: "1.4",
    flex: 1,
  },
  itemCategoryTag: {
    fontSize: "11px",
    fontWeight: "500",
    color: "#6B7280",
    backgroundColor: "#F3F4F6",
    padding: "4px 8px",
    borderRadius: "12px",
    whiteSpace: "nowrap",
  },
  itemDesc: {
    fontSize: "14px",
    color: "#6B7280",
    lineHeight: "1.5",
  },
  itemFooter: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: "8px",
  },
  itemPrice: {
    display: "flex",
    alignItems: "baseline",
    gap: "2px",
  },
  priceSymbol: {
    fontSize: "14px",
    color: "#16A34A",
    fontWeight: "600",
  },
  priceValue: {
    fontSize: "20px",
    color: "#16A34A",
    fontWeight: "700",
  },
  itemActions: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  actionBtn: {
    width: "36px",
    height: "36px",
    borderRadius: "18px",
    border: "none",
    fontSize: "20px",
    fontWeight: "bold",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    userSelect: "none",
  },
  minusBtn: {
    backgroundColor: "rgba(220, 38, 38, 0.1)",
    color: "#DC2626",
    border: "1px solid #FCA5A5",
  },
  plusBtn: {
    backgroundColor: "rgba(37, 99, 235, 0.1)",
    color: "#2563EB",
    border: "1px solid #93C5FD",
  },
  quantityDisplay: {
    minWidth: "36px",
    textAlign: "center",
  },
  quantity: {
    fontSize: "16px",
    fontWeight: "600",
    color: "#111827",
  },

  // Empty States
  emptyCategory: {
    padding: "60px 20px",
    textAlign: "center",
  },
  emptyCategoryIcon: {
    fontSize: "48px",
    marginBottom: "16px",
    opacity: 0.5,
  },
  emptyCategoryText: {
    fontSize: "16px",
    color: "#6B7280",
    lineHeight: "1.5",
  },
  
  emptyState: {
    padding: "80px 20px",
    textAlign: "center",
  },
  emptyIcon: {
    fontSize: "64px",
    marginBottom: "20px",
    opacity: 0.3,
  },
  emptyTitle: {
    fontSize: "18px",
    fontWeight: "600",
    color: "#6B7280",
    marginBottom: "12px",
  },
  emptyMessage: {
    fontSize: "15px",
    color: "#9CA3AF",
    lineHeight: "1.6",
    maxWidth: "300px",
    margin: "0 auto",
  },

  // Cart Footer
  cartFooter: {
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#FFFFFF",
    borderTop: "1px solid #E5E7EB",
    padding: "16px",
    boxShadow: "0 -4px 12px rgba(0, 0, 0, 0.08)",
    paddingBottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
    zIndex: 100,
  },
  cartSummary: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "16px",
  },
  cartItemsCount: {
    fontSize: "14px",
    color: "#6B7280",
    fontWeight: "500",
  },
  cartTotal: {
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
  },
  totalLabel: {
    fontSize: "16px",
    color: "#6B7280",
    fontWeight: "500",
  },
  totalAmount: {
    fontSize: "24px",
    color: "#16A34A",
    fontWeight: "700",
  },
  orderBtn: {
    width: "100%",
    padding: "16px",
    backgroundColor: "#16A34A",
    color: "#FFFFFF",
    border: "none",
    borderRadius: "14px",
    fontSize: "17px",
    fontWeight: "600",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    transition: "all 0.2s",
    boxShadow: "0 4px 12px rgba(22, 163, 74, 0.25)",
    ":active": {
      transform: "scale(0.98)",
    },
  },
  orderSpinner: {
    width: "20px",
    height: "20px",
    borderRadius: "50%",
    border: "2px solid rgba(255, 255, 255, 0.3)",
    borderTopColor: "#FFFFFF",
    animation: "spin 1s linear infinite",
  },

  // Keyframes for spinner
  "@keyframes spin": {
    to: {
      transform: "rotate(360deg)",
    },
  },
};

// Add the keyframes globally
if (typeof document !== "undefined" && !document.getElementById("menu-spin-kf")) {
  const styleEl = document.createElement("style");
  styleEl.id = "menu-spin-kf";
  styleEl.innerHTML = `
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    /* Hide scrollbar for categories */
    .categories-scroll::-webkit-scrollbar {
      display: none;
    }
    
    /* Better touch targets */
    @media (max-width: 640px) {
      button, [role="button"] {
        min-height: 44px;
        min-width: 44px;
      }
    }
  `;
  document.head.appendChild(styleEl);
}