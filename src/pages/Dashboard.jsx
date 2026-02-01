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
  Timestamp,
} from "firebase/firestore";
import { db } from "../firebase";

const LAUNDRY_COOLDOWN_MS = 60 * 60 * 1000;
const HOUSEKEEPING_COOLDOWN_MS = 60 * 60 * 1000;

function formatRemaining(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function formatTimeForProgress(ms: number) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Define types
interface ServiceRequest {
  id: string;
  type: string;
  status: string;
  roomNumber: string | number;
  guestName: string;
  guestMobile: string;
  adminId: string;
  createdAt?: Timestamp;
  acceptedAt?: Timestamp;
  estimatedTime?: number;
  percentage?: number;
  remainingMs?: number;
  arrivalNotified?: boolean;
  dishName?: string;
  mealCategory?: string;
  notes?: string;
  totalPrice?: number;
  source?: string;
}

interface FoodOrder {
  id: string;
  item: string;
  status: string;
  roomNumber: string | number;
  guestName: string;
  guestMobile: string;
  adminId: string;
  totalPrice?: number;
  notes?: string;
  mealCategory?: string;
  createdAt?: Timestamp;
  acceptedAt?: Timestamp;
  estimatedTime?: number;
  completionTime?: string;
}

interface DashboardState {
  guestName: string;
  roomNumber: string | number;
  mobile: string;
  adminEmail: string;
  adminId: string;
  guestDocId: string;
}

export default function Dashboard() {
  const { state } = useLocation();
  const navigate = useNavigate();

  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);
  
  const [showArrivalNotification, setShowArrivalNotification] = useState(false);
  const [arrivalService, setArrivalService] = useState("");
  const [arrivalRequestId, setArrivalRequestId] = useState("");

  const [showCompletionModal, setShowCompletionModal] = useState(false);
  const [completedService, setCompletedService] = useState("");
  const [completedOrderId, setCompletedOrderId] = useState("");

  const [activeTab, setActiveTab] = useState<"services" | "requests" | "food">("services");

  // Store ALL service requests (from query)
  const [allServiceRequests, setAllServiceRequests] = useState<ServiceRequest[]>([]);
  
  // Store food service requests (from query)
  const [foodServiceRequests, setFoodServiceRequests] = useState<ServiceRequest[]>([]);
  
  // Store food orders from menu
  const [foodOrders, setFoodOrders] = useState<FoodOrder[]>([]);
  
  const timerRefs = useRef<Map<string, NodeJS.Timeout>>(new Map());

  const [laundryBlocked, setLaundryBlocked] = useState(false);
  const [laundryRemainingMs, setLaundryRemainingMs] = useState(0);
  
  const [housekeepingBlocked, setHousekeepingBlocked] = useState(false);
  const [housekeepingRemainingMs, setHousekeepingRemainingMs] = useState(0);

  // Store IDs for localStorage
  const [storedRequestIds, setStoredRequestIds] = useState<string[]>([]);
  const [storedFoodOrderIds, setStoredFoodOrderIds] = useState<string[]>([]);

  useEffect(() => {
    if (!state) navigate("/guest");
  }, [state, navigate]);

  const dashboardState = state as DashboardState;
  const safeGuestName = dashboardState?.guestName || "Guest";
  const safeRoomNumber = dashboardState?.roomNumber ?? "—";
  const safeMobile = dashboardState?.mobile || "—";
  const safeAdminEmail = dashboardState?.adminEmail || "—";
  const adminId = dashboardState?.adminId || null;
  const roomNumberForQuery = dashboardState?.roomNumber ?? null;
  const guestDocId = dashboardState?.guestDocId || null;

  const maskedAdmin = useMemo(() => {
    if (!safeAdminEmail || safeAdminEmail === "—") return "—";
    const [name, domain] = safeAdminEmail.split("@");
    if (!domain) return safeAdminEmail;
    return `${name.slice(0, 2)}***@${domain}`;
  }, [safeAdminEmail]);

  // 🔑 localStorage keys
  const storageKey = useMemo(() => {
    if (!adminId) return null;
    if (!safeMobile || safeMobile === "—") return null;
    if (roomNumberForQuery === null || roomNumberForQuery === "—") return null;
    return `roomio:requests:${adminId}:${safeMobile}:${roomNumberForQuery}`;
  }, [adminId, safeMobile, roomNumberForQuery]);

  const foodOrdersStorageKey = useMemo(() => {
    if (!adminId) return null;
    if (!safeMobile || safeMobile === "—") return null;
    if (roomNumberForQuery === null || roomNumberForQuery === "—") return null;
    return `roomio:foodOrders:${adminId}:${safeMobile}:${roomNumberForQuery}`;
  }, [adminId, safeMobile, roomNumberForQuery]);

  const laundryCooldownKey = useMemo(() => {
    if (!storageKey) return null;
    return `${storageKey}:laundry`;
  }, [storageKey]);

  const housekeepingCooldownKey = useMemo(() => {
    if (!storageKey) return null;
    return `${storageKey}:housekeeping`;
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
    
    navigate("/guest", { 
      state: { 
        admin: safeAdminEmail 
      } 
    });
  };

  // ✅ REAL-TIME SESSION MONITORING
  useEffect(() => {
    if (!guestDocId || !adminId || !safeMobile) return;

    const guestDocRef = doc(db, "guests", guestDocId);
    
    const unsubscribe = onSnapshot(guestDocRef, (snapshot) => {
      if (!snapshot.exists()) {
        setSessionExpired(true);
        alert("Your session has expired. Admin has checked you out.");
        navigate("/guest", { replace: true });
        return;
      }

      const guestData = snapshot.data();
      
      if (!guestData?.isLoggedIn) {
        setSessionExpired(true);
        alert("Someone else logged in with your mobile number. Your session has been terminated.");
        navigate("/guest", { replace: true });
        return;
      }

      if (!guestData?.isActive) {
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

  useEffect(() => {
    const handleBeforeUnload = async (e: BeforeUnloadEvent) => {
      e.preventDefault();
      await cleanupSession();
      e.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [guestDocId]);

  // Load stored request IDs
  const loadStoredRequestIds = (): string[] => {
    if (!storageKey) return [];
    try {
      const raw = localStorage.getItem(storageKey);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  };

  const saveStoredRequestIds = (ids: string[]) => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(ids));
    } catch {}
  };

  const addRequestIdToStorage = (id: string) => {
    if (!storageKey) return;
    const current = loadStoredRequestIds();
    const next = [id, ...current.filter((x) => x !== id)].slice(0, 30);
    saveStoredRequestIds(next);
    setStoredRequestIds(next);
  };

  const loadStoredFoodOrderIds = (): string[] => {
    if (!foodOrdersStorageKey) return [];
    try {
      const raw = localStorage.getItem(foodOrdersStorageKey);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  };

  const saveStoredFoodOrderIds = (ids: string[]) => {
    if (!foodOrdersStorageKey) return;
    try {
      localStorage.setItem(foodOrdersStorageKey, JSON.stringify(ids));
    } catch {}
  };

  const addFoodOrderIdToStorage = (id: string) => {
    if (!foodOrdersStorageKey) return;
    const current = loadStoredFoodOrderIds();
    const next = [id, ...current.filter((x) => x !== id)].slice(0, 30);
    saveStoredFoodOrderIds(next);
    setStoredFoodOrderIds(next);
  };

  const clearRequestHistory = () => {
    if (!storageKey) return;
    try {
      localStorage.removeItem(storageKey);
    } catch {}
    setStoredRequestIds([]);
    // Clear all timers
    timerRefs.current.forEach((intervalId) => clearInterval(intervalId));
    timerRefs.current.clear();
  };

  const clearFoodOrderHistory = () => {
    if (!foodOrdersStorageKey) return;
    try {
      localStorage.removeItem(foodOrdersStorageKey);
    } catch {}
    setStoredFoodOrderIds([]);
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
    setStoredRequestIds(ids);
    
    const foodOrderIds = loadStoredFoodOrderIds();
    setStoredFoodOrderIds(foodOrderIds);
  }, [state, storageKey, foodOrdersStorageKey]);

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

  // ✅ Housekeeping cooldown timer
  useEffect(() => {
    if (!housekeepingCooldownKey) return;

    const tick = () => {
      try {
        const last = Number(localStorage.getItem(housekeepingCooldownKey) || 0);
        const nextAllowed = last + HOUSEKEEPING_COOLDOWN_MS;
        const now = Date.now();

        if (last > 0 && now < nextAllowed) {
          setHousekeepingBlocked(true);
          setHousekeepingRemainingMs(nextAllowed - now);
        } else {
          setHousekeepingBlocked(false);
          setHousekeepingRemainingMs(0);
        }
      } catch {
        setHousekeepingBlocked(false);
      }
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [housekeepingCooldownKey]);

  // ✅ Calculate progress for accepted/in-progress requests
  const calculateProgress = (request: ServiceRequest) => {
    if (!request.estimatedTime) {
      return { percentage: 0, remainingMs: request.estimatedTime ? request.estimatedTime * 60 * 1000 : 0 };
    }
    
    if (!request.acceptedAt) {
      return { percentage: 0, remainingMs: request.estimatedTime * 60 * 1000 };
    }
    
    let acceptedTime: number;
    
    if (request.acceptedAt instanceof Timestamp) {
      acceptedTime = request.acceptedAt.toMillis();
    } else if (typeof request.acceptedAt === 'string') {
      acceptedTime = new Date(request.acceptedAt).getTime();
    } else if (typeof request.acceptedAt === 'number') {
      acceptedTime = request.acceptedAt;
    } else {
      acceptedTime = Date.now();
    }
    
    const estimatedMs = request.estimatedTime * 60 * 1000;
    const endTime = acceptedTime + estimatedMs;
    const now = Date.now();
    
    if (now >= endTime) {
      return { percentage: 100, remainingMs: 0 };
    }
    
    const elapsed = now - acceptedTime;
    const percentage = Math.min(100, (elapsed / estimatedMs) * 100);
    const remainingMs = Math.max(0, endTime - now);
    
    return { percentage, remainingMs };
  };

  // ✅ Check for arrival notifications
  const checkArrivalNotifications = () => {
    const now = Date.now();
    
    allServiceRequests.forEach(request => {
      if ((request.status === "in-progress") && 
          !request.arrivalNotified && 
          request.estimatedTime &&
          request.type !== "Food Order") {
        
        const acceptedTime = request.acceptedAt instanceof Timestamp 
          ? request.acceptedAt.toMillis() 
          : Date.now();
        const estimatedMs = request.estimatedTime * 60 * 1000;
        const timeUntilArrival = acceptedTime + estimatedMs - now;
        
        if (timeUntilArrival > 0 && timeUntilArrival <= 2 * 60 * 1000) {
          setArrivalService(request.type || "Service");
          setArrivalRequestId(request.id);
          setShowArrivalNotification(true);
          
          // Mark as notified
          setAllServiceRequests(prev => 
            prev.map(req => 
              req.id === request.id 
                ? { ...req, arrivalNotified: true } 
                : req
            )
          );
        }
      }
    });
  };

  // ✅ Check for food order completion notifications
  const checkFoodOrderNotifications = (request: ServiceRequest) => {
    if (request.status === "completed" && !request.completionNotified) {
      setCompletedService(request.dishName || "Food Order");
      setCompletedOrderId(request.id);
      setShowCompletionModal(true);
      
      // Mark as notified
      setFoodServiceRequests(prev => 
        prev.map(req => 
          req.id === request.id 
            ? { ...req, completionNotified: true } 
            : req
        )
      );
    }
  };

  // ✅ Handle arrival notification confirmation
  const handleArrivalConfirm = async () => {
    if (arrivalRequestId) {
      // Remove from local storage
      const updatedIds = storedRequestIds.filter(id => id !== arrivalRequestId);
      saveStoredRequestIds(updatedIds);
      setStoredRequestIds(updatedIds);
      
      try {
        await updateDoc(doc(db, "serviceRequests", arrivalRequestId), {
          status: "completed",
          completedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        console.error("Failed to update request status:", error);
      }
      
      // Clear timer if exists
      if (timerRefs.current.has(arrivalRequestId)) {
        clearInterval(timerRefs.current.get(arrivalRequestId));
        timerRefs.current.delete(arrivalRequestId);
      }
    }
    
    setShowArrivalNotification(false);
    setArrivalService("");
    setArrivalRequestId("");
  };

  // ✅ Handle completion notification confirmation
  const handleCompletionConfirm = () => {
    if (completedOrderId) {
      // Remove from local storage
      const updatedIds = storedFoodOrderIds.filter(id => id !== completedOrderId);
      saveStoredFoodOrderIds(updatedIds);
      setStoredFoodOrderIds(updatedIds);
      
      // Clear timer if exists
      if (timerRefs.current.has(`food-${completedOrderId}`)) {
        clearInterval(timerRefs.current.get(`food-${completedOrderId}`));
        timerRefs.current.delete(`food-${completedOrderId}`);
      }
    }
    
    setShowCompletionModal(false);
    setCompletedService("");
    setCompletedOrderId("");
  };

  // ✅ Live listener for ALL service requests (including laundry/housekeeping)
  useEffect(() => {
    if (!adminId || !safeMobile || !roomNumberForQuery) return;

    // Listen for ALL service requests (non-food)
    const serviceRequestsQuery = query(
      collection(db, "serviceRequests"),
      where("adminId", "==", adminId),
      where("guestMobile", "==", safeMobile),
      where("roomNumber", "==", roomNumberForQuery)
    );

    const unsubscribe = onSnapshot(
      serviceRequestsQuery,
      (snapshot) => {
        const requests: ServiceRequest[] = [];
        
        snapshot.forEach((doc) => {
          const data = doc.data() as ServiceRequest;
          const request = { id: doc.id, ...data };
          
          // Filter out food orders (they're handled separately)
          if (request.type !== "Food Order") {
            // Calculate progress for in-progress requests
            if (request.status === "in-progress" && request.estimatedTime) {
              const progress = calculateProgress(request);
              request.percentage = progress.percentage;
              request.remainingMs = progress.remainingMs;
              
              // Start timer for progress updates
              if (!timerRefs.current.has(request.id)) {
                const intervalId = setInterval(() => {
                  setAllServiceRequests(prev => 
                    prev.map(req => {
                      if (req.id === request.id && req.status === "in-progress" && req.estimatedTime) {
                        const progress = calculateProgress(req);
                        return { ...req, ...progress };
                      }
                      return req;
                    })
                  );
                }, 1000);
                timerRefs.current.set(request.id, intervalId);
              }
            }
            
            // Stop timer if request is completed
            if ((request.status === "completed" || request.status === "cancelled") && 
                timerRefs.current.has(request.id)) {
              clearInterval(timerRefs.current.get(request.id));
              timerRefs.current.delete(request.id);
            }
            
            requests.push(request);
            
            // Add to localStorage if it's a new request
            if (!storedRequestIds.includes(request.id)) {
              addRequestIdToStorage(request.id);
            }
          }
        });
        
        setAllServiceRequests(requests);
      },
      (error) => {
        console.error("Service requests listener error:", error);
      }
    );

    return () => {
      unsubscribe();
      // Clear timers
      timerRefs.current.forEach((intervalId) => clearInterval(intervalId));
      timerRefs.current.clear();
    };
  }, [adminId, safeMobile, roomNumberForQuery, storedRequestIds]);

  // ✅ Live listener for FOOD service requests
  useEffect(() => {
    if (!adminId || !safeMobile || !roomNumberForQuery) return;

    const foodRequestsQuery = query(
      collection(db, "serviceRequests"),
      where("adminId", "==", adminId),
      where("guestMobile", "==", safeMobile),
      where("roomNumber", "==", roomNumberForQuery),
      where("type", "==", "Food Order")
    );

    const unsubscribe = onSnapshot(
      foodRequestsQuery,
      (snapshot) => {
        const requests: ServiceRequest[] = [];
        
        snapshot.forEach((doc) => {
          const data = doc.data() as ServiceRequest;
          const request = { id: doc.id, ...data };
          
          // Calculate progress for in-progress requests
          if (request.status === "in-progress" && request.estimatedTime) {
            const progress = calculateProgress(request);
            request.percentage = progress.percentage;
            request.remainingMs = progress.remainingMs;
            
            // Start timer for progress updates
            if (!timerRefs.current.has(`food-${request.id}`)) {
              const intervalId = setInterval(() => {
                setFoodServiceRequests(prev => 
                  prev.map(req => {
                    if (req.id === request.id && req.status === "in-progress" && req.estimatedTime) {
                      const progress = calculateProgress(req);
                      return { ...req, ...progress };
                    }
                    return req;
                  })
                );
              }, 1000);
              timerRefs.current.set(`food-${request.id}`, intervalId);
            }
          }
          
          // Check for completion notification
          if (request.status === "completed" && !request.completionNotified) {
            checkFoodOrderNotifications(request);
          }
          
          // Stop timer if request is completed
          if ((request.status === "completed" || request.status === "cancelled") && 
              timerRefs.current.has(`food-${request.id}`)) {
            clearInterval(timerRefs.current.get(`food-${request.id}`));
            timerRefs.current.delete(`food-${request.id}`);
          }
          
          requests.push(request);
        });
        
        setFoodServiceRequests(requests);
      },
      (error) => {
        console.error("Food service requests listener error:", error);
      }
    );

    return () => {
      unsubscribe();
      // Clear food timers
      timerRefs.current.forEach((intervalId, key) => {
        if (key.startsWith('food-')) {
          clearInterval(intervalId);
          timerRefs.current.delete(key);
        }
      });
    };
  }, [adminId, safeMobile, roomNumberForQuery]);

  // ✅ Live listener for FOOD ORDERS from menu
  useEffect(() => {
    if (!adminId || !safeMobile || !roomNumberForQuery) return;

    const foodOrdersQuery = query(
      collection(db, "users", adminId, "foodOrders"),
      where("guestMobile", "==", safeMobile),
      where("roomNumber", "==", roomNumberForQuery)
    );

    const unsubscribe = onSnapshot(
      foodOrdersQuery,
      (snapshot) => {
        const orders: FoodOrder[] = [];
        
        snapshot.forEach((doc) => {
          const data = doc.data() as FoodOrder;
          const order = { id: doc.id, ...data };
          orders.push(order);
          
          // Add to localStorage if it's a new order
          if (!storedFoodOrderIds.includes(order.id)) {
            addFoodOrderIdToStorage(order.id);
          }
        });
        
        setFoodOrders(orders);
      },
      (error) => {
        console.error("Food orders listener error:", error);
      }
    );

    return () => unsubscribe();
  }, [adminId, safeMobile, roomNumberForQuery, storedFoodOrderIds]);

  // ✅ Check for arrival notifications periodically
  useEffect(() => {
    const interval = setInterval(checkArrivalNotifications, 30000);
    return () => clearInterval(interval);
  }, [allServiceRequests]);

  // ✅ Combine all food orders for display
  const allFoodOrders = useMemo(() => {
    // Get food orders from menu
    const menuOrders = foodOrders
      .filter(order => order.status !== "completed" && order.status !== "cancelled")
      .map(order => ({
        ...order,
        source: "menu",
        dishName: order.item || "Food Order",
        createdMs: order?.createdAt?.toMillis?.() ?? 0,
      }));

    // Get food service requests
    const serviceFoods = foodServiceRequests
      .filter(request => request.type === "Food Order")
      .map(request => ({
        ...request,
        source: "service",
        dishName: request.dishName || request.type,
        createdMs: request?.createdAt?.toMillis?.() ?? 0,
      }));

    // Combine and sort by creation time
    const combined = [...menuOrders, ...serviceFoods]
      .sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0));

    return combined;
  }, [foodOrders, foodServiceRequests]);

  // Filter service requests (non-food)
  const serviceRequestsList = useMemo(() => {
    return allServiceRequests
      .filter(request => request.type !== "Food Order")
      .sort((a, b) => {
        const aTime = a?.createdAt?.toMillis?.() ?? 0;
        const bTime = b?.createdAt?.toMillis?.() ?? 0;
        return bTime - aTime;
      });
  }, [allServiceRequests]);

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
  const showToast = (msg: string) => {
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

  // ✅ Create Service Request (Housekeeping)
  const requestHousekeeping = async () => {
    if (!adminId) {
      alert("Missing adminId. Please verify again from QR.");
      return;
    }

    if (!bookingQuery) {
      alert("Booking not active. Please verify again.");
      navigate("/guest");
      return;
    }

    if (housekeepingBlocked) {
      showToast(`⏳ Available in ${formatRemaining(housekeepingRemainingMs)}`);
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
        type: "Housekeeping",
        roomNumber: safeRoomNumber,
        guestName: safeGuestName,
        guestMobile: safeMobile,
        status: "pending",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        source: "guest-web",
      });

      addRequestIdToStorage(docRef.id);
      
      if (housekeepingCooldownKey) {
        localStorage.setItem(housekeepingCooldownKey, String(Date.now()));
      }

      showToast("✅ Housekeeping request sent!");
      setActiveTab("requests");
    } catch (err) {
      console.error("Housekeeping request error:", err);
      alert("Failed to send request. Check internet / permissions.");
    } finally {
      setSending(false);
    }
  };

  const statusChip = (status: string) => {
    const s = (status || "pending").toLowerCase();
    if (s === "accepted") return { bg: "rgba(37,99,235,0.12)", text: "#2563EB", label: "ACCEPTED" };
    if (s === "completed") return { bg: "rgba(22,163,74,0.12)", text: "#16A34A", label: "COMPLETED" };
    if (s === "in-progress") return { bg: "rgba(37,99,235,0.12)", text: "#2563EB", label: "IN PROGRESS" };
    if (s === "cancelled") return { bg: "rgba(107,114,128,0.12)", text: "#6B7280", label: "CANCELLED" };
    if (s === "restricted") return { bg: "rgba(220,38,38,0.10)", text: "#DC2626", label: "NO ACCESS" };
    if (s === "deleted") return { bg: "rgba(107,114,128,0.12)", text: "#6B7280", label: "REMOVED" };
    if (s === "loading") return { bg: "rgba(107,114,128,0.12)", text: "#6B7280", label: "LOADING" };
    return { bg: "rgba(245,158,11,0.14)", text: "#F59E0B", label: "PENDING" };
  };

  const formatTime = (t: any) => {
    try {
      if (t instanceof Timestamp) {
        const d = t.toDate();
        return d.toLocaleString();
      }
      return "Just now";
    } catch {
      return "Just now";
    }
  };

  // ✅ Navigate to Menu Page
  const goToMenu = () => {
    navigate("/menu", { state: dashboardState });
  };

  return (
    <div style={styles.page} className="safeArea">
      {/* ✅ ARRIVAL NOTIFICATION MODAL */}
      {showArrivalNotification && (
        <div style={styles.arrivalOverlay}>
          <div style={styles.arrivalModal}>
            <div style={styles.arrivalIcon}>🚨</div>
            <div style={styles.arrivalTitle}>Arrival Alert!</div>
            <div style={styles.arrivalMessage}>
              Your {arrivalService} is arriving in approximately 2 minutes!
            </div>
            <div style={styles.arrivalActions}>
              <button
                onClick={handleArrivalConfirm}
                style={styles.arrivalConfirmBtn}
                className="tapButton"
              >
                Got it, thanks!
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ✅ COMPLETION NOTIFICATION MODAL */}
      {showCompletionModal && (
        <div style={styles.completionOverlay}>
          <div style={styles.completionModal}>
            <div style={styles.completionIcon}>✅</div>
            <div style={styles.completionTitle}>Order Completed!</div>
            <div style={styles.completionMessage}>
              Your {completedService} has been delivered!
            </div>
            <div style={styles.completionActions}>
              <button
                onClick={handleCompletionConfirm}
                style={styles.completionConfirmBtn}
                className="tapButton"
              >
                Great! Enjoy your meal
              </button>
            </div>
          </div>
        </div>
      )}

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
              ...(activeTab === "services" ? styles.tabBtnActive : {}),
            }}
          >
            Services
          </button>
          <button
            className="tapButton"
            onClick={() => setActiveTab("requests")}
            style={{
              ...styles.tabBtn,
              ...(activeTab === "requests" ? styles.tabBtnActive : {}),
            }}
          >
            Requests
            {serviceRequestsList.length ? (
              <span style={styles.tabBadge}>{serviceRequestsList.length}</span>
            ) : null}
          </button>
          <button
            className="tapButton"
            onClick={() => setActiveTab("food")}
            style={{
              ...styles.tabBtn,
              ...(activeTab === "food" ? styles.tabBtnActive : {}),
            }}
          >
            Food Orders
            {allFoodOrders.length ? (
              <span style={styles.tabBadge}>{allFoodOrders.length}</span>
            ) : null}
          </button>
        </div>

        {activeTab === "services" ? (
          <div style={styles.grid} className="servicesGrid">
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
              title={housekeepingBlocked ? "Cooldown" : "Housekeeping"}
              subtitle={housekeepingBlocked ? formatRemaining(housekeepingRemainingMs) : "Room cleaning"}
              accent="#F59E0B"
              disabled={sending || housekeepingBlocked}
              onClick={requestHousekeeping}
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
                <div style={styles.sectionTitle}>Service Requests</div>
              </div>
              <button
                className="tapButton"
                onClick={clearRequestHistory}
                style={styles.clearBtn}
                disabled={!storedRequestIds.length}
                title="Clear local history"
              >
                Clear
              </button>
            </div>

            {serviceRequestsList.length === 0 ? (
              <div style={styles.emptyBox}>
                <div style={styles.emptyTitle}>No requests yet</div>
                <div style={styles.emptySub}>
                  Send a service request and track it here in real-time.
                </div>
              </div>
            ) : (
              <div style={styles.reqList}>
                {serviceRequestsList.map((r) => {
                  const chip = statusChip(r.status);
                  const isInProgress = r.status === "in-progress";
                  const hasEstimatedTime = isInProgress && r.estimatedTime;
                  const hasProgress = hasEstimatedTime && r.percentage !== undefined;
                  
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
                      
                      {hasProgress && (
                        <div style={styles.progressSection}>
                          <div style={styles.progressHeader}>
                            <span style={styles.progressLabel}>
                              Arriving in {formatTimeForProgress(r.remainingMs || 0)}
                            </span>
                            <span style={styles.progressPercentage}>
                              {Math.round(r.percentage || 0)}%
                            </span>
                          </div>
                          <div style={styles.progressBar}>
                            <div 
                              style={{
                                ...styles.progressFill,
                                width: `${r.percentage || 0}%`,
                                backgroundColor: "#2563EB"
                              }}
                            />
                          </div>
                          <div style={styles.progressSubtext}>
                            Estimated time: {r.estimatedTime} minutes
                            {r.remainingMs > 0 && ` • ${formatTimeForProgress(r.remainingMs)} remaining`}
                          </div>
                        </div>
                      )}
                      
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

        {activeTab === "food" ? (
          <>
            <div style={styles.sectionHeader}>
              <div style={styles.sectionLeft}>
                <div style={styles.sectionIcon}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <div style={styles.sectionTitle}>Food Orders</div>
              </div>
              <button
                className="tapButton"
                onClick={clearFoodOrderHistory}
                style={styles.clearBtn}
                disabled={!storedFoodOrderIds.length}
                title="Clear food order history"
              >
                Clear
              </button>
            </div>

            {allFoodOrders.length === 0 ? (
              <div style={styles.emptyBox}>
                <div style={styles.emptyTitle}>No food orders yet</div>
                <div style={styles.emptySub}>
                  Order food from the menu and track it here in real-time.
                </div>
              </div>
            ) : (
              <div style={styles.reqList}>
                {allFoodOrders.map((order) => {
                  let status = order.status;
                  let showProgress = false;
                  let estimatedTime = order.estimatedTime;
                  let percentage = order.percentage || 0;
                  let remainingMs = order.remainingMs || 0;
                  
                  if (order.source === "menu" && order.status === "accepted") {
                    const matchingService = foodServiceRequests.find(
                      req => req.guestMobile === safeMobile && 
                       req.roomNumber === safeRoomNumber &&
                       req.dishName === order.item
                    );
                    
                    if (matchingService) {
                      status = matchingService.status;
                      estimatedTime = matchingService.estimatedTime;
                      percentage = matchingService.percentage || 0;
                      remainingMs = matchingService.remainingMs || 0;
                      showProgress = matchingService.status === "in-progress";
                    }
                  }
                  
                  if (order.source === "service") {
                    showProgress = order.status === "in-progress" && order.estimatedTime;
                  }
                  
                  const chip = statusChip(status);
                  const isCompleted = status === "completed";
                  const isPending = (status || "pending") === "pending";
                  const isInProgress = status === "in-progress";
                  const isAccepted = status === "accepted";
                  
                  return (
                    <div key={`${order.source}-${order.id}`} style={styles.reqCard}>
                      <div style={styles.reqTop}>
                        <div style={styles.reqType}>
                          {order.dishName || "Food Order"}
                          {order.mealCategory && ` (${order.mealCategory})`}
                        </div>
                        <div style={{ ...styles.reqStatus, backgroundColor: chip.bg, color: chip.text }}>
                          {chip.label}
                        </div>
                      </div>
                      
                      {order.notes && (
                        <div style={styles.reqNotes}>
                          <strong>Notes:</strong> {order.notes}
                        </div>
                      )}
                      
                      <div style={styles.reqMeta}>
                        Room {order.roomNumber ?? safeRoomNumber} • 
                        {order.totalPrice ? ` ₹${order.totalPrice} • ` : " "}
                        {formatTime(order.createdAt)}
                        {order.source === "menu" && <span style={{color: "#9CA3AF", fontSize: 10, marginLeft: 6}}>(from menu)</span>}
                      </div>
                      
                      {showProgress && !isCompleted && (
                        <div style={styles.progressSection}>
                          <div style={styles.progressHeader}>
                            <span style={styles.progressLabel}>
                              {isInProgress ? `Ready in ${formatTimeForProgress(remainingMs)}` : "Preparing..."}
                            </span>
                            <span style={styles.progressPercentage}>
                              {Math.round(percentage)}%
                            </span>
                          </div>
                          <div style={styles.progressBar}>
                            <div 
                              style={{
                                ...styles.progressFill,
                                width: `${percentage}%`,
                                backgroundColor: "#16A34A"
                              }}
                            />
                          </div>
                          <div style={styles.progressSubtext}>
                            {estimatedTime ? `Estimated time: ${estimatedTime} minutes` : "Time estimation pending"}
                            {remainingMs > 0 && ` • ${formatTimeForProgress(remainingMs)} remaining`}
                          </div>
                        </div>
                      )}
                      
                      {isPending && (
                        <div style={styles.pendingMessage}>
                          <span style={styles.pendingIcon}>⏳</span>
                          <span style={styles.pendingText}>
                            {order.source === "menu" 
                              ? "Order placed, waiting for acceptance" 
                              : "Your order is pending acceptance"}
                          </span>
                        </div>
                      )}
                      
                      {isAccepted && !showProgress && (
                        <div style={styles.acceptedMessage}>
                          <span style={styles.acceptedIcon}>✅</span>
                          <span style={styles.acceptedText}>Order accepted, preparation will start soon</span>
                        </div>
                      )}
                      
                      {isCompleted && (
                        <div style={styles.completedMessage}>
                          <span style={styles.completedIcon}>✅</span>
                          <span style={styles.completedText}>Order delivered and completed!</span>
                        </div>
                      )}
                      
                      <div style={styles.reqIdRow}>
                        <div style={styles.reqIdLabel}>Order ID</div>
                        <div style={styles.reqIdValue}>{order.id}</div>
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

function ServiceCard({ 
  icon, 
  title, 
  subtitle, 
  accent, 
  onClick, 
  disabled 
}: { 
  icon: string; 
  title: string; 
  subtitle: string; 
  accent: string; 
  onClick: () => void; 
  disabled?: boolean;
}) {
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
      @keyframes pulse {
        0% { transform: scale(1); }
        50% { transform: scale(1.1); }
        100% { transform: scale(1); }
      }
    `}</style>
  );
}

const styles = {
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
  adminValue: { fontSize: 13, fontWeight: 900, color: "#111827", marginTop: 2 },
  adminRight: { display: "flex", alignItems: "center", gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#22C55E", animation: "pulse 2s infinite" },
  statusText: { fontSize: 12, fontWeight: 800, color: "#22C55E" },
  toast: { marginTop: 12, padding: "12px 14px", backgroundColor: "#F9FAFB", border: "1px solid #E5E7EB", borderRadius: 12, fontSize: 13, fontWeight: 800, color: "#111827", textAlign: "center" },
  tabRow: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 },
  tabBtn: { height: 44, borderRadius: 14, border: "1px solid #E5E7EB", backgroundColor: "#fff", fontWeight: 900, color: "#6B7280", cursor: "pointer", boxShadow: "0 2px 10px rgba(17, 24, 39, 0.05)", fontSize: 12 },
  tabBtnActive: { backgroundColor: "#2563EB", borderColor: "#2563EB", color: "#fff" },
  tabBadge: { marginLeft: 8, display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 18, height: 18, padding: "0 6px", borderRadius: 999, backgroundColor: "rgba(255,255,255,0.25)", color: "#fff", fontSize: 12, fontWeight: 900 },
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 },
  serviceCard: { display: "flex", alignItems: "center", gap: 12, backgroundColor: "#fff", border: "1px solid #E5E7EB", borderRadius: 16, padding: 16, borderLeftWidth: 4, borderLeftStyle: "solid", textAlign: "left", width: "100%" },
  serviceIconWrap: { width: 44, height: 44, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center" },
  serviceIcon: { fontSize: 20 },
  serviceText: { flex: 1, minWidth: 0 },
  serviceTitle: { fontSize: 14, fontWeight: 800, color: "#111827", marginBottom: 2 },
  serviceSubtitle: { fontSize: 11, color: "#6B7280", fontWeight: 700 },
  serviceAction: { display: "flex", alignItems: "center", gap: 4 },
  serviceActionText: { fontSize: 12, color: "#6B7280", fontWeight: 800 },
  serviceArrow: { fontSize: 14, color: "#6B7280", fontWeight: 900 },
  sectionHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  sectionLeft: { display: "flex", alignItems: "center", gap: 10 },
  sectionIcon: { width: 30, height: 30, borderRadius: 10, backgroundColor: "#2563EB", display: "flex", alignItems: "center", justifyContent: "center" },
  sectionTitle: { fontSize: 16, fontWeight: 900, color: "#111827" },
  clearBtn: { padding: "8px 12px", borderRadius: 10, border: "1px solid #E5E7EB", backgroundColor: "#fff", color: "#DC2626", fontSize: 12, fontWeight: 800, cursor: "pointer" },
  emptyBox: { backgroundColor: "#fff", border: "1px solid #E5E7EB", borderRadius: 16, padding: 24, textAlign: "center", marginBottom: 12 },
  emptyTitle: { fontSize: 16, fontWeight: 800, color: "#111827", marginBottom: 6 },
  emptySub: { fontSize: 13, color: "#6B7280" },
  reqList: { display: "flex", flexDirection: "column", gap: 10 },
  reqCard: { backgroundColor: "#fff", border: "1px solid #E5E7EB", borderRadius: 16, padding: 16 },
  reqTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 },
  reqType: { fontSize: 15, fontWeight: 900, color: "#111827", flex: 1 },
  reqStatus: { fontSize: 10, fontWeight: 900, padding: "4px 8px", borderRadius: 8 },
  reqMeta: { fontSize: 12, color: "#6B7280", marginBottom: 12 },
  reqIdRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 12, paddingTop: 12, borderTop: "1px solid #E5E7EB" },
  reqIdLabel: { fontSize: 11, color: "#6B7280", fontWeight: 800 },
  reqIdValue: { fontSize: 11, color: "#111827", fontWeight: 700, fontFamily: "monospace", wordBreak: "break-all" },
  expiredContainer: { minHeight: "100vh", backgroundColor: "#F9FAFB", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,Arial,sans-serif' },
  expiredCard: { backgroundColor: "#fff", borderRadius: 20, padding: 24, border: "1px solid #E5E7EB", boxShadow: "0 12px 30px rgba(17, 24, 39, 0.08)", maxWidth: 400, width: "100%", textAlign: "center" },
  expiredIcon: { fontSize: 48, marginBottom: 16 },
  expiredTitle: { fontSize: 22, fontWeight: 900, color: "#111827", marginBottom: 8 },
  expiredMessage: { fontSize: 14, color: "#6B7280", marginBottom: 24, lineHeight: 1.5 },
  expiredButton: { backgroundColor: "#2563EB", color: "#fff", border: "none", padding: "12px 24px", borderRadius: 12, fontSize: 16, fontWeight: 700, cursor: "pointer", width: "100%" },
  arrivalOverlay: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0, 0, 0, 0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 20 },
  arrivalModal: { backgroundColor: "#fff", borderRadius: 24, padding: 30, maxWidth: 400, width: "100%", textAlign: "center", boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)", border: "2px solid #2563EB" },
  arrivalIcon: { fontSize: 60, marginBottom: 20, animation: "pulse 1.5s infinite" },
  arrivalTitle: { fontSize: 24, fontWeight: 900, color: "#111827", marginBottom: 12 },
  arrivalMessage: { fontSize: 16, color: "#6B7280", marginBottom: 24, lineHeight: 1.5 },
  arrivalActions: { display: "flex", gap: 12 },
  arrivalConfirmBtn: { flex: 1, backgroundColor: "#16A34A", color: "#fff", border: "none", padding: "16px 24px", borderRadius: 14, fontSize: 16, fontWeight: 900, cursor: "pointer", transition: "all 0.2s ease" },
  completionOverlay: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0, 0, 0, 0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 20 },
  completionModal: { backgroundColor: "#fff", borderRadius: 24, padding: 30, maxWidth: 400, width: "100%", textAlign: "center", boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)", border: "2px solid #16A34A" },
  completionIcon: { fontSize: 60, marginBottom: 20, animation: "pulse 1.5s infinite" },
  completionTitle: { fontSize: 24, fontWeight: 900, color: "#111827", marginBottom: 12 },
  completionMessage: { fontSize: 16, color: "#6B7280", marginBottom: 24, lineHeight: 1.5 },
  completionActions: { display: "flex", gap: 12 },
  completionConfirmBtn: { flex: 1, backgroundColor: "#16A34A", color: "#fff", border: "none", padding: "16px 24px", borderRadius: 14, fontSize: 16, fontWeight: 900, cursor: "pointer", transition: "all 0.2s ease" },
  acceptedMessage: { marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: "rgba(37, 99, 235, 0.12)", border: "1px solid rgba(37, 99, 235, 0.25)", display: "flex", alignItems: "center", gap: 8 },
  acceptedIcon: { fontSize: 16, color: "#2563EB" },
  acceptedText: { color: "#2563EB", fontWeight: 800, fontSize: 13 },
  pendingMessage: { marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: "rgba(245, 158, 11, 0.12)", border: "1px solid rgba(245, 158, 11, 0.25)", display: "flex", alignItems: "center", gap: 8 },
  pendingIcon: { fontSize: 16, color: "#F59E0B" },
  pendingText: { color: "#F59E0B", fontWeight: 800, fontSize: 13 },
  completedMessage: { marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: "rgba(22, 163, 74, 0.12)", border: "1px solid rgba(22, 163, 74, 0.25)", display: "flex", alignItems: "center", gap: 8 },
  completedIcon: { fontSize: 16, color: "#16A34A" },
  completedText: { color: "#16A34A", fontWeight: 800, fontSize: 13 },
  reqNotes: { marginTop: 8, padding: 10, backgroundColor: "#F9FAFB", borderRadius: 8, fontSize: 13, color: "#6B7280", borderLeft: "3px solid #F59E0B" },
  progressSection: { marginTop: 16, padding: 14, backgroundColor: "#F9FAFB", borderRadius: 12, border: "1px solid #E5E7EB" },
  progressHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  progressLabel: { fontSize: 13, fontWeight: 800, color: "#111827" },
  progressPercentage: { fontSize: 13, fontWeight: 900, color: "#2563EB" },
  progressBar: { height: 8, backgroundColor: "#E5E7EB", borderRadius: 4, overflow: "hidden", marginBottom: 8 },
  progressFill: { height: "100%", borderRadius: 4, transition: "width 1s ease" },
  progressSubtext: { fontSize: 11, color: "#6B7280", fontWeight: 700 },
  footer: { marginTop: 20, paddingTop: 16, borderTop: "1px solid #E5E7EB" },
  footerRow: { display: "flex", justifyContent: "center", marginBottom: 12 },
  footerPill: { display: "flex", alignItems: "center", gap: 8, backgroundColor: "#F9FAFB", padding: "8px 12px", borderRadius: 12, border: "1px solid #E5E7EB" },
  footerDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#22C55E" },
  footerText: { fontSize: 11, fontWeight: 800, color: "#6B7280" },
  versionRow: { display: "flex", alignItems: "center", justifyContent: "center", gap: 8 },
  version: { fontSize: 10, fontWeight: 800, color: "#9CA3AF", letterSpacing: 1 },
  versionDivider: { width: 4, height: 4, borderRadius: 2, backgroundColor: "#D1D5DB" },
} as const;