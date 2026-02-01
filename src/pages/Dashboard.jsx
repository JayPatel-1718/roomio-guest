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

const LAUNDRY_COOLDOWN_MS = 60 * 60 * 1000; // ✅ 1 hour for laundry
const HOUSEKEEPING_COOLDOWN_MS = 60 * 60 * 1000; // ✅ 1 hour for housekeeping

function formatRemaining(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function formatTimeForProgress(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export default function Dashboard() {
  const { state } = useLocation();
  const navigate = useNavigate();

  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);
  
  // ✅ Arrival notification modal
  const [showArrivalNotification, setShowArrivalNotification] = useState(false);
  const [arrivalService, setArrivalService] = useState("");
  const [arrivalRequestId, setArrivalRequestId] = useState("");

  // ✅ Completion notification modal
  const [showCompletionModal, setShowCompletionModal] = useState(false);
  const [completedService, setCompletedService] = useState("");
  const [completedOrderId, setCompletedOrderId] = useState("");

  // ✅ Tabs
  const [activeTab, setActiveTab] = useState("services"); // "services" | "requests" | "food"

  // ✅ Request tracking state
  const [requestIds, setRequestIds] = useState([]);
  const [requestsMap, setRequestsMap] = useState({}); // { [id]: {id, ...data} }
  const unsubRef = useRef(new Map()); // Map<id, unsubscribe>
  
  // ✅ Food order tracking state - BOTH collections
  const [foodRequestIds, setFoodRequestIds] = useState([]);
  const [foodRequestsMap, setFoodRequestsMap] = useState({});
  const foodRequestUnsubRef = useRef(null);
  
  // ✅ Food orders from menu
  const [foodOrderIds, setFoodOrderIds] = useState([]);
  const [foodOrdersMap, setFoodOrdersMap] = useState({});
  const foodOrderUnsubRef = useRef(null);
  
  // ✅ Timer refs for progress bars
  const timerRefs = useRef(new Map()); // Map<id, intervalId>

  // ✅ Laundry cooldown state
  const [laundryBlocked, setLaundryBlocked] = useState(false);
  const [laundryRemainingMs, setLaundryRemainingMs] = useState(0);
  
  // ✅ Housekeeping cooldown state
  const [housekeepingBlocked, setHousekeepingBlocked] = useState(false);
  const [housekeepingRemainingMs, setHousekeepingRemainingMs] = useState(0);

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

  // 🔑 localStorage keys
  const storageKey = useMemo(() => {
    if (!adminId) return null;
    if (!safeMobile || safeMobile === "—") return null;
    if (roomNumberForQuery === null || roomNumberForQuery === "—") return null;
    return `roomio:requests:${adminId}:${safeMobile}:${roomNumberForQuery}`;
  }, [adminId, safeMobile, roomNumberForQuery]);

  const foodRequestsStorageKey = useMemo(() => {
    if (!adminId) return null;
    if (!safeMobile || safeMobile === "—") return null;
    if (roomNumberForQuery === null || roomNumberForQuery === "—") return null;
    return `roomio:foodRequests:${adminId}:${safeMobile}:${roomNumberForQuery}`;
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
    const next = [id, ...current.filter((x) => x !== id)].slice(0, 30);
    saveStoredRequestIds(next);
    setRequestIds(next);
  };

  // Load stored food request IDs (from serviceRequests)
  const loadStoredFoodRequestIds = () => {
    if (!foodRequestsStorageKey) return [];
    try {
      const raw = localStorage.getItem(foodRequestsStorageKey);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  };

  const saveStoredFoodRequestIds = (ids) => {
    if (!foodRequestsStorageKey) return;
    try {
      localStorage.setItem(foodRequestsStorageKey, JSON.stringify(ids));
    } catch {}
  };

  const addFoodRequestIdToStorage = (id) => {
    if (!foodRequestsStorageKey) return;
    const current = loadStoredFoodRequestIds();
    const next = [id, ...current.filter((x) => x !== id)].slice(0, 30);
    saveStoredFoodRequestIds(next);
    setFoodRequestIds(next);
  };

  // Load stored food order IDs (from menu)
  const loadStoredFoodOrderIds = () => {
    if (!foodOrdersStorageKey) return [];
    try {
      const raw = localStorage.getItem(foodOrdersStorageKey);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  };

  const saveStoredFoodOrderIds = (ids) => {
    if (!foodOrdersStorageKey) return;
    try {
      localStorage.setItem(foodOrdersStorageKey, JSON.stringify(ids));
    } catch {}
  };

  const addFoodOrderIdToStorage = (id) => {
    if (!foodOrdersStorageKey) return;
    const current = loadStoredFoodOrderIds();
    const next = [id, ...current.filter((x) => x !== id)].slice(0, 30);
    saveStoredFoodOrderIds(next);
    setFoodOrderIds(next);
  };

  const clearRequestHistory = () => {
    if (!storageKey) return;
    try {
      localStorage.removeItem(storageKey);
    } catch {}
    setRequestIds([]);
    setRequestsMap({});
    // Clear all timers
    timerRefs.current.forEach((intervalId) => clearInterval(intervalId));
    timerRefs.current.clear();
  };

  const clearFoodOrderHistory = () => {
    if (!foodRequestsStorageKey || !foodOrdersStorageKey) return;
    try {
      localStorage.removeItem(foodRequestsStorageKey);
      localStorage.removeItem(foodOrdersStorageKey);
    } catch {}
    setFoodRequestIds([]);
    setFoodRequestsMap({});
    setFoodOrderIds([]);
    setFoodOrdersMap({});
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
    
    const foodReqIds = loadStoredFoodRequestIds();
    setFoodRequestIds(foodReqIds);
    
    const foodOrderIds = loadStoredFoodOrderIds();
    setFoodOrderIds(foodOrderIds);
  }, [state, storageKey, foodRequestsStorageKey, foodOrdersStorageKey]);

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
  const calculateProgress = (request) => {
    if (!request.estimatedTime) {
      return { percentage: 0, remainingMs: request.estimatedTime ? request.estimatedTime * 60 * 1000 : 0 };
    }
    
    if (!request.acceptedAt) {
      return { percentage: 0, remainingMs: request.estimatedTime * 60 * 1000 };
    }
    
    let acceptedTime;
    
    // Check if acceptedAt is a Firestore Timestamp
    if (request.acceptedAt.toMillis) {
      acceptedTime = request.acceptedAt.toMillis();
    } 
    // Check if it's a string timestamp
    else if (typeof request.acceptedAt === 'string') {
      acceptedTime = new Date(request.acceptedAt).getTime();
    }
    // Check if it's a number
    else if (typeof request.acceptedAt === 'number') {
      acceptedTime = request.acceptedAt;
    }
    // Fallback to current time
    else {
      acceptedTime = Date.now();
    }
    
    const estimatedMs = request.estimatedTime * 60 * 1000; // Convert minutes to ms
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
    
    Object.values(requestsMap).forEach(request => {
      if ((request.status === "in-progress") && 
          !request.arrivalNotified && 
          request.estimatedTime) {
        
        const acceptedTime = request.acceptedAt?.toMillis?.() || Date.now();
        const estimatedMs = request.estimatedTime * 60 * 1000;
        const timeUntilArrival = acceptedTime + estimatedMs - now;
        
        // Show notification 2 minutes before arrival
        if (timeUntilArrival > 0 && timeUntilArrival <= 2 * 60 * 1000) {
          setArrivalService(request.type || "Service");
          setArrivalRequestId(request.id);
          setShowArrivalNotification(true);
          
          // Mark as notified in local state to prevent duplicate notifications
          setRequestsMap(prev => ({
            ...prev,
            [request.id]: { ...prev[request.id], arrivalNotified: true }
          }));
        }
      }
    });
  };

  // ✅ Check for food order completion notifications
  const checkFoodOrderNotifications = (request) => {
    if (request.status === "completed" && !request.completionNotified) {
      setCompletedService(request.dishName || "Food Order");
      setCompletedOrderId(request.id);
      setShowCompletionModal(true);
      
      // Mark as notified
      setFoodRequestsMap(prev => ({
        ...prev,
        [request.id]: { ...prev[request.id], completionNotified: true }
      }));
    }
  };

  // ✅ Handle arrival notification confirmation
  const handleArrivalConfirm = async () => {
    // Remove the request from local storage
    if (arrivalRequestId) {
      const updatedIds = requestIds.filter(id => id !== arrivalRequestId);
      saveStoredRequestIds(updatedIds);
      setRequestIds(updatedIds);
      
      // Update Firestore to mark as completed
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
      // Remove the request from local storage
      const updatedIds = foodRequestIds.filter(id => id !== completedOrderId);
      saveStoredFoodRequestIds(updatedIds);
      setFoodRequestIds(updatedIds);
      
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

  // ✅ Live listeners for service requests (laundry/housekeeping)
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
          
          // Skip food orders in this listener
          if (data.type === "Food Order") return;
          
          const progressData = calculateProgress(data);
          const updatedData = { 
            id, 
            ...data,
            percentage: progressData.percentage,
            remainingMs: progressData.remainingMs
          };
          
          setRequestsMap((prev) => ({
            ...prev,
            [id]: updatedData,
          }));
          
          // Start progress timer for in-progress requests with estimated time
          if (data.status === "in-progress" && 
              data.estimatedTime && 
              data.acceptedAt) {
            
            // Clear existing timer if any
            if (timerRefs.current.has(id)) {
              clearInterval(timerRefs.current.get(id));
            }
            
            const intervalId = setInterval(() => {
              setRequestsMap(prev => {
                if (!prev[id]) return prev;
                const progress = calculateProgress(prev[id]);
                return {
                  ...prev,
                  [id]: {
                    ...prev[id],
                    percentage: progress.percentage,
                    remainingMs: progress.remainingMs
                  }
                };
              });
            }, 1000);
            
            timerRefs.current.set(id, intervalId);
          }
          
          // Stop timer if request is completed or deleted
          if ((data.status === "completed" || data.status === "deleted") && 
              timerRefs.current.has(id)) {
            clearInterval(timerRefs.current.get(id));
            timerRefs.current.delete(id);
          }
        },
        (err) => {
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

  // ✅ Live listener for FOOD service requests (from admin's Tracking.tsx)
  useEffect(() => {
    if (!adminId || !safeMobile || !roomNumberForQuery) return;

    // Listen for service requests that are food orders
    const foodRequestsQuery = query(
      collection(db, "serviceRequests"),
      where("adminId", "==", adminId),
      where("guestMobile", "==", safeMobile),
      where("roomNumber", "==", roomNumberForQuery),
      where("type", "==", "Food Order")
    );

    // Clean up previous listener
    if (foodRequestUnsubRef.current) {
      foodRequestUnsubRef.current();
    }

    const unsubscribe = onSnapshot(
      foodRequestsQuery,
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          const request = { id: change.doc.id, ...change.doc.data() };
          
          if (change.type === "added" || change.type === "modified") {
            // Add to storage if this is a new request
            if (change.type === "added") {
              addFoodRequestIdToStorage(request.id);
            }
            
            // Calculate progress
            const progressData = calculateProgress(request);
            const updatedRequest = {
              ...request,
              percentage: progressData.percentage,
              remainingMs: progressData.remainingMs
            };
            
            // Update food requests map
            setFoodRequestsMap(prev => ({
              ...prev,
              [request.id]: updatedRequest
            }));
            
            // Check for completion notification
            checkFoodOrderNotifications(request);
            
            // Start progress timer for in-progress requests with estimated time
            if (request.status === "in-progress" && request.estimatedTime && request.acceptedAt) {
              // Clear existing timer if any
              if (timerRefs.current.has(`food-${request.id}`)) {
                clearInterval(timerRefs.current.get(`food-${request.id}`));
              }
              
              const intervalId = setInterval(() => {
                setFoodRequestsMap(prev => {
                  if (!prev[request.id]) return prev;
                  const progress = calculateProgress(prev[request.id]);
                  return {
                    ...prev,
                    [request.id]: {
                      ...prev[request.id],
                      percentage: progress.percentage,
                      remainingMs: progress.remainingMs
                    }
                  };
                });
              }, 1000);
              
              timerRefs.current.set(`food-${request.id}`, intervalId);
            }
            
            // Stop timer if request is completed or cancelled
            if ((request.status === "completed" || request.status === "cancelled") && 
                timerRefs.current.has(`food-${request.id}`)) {
              clearInterval(timerRefs.current.get(`food-${request.id}`));
              timerRefs.current.delete(`food-${request.id}`);
            }
          }
          
          if (change.type === "removed") {
            // Remove from local state
            setFoodRequestsMap(prev => {
              const copy = { ...prev };
              delete copy[request.id];
              return copy;
            });
            
            // Clear timer if exists
            if (timerRefs.current.has(`food-${request.id}`)) {
              clearInterval(timerRefs.current.get(`food-${request.id}`));
              timerRefs.current.delete(`food-${request.id}`);
            }
          }
        });
      },
      (error) => {
        console.error("Food service requests listener error:", error);
      }
    );

    foodRequestUnsubRef.current = unsubscribe;

    return () => {
      if (foodRequestUnsubRef.current) {
        foodRequestUnsubRef.current();
      }
      
      // Clear food request timers
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

    // Listen for food orders from the menu
    const foodOrdersQuery = query(
      collection(db, "users", adminId, "foodOrders"),
      where("guestMobile", "==", safeMobile),
      where("roomNumber", "==", roomNumberForQuery)
    );

    // Clean up previous listener
    if (foodOrderUnsubRef.current) {
      foodOrderUnsubRef.current();
    }

    const unsubscribe = onSnapshot(
      foodOrdersQuery,
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          const order = { id: change.doc.id, ...change.doc.data() };
          
          if (change.type === "added" || change.type === "modified") {
            // Add to storage if this is a new order
            if (change.type === "added") {
              addFoodOrderIdToStorage(order.id);
            }
            
            // Update food orders map
            setFoodOrdersMap(prev => ({
              ...prev,
              [order.id]: order
            }));
          }
          
          if (change.type === "removed") {
            // Remove from local state
            setFoodOrdersMap(prev => {
              const copy = { ...prev };
              delete copy[order.id];
              return copy;
            });
          }
        });
      },
      (error) => {
        console.error("Food orders listener error:", error);
      }
    );

    foodOrderUnsubRef.current = unsubscribe;

    return () => {
      if (foodOrderUnsubRef.current) {
        foodOrderUnsubRef.current();
      }
    };
  }, [adminId, safeMobile, roomNumberForQuery]);

  // ✅ Check for arrival notifications periodically
  useEffect(() => {
    const interval = setInterval(checkArrivalNotifications, 30000);
    return () => clearInterval(interval);
  }, [requestsMap]);

  // ✅ Combine all food orders for display
  const allFoodOrders = useMemo(() => {
    // Get food orders from menu
    const menuOrders = foodOrderIds
      .map((id) => foodOrdersMap[id] || { id, status: "loading", source: "menu" })
      .filter(order => order.status !== "completed" && order.status !== "cancelled")
      .map(order => ({
        ...order,
        source: "menu",
        dishName: order.item || "Food Order",
        createdMs: order?.createdAt?.toMillis?.() ?? 0,
      }));

    // Get food service requests (from admin tracking)
    const serviceFoods = foodRequestIds
      .map((id) => foodRequestsMap[id] || { id, status: "loading", source: "service" })
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
  }, [foodOrderIds, foodOrdersMap, foodRequestIds, foodRequestsMap]);

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
      
      // Start cooldown
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
    if (s === "cancelled") return { bg: "rgba(107,114,128,0.12)", text: "#6B7280", label: "CANCELLED" };
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
          <button
            className="tapButton"
            onClick={() => setActiveTab("food")}
            style={{
              ...styles.tabBtn,
              ...(activeTab === "food" ? styles.tabBtnActive : null),
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
                      
                      {/* ✅ PROGRESS BAR FOR IN-PROGRESS REQUESTS */}
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
                disabled={!allFoodOrders.length}
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
                  // Determine status based on source
                  let status = order.status;
                  let showProgress = false;
                  let estimatedTime = order.estimatedTime;
                  let percentage = order.percentage || 0;
                  let remainingMs = order.remainingMs || 0;
                  
                  // For menu orders that are accepted, check if there's a corresponding service request
                  if (order.source === "menu" && order.status === "accepted") {
                    // Look for corresponding service request
                    const matchingService = Object.values(foodRequestsMap).find(
                      req => req.foodOrderId === order.id || 
                      (req.guestMobile === safeMobile && 
                       req.roomNumber === safeRoomNumber &&
                       req.dishName === order.item)
                    );
                    
                    if (matchingService) {
                      status = matchingService.status;
                      estimatedTime = matchingService.estimatedTime;
                      percentage = matchingService.percentage || 0;
                      remainingMs = matchingService.remainingMs || 0;
                      showProgress = matchingService.status === "in-progress";
                    }
                  }
                  
                  // For service requests
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
                      
                      {/* ✅ PROGRESS BAR FOR IN-PROGRESS ORDERS */}
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
                      
                      {/* ✅ PENDING MESSAGE */}
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
                      
                      {/* ✅ ACCEPTED BUT NOT STARTED */}
                      {isAccepted && !showProgress && (
                        <div style={styles.acceptedMessage}>
                          <span style={styles.acceptedIcon}>✅</span>
                          <span style={styles.acceptedText}>Order accepted, preparation will start soon</span>
                        </div>
                      )}
                      
                      {/* ✅ COMPLETED MESSAGE */}
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
      @keyframes pulse {
        0% { transform: scale(1); }
        50% { transform: scale(1.1); }
        100% { transform: scale(1); }
      }
    `}</style>
  );
}

const styles = {
  // ✅ Tab Row Styles (updated for 3 tabs)
  tabRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: 10,
    marginBottom: 12,
  },
  tabBtn: {
    height: 44,
    borderRadius: 14,
    border: "1px solid #E5E7EB",
    backgroundColor: "#fff",
    fontWeight: 900,
    color: "#6B7280",
    cursor: "pointer",
    boxShadow: "0 2px 10px rgba(17, 24, 39, 0.05)",
    fontSize: 12,
  },
  tabBtnActive: {
    backgroundColor: "#2563EB",
    borderColor: "#2563EB",
    color: "#fff",
  },
  tabBadge: {
    marginLeft: 8,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 18,
    height: 18,
    padding: "0 6px",
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.25)",
    color: "#fff",
    fontSize: 12,
    fontWeight: 900,
  },
  
  // ✅ Completion Notification Styles
  completionOverlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
    padding: 20,
  },
  completionModal: {
    backgroundColor: "#fff",
    borderRadius: 24,
    padding: 30,
    maxWidth: 400,
    width: "100%",
    textAlign: "center",
    boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
    border: "2px solid #16A34A",
  },
  completionIcon: {
    fontSize: 60,
    marginBottom: 20,
    animation: "pulse 1.5s infinite",
  },
  completionTitle: {
    fontSize: 24,
    fontWeight: 900,
    color: "#111827",
    marginBottom: 12,
  },
  completionMessage: {
    fontSize: 16,
    color: "#6B7280",
    marginBottom: 24,
    lineHeight: 1.5,
  },
  completionActions: {
    display: "flex",
    gap: 12,
  },
  completionConfirmBtn: {
    flex: 1,
    backgroundColor: "#16A34A",
    color: "#fff",
    border: "none",
    padding: "16px 24px",
    borderRadius: 14,
    fontSize: 16,
    fontWeight: 900,
    cursor: "pointer",
    transition: "all 0.2s ease",
  },
  
  // ✅ Accepted Message Styles
  acceptedMessage: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "rgba(37, 99, 235, 0.12)",
    border: "1px solid rgba(37, 99, 235, 0.25)",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  acceptedIcon: {
    fontSize: 16,
    color: "#2563EB",
  },
  acceptedText: {
    color: "#2563EB",
    fontWeight: 800,
    fontSize: 13,
  },
  
  // ✅ Pending Message Styles
  pendingMessage: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "rgba(245, 158, 11, 0.12)",
    border: "1px solid rgba(245, 158, 11, 0.25)",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  pendingIcon: {
    fontSize: 16,
    color: "#F59E0B",
  },
  pendingText: {
    color: "#F59E0B",
    fontWeight: 800,
    fontSize: 13,
  },
  
  // ✅ Completed Message Styles
  completedMessage: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "rgba(22, 163, 74, 0.12)",
    border: "1px solid rgba(22, 163, 74, 0.25)",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  completedIcon: {
    fontSize: 16,
    color: "#16A34A",
  },
  completedText: {
    color: "#16A34A",
    fontWeight: 800,
    fontSize: 13,
  },
  
  // ✅ Notes Styles
  reqNotes: {
    marginTop: 8,
    padding: 10,
    backgroundColor: "#F9FAFB",
    borderRadius: 8,
    fontSize: 13,
    color: "#6B7280",
    borderLeft: "3px solid #F59E0B",
  },
  
  // ✅ Arrival Notification Styles
  arrivalOverlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
    padding: 20,
  },
  arrivalModal: {
    backgroundColor: "#fff",
    borderRadius: 24,
    padding: 30,
    maxWidth: 400,
    width: "100%",
    textAlign: "center",
    boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
    border: "2px solid #2563EB",
  },
  arrivalIcon: {
    fontSize: 60,
    marginBottom: 20,
    animation: "pulse 1.5s infinite",
  },
  arrivalTitle: {
    fontSize: 24,
    fontWeight: 900,
    color: "#111827",
    marginBottom: 12,
  },
  arrivalMessage: {
    fontSize: 16,
    color: "#6B7280",
    marginBottom: 24,
    lineHeight: 1.5,
  },
  arrivalActions: {
    display: "flex",
    gap: 12,
  },
  arrivalConfirmBtn: {
    flex: 1,
    backgroundColor: "#16A34A",
    color: "#fff",
    border: "none",
    padding: "16px 24px",
    borderRadius: 14,
    fontSize: 16,
    fontWeight: 900,
    cursor: "pointer",
    transition: "all 0.2s ease",
  },
  
  // ✅ Progress Bar Styles
  progressSection: {
    marginTop: 16,
    padding: 14,
    backgroundColor: "#F9FAFB",
    borderRadius: 12,
    border: "1px solid #E5E7EB",
  },
  progressHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  progressLabel: {
    fontSize: 13,
    fontWeight: 800,
    color: "#111827",
  },
  progressPercentage: {
    fontSize: 13,
    fontWeight: 900,
    color: "#2563EB",
  },
  progressBar: {
    height: 8,
    backgroundColor: "#E5E7EB",
    borderRadius: 4,
    overflow: "hidden",
    marginBottom: 8,
  },
  progressFill: {
    height: "100%",
    borderRadius: 4,
    transition: "width 1s ease",
  },
  progressSubtext: {
    fontSize: 11,
    color: "#6B7280",
    fontWeight: 700,
  },
  
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