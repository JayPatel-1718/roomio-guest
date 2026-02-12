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
  const [logoutReason, setLogoutReason] = useState("");

  const [showArrivalNotification, setShowArrivalNotification] = useState(false);
  const [arrivalService, setArrivalService] = useState("");
  const [arrivalRequestId, setArrivalRequestId] = useState("");

  const [showCompletionModal, setShowCompletionModal] = useState(false);
  const [completedService, setCompletedService] = useState("");
  const [completedOrderId, setCompletedOrderId] = useState("");

  const [activeTab, setActiveTab] = useState("services");

  const [requestIds, setRequestIds] = useState([]);
  const [requestsMap, setRequestsMap] = useState({});
  const unsubRef = useRef(new Map());

  const [orderIds, setOrderIds] = useState([]);
  const [ordersMap, setOrdersMap] = useState({});
  const ordersUnsubRef = useRef(null);

  const timerRefs = useRef(new Map());

  const [serviceCharges, setServiceCharges] = useState({
    laundry: 150,
    housekeeping: 100,
  });

  const [requestCounts, setRequestCounts] = useState({
    laundry: 0,
    housekeeping: 0
  });

  const [showChargesModal, setShowChargesModal] = useState(false);
  const [selectedService, setSelectedService] = useState("");
  const [selectedServiceCharge, setSelectedServiceCharge] = useState(0);
  const [confirmationInProgress, setConfirmationInProgress] = useState(false);
  const [freeRequestsUsed, setFreeRequestsUsed] = useState(false);

  const heartbeatIntervalRef = useRef(null);

  useEffect(() => {
    if (!state) navigate("/guest");
  }, [state, navigate]);

  const safeGuestName = state?.guestName || "Guest";
  const safeRoomNumber = state?.roomNumber ?? "—";
  const safeMobile = state?.guestMobile || state?.mobile || "—";
  const safeAdminEmail = state?.adminEmail || "—";
  const adminId = state?.adminId || null;
  const roomNumberForQuery = state?.roomNumber ?? null;
  const guestId = state?.guestId || null;

  const maskedAdmin = useMemo(() => {
    if (!safeAdminEmail || safeAdminEmail === "—") return "—";
    const [name, domain] = safeAdminEmail.split("@");
    if (!domain) return safeAdminEmail;
    return `${name.slice(0, 2)}***@${domain}`;
  }, [safeAdminEmail]);

  const storageKey = useMemo(() => {
    if (!adminId) return null;
    if (!safeMobile || safeMobile === "—") return null;
    if (roomNumberForQuery === null || roomNumberForQuery === "—") return null;
    return `roomio:requests:${adminId}:${safeMobile}:${roomNumberForQuery}`;
  }, [adminId, safeMobile, roomNumberForQuery]);

  const ordersStorageKey = useMemo(() => {
    if (!adminId) return null;
    if (!safeMobile || safeMobile === "—") return null;
    if (roomNumberForQuery === null || roomNumberForQuery === "—") return null;
    return `roomio:orders:${adminId}:${safeMobile}:${roomNumberForQuery}`;
  }, [adminId, safeMobile, roomNumberForQuery]);

  const requestCountsKey = useMemo(() => {
    if (!adminId) return null;
    if (!safeMobile || safeMobile === "—") return null;
    if (roomNumberForQuery === null || roomNumberForQuery === "—") return null;
    return `roomio:requestCounts:${adminId}:${safeMobile}:${roomNumberForQuery}`;
  }, [adminId, safeMobile, roomNumberForQuery]);

  const sendHeartbeat = async () => {
    if (!guestId) return;
    try {
      await updateDoc(doc(db, "guests", guestId), {
        lastActive: serverTimestamp()
      });
    } catch (e) {
      console.error("Heartbeat failed:", e);
    }
  };

  useEffect(() => {
    if (guestId) {
      sendHeartbeat();
      heartbeatIntervalRef.current = setInterval(sendHeartbeat, 30000);
    }

    return () => {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }
    };
  }, [guestId]);

  useEffect(() => {
    if (!requestCountsKey) return;
    
    try {
      const stored = localStorage.getItem(requestCountsKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        setRequestCounts(parsed);
        const anyFreeUsed = Object.values(parsed).some(count => count >= 2);
        setFreeRequestsUsed(anyFreeUsed);
      }
    } catch (error) {
      console.error("Failed to load request counts:", error);
    }
  }, [requestCountsKey]);

  useEffect(() => {
    if (!requestCountsKey) return;
    
    try {
      localStorage.setItem(requestCountsKey, JSON.stringify(requestCounts));
      const anyFreeUsed = Object.values(requestCounts).some(count => count >= 2);
      setFreeRequestsUsed(anyFreeUsed);
    } catch (error) {
      console.error("Failed to save request counts:", error);
    }
  }, [requestCounts, requestCountsKey]);

  const shouldChargeForService = (serviceType) => {
    const serviceKey = serviceType.toLowerCase();
    return (requestCounts[serviceKey] || 0) >= 2;
  };

  const getServiceCharge = (serviceType) => {
    const serviceKey = serviceType.toLowerCase();
    const count = requestCounts[serviceKey] || 0;
    
    if (count < 2) {
      return 0;
    }
    
    if (serviceType === "Laundry") return serviceCharges.laundry;
    if (serviceType === "Housekeeping") return serviceCharges.housekeeping;
    return 0;
  };

  const getServiceSubtitle = (serviceType) => {
    const serviceKey = serviceType.toLowerCase();
    const count = requestCounts[serviceKey] || 0;
    const remainingFree = Math.max(0, 2 - count);
    
    if (remainingFree > 0) {
      return `${remainingFree} free remaining, then ₹${serviceCharges[serviceKey]}`;
    }
    return `₹${serviceCharges[serviceKey]} per request`;
  };

  const cleanupSession = async () => {
    if (!guestId) return;

    try {
      await updateDoc(doc(db, "guests", guestId), {
        isLoggedIn: false,
        lastLogout: serverTimestamp()
      });
      console.log("Session cleaned up successfully");
    } catch (e) {
      console.error("Failed to cleanup session:", e);
    }
  };

  const handleLogout = async () => {
    await cleanupSession();

    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
    }

    navigate("/guest", { 
      state: { 
        admin: safeAdminEmail 
      } 
    });
  };

  useEffect(() => {
    if (!guestId || !adminId || !safeMobile) return;

    const guestDocRef = doc(db, "guests", guestId);

    const unsubscribe = onSnapshot(guestDocRef, (snapshot) => {
      if (!snapshot.exists()) {
        setSessionExpired(true);
        setLogoutReason("Your booking has been removed by the admin.");
        alert("Your session has expired. Admin has checked you out.");
        navigate("/guest", { replace: true });
        return;
      }

      const guestData = snapshot.data();
      
      if (!guestData.isActive) {
        setSessionExpired(true);
        setLogoutReason("Your booking is no longer active. Please contact reception.");
        alert("Your booking is no longer active. Please contact reception.");
        navigate("/guest", { replace: true });
        return;
      }

      if (guestData.isLoggedIn === false) {
        const isLoggingOut = sessionExpired === true;
        if (!isLoggingOut) {
          setSessionExpired(true);
          setLogoutReason("Someone else logged in with your mobile number. Your session has been terminated.");
          alert("Someone else logged in with your mobile number. Your session has been terminated.");
          navigate("/guest", { replace: true });
        }
        return;
      }

      const checkout = guestData.checkoutAt?.toDate?.();
      if (checkout && checkout < new Date()) {
        setSessionExpired(true);
        setLogoutReason("Your booking has expired.");
        alert("Your booking has expired. Please contact reception for extension.");
        navigate("/guest", { replace: true });
        return;
      }
    }, (error) => {
      console.error("Session monitoring error:", error);
    });

    return () => unsubscribe();
  }, [guestId, adminId, safeMobile, navigate, sessionExpired]);

  useEffect(() => {
    const handleBeforeUnload = async () => {
      await cleanupSession();
    };

    const handleUnload = async () => {
      await cleanupSession();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('unload', handleUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('unload', handleUnload);
    };
  }, [guestId]);

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

  const loadStoredOrderIds = () => {
    if (!ordersStorageKey) return [];
    try {
      const raw = localStorage.getItem(ordersStorageKey);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  };

  const saveStoredOrderIds = (ids) => {
    if (!ordersStorageKey) return;
    try {
      localStorage.setItem(ordersStorageKey, JSON.stringify(ids));
    } catch {}
  };

  const addOrderIdToStorage = (id) => {
    if (!ordersStorageKey) return;
    const current = loadStoredOrderIds();
    const next = [id, ...current.filter((x) => x !== id)].slice(0, 30);
    saveStoredOrderIds(next);
    setOrderIds(next);
  };

  const clearRequestHistory = () => {
    if (!storageKey) return;
    try {
      localStorage.removeItem(storageKey);
    } catch {}
    setRequestIds([]);
    setRequestsMap({});
    timerRefs.current.forEach((intervalId) => clearInterval(intervalId));
    timerRefs.current.clear();
  };

  const clearOrderHistory = () => {
    if (!ordersStorageKey) return;
    try {
      localStorage.removeItem(ordersStorageKey);
    } catch {}
    setOrderIds([]);
    setOrdersMap({});
  };

  const bookingQuery = useMemo(() => {
    if (!adminId) return null;
    if (!safeMobile || safeMobile === "—") return null;
    if (roomNumberForQuery === null || roomNumberForQuery === "—") return null;

    return query(
      collection(db, "guests"),
      where("adminId", "==", adminId),
      where("guestMobile", "==", safeMobile),
      where("roomNumber", "==", roomNumberForQuery),
      where("isActive", "==", true)
    );
  }, [adminId, safeMobile, roomNumberForQuery]);

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

  useEffect(() => {
    if (!state) return;
    const ids = loadStoredRequestIds();
    setRequestIds(ids);

    const orderIds = loadStoredOrderIds();
    setOrderIds(orderIds);
  }, [state, storageKey, ordersStorageKey]);

  const calculateProgress = (request) => {
    if (!request?.estimatedTime) {
      return { percentage: 0, remainingMs: request?.estimatedTime ? request.estimatedTime * 60 * 1000 : 0 };
    }

    if (!request.acceptedAt) {
      return { percentage: 0, remainingMs: request.estimatedTime * 60 * 1000 };
    }

    let acceptedTime;

    if (request.acceptedAt.toMillis) {
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

  const checkArrivalNotifications = () => {
    const now = Date.now();

    Object.values(requestsMap).forEach(request => {
      if ((request.status === "in-progress") && 
          !request.arrivalNotified && 
          request.estimatedTime) {
        
        const acceptedTime = request.acceptedAt?.toMillis?.() || Date.now();
        const estimatedMs = request.estimatedTime * 60 * 1000;
        const timeUntilArrival = acceptedTime + estimatedMs - now;
        
        if (timeUntilArrival > 0 && timeUntilArrival <= 2 * 60 * 1000) {
          setArrivalService(request.type || "Service");
          setArrivalRequestId(request.id);
          setShowArrivalNotification(true);
          
          setRequestsMap(prev => ({
            ...prev,
            [request.id]: { ...prev[request.id], arrivalNotified: true }
          }));
        }
      }
    });
  };

  const handleArrivalConfirm = async () => {
    if (arrivalRequestId) {
      const updatedIds = requestIds.filter(id => id !== arrivalRequestId);
      saveStoredRequestIds(updatedIds);
      setRequestIds(updatedIds);

      try {
        await updateDoc(doc(db, "serviceRequests", arrivalRequestId), {
          status: "completed",
          completedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        console.error("Failed to update request status:", error);
      }
      
      if (timerRefs.current.has(arrivalRequestId)) {
        clearInterval(timerRefs.current.get(arrivalRequestId));
        timerRefs.current.delete(arrivalRequestId);
      }
    }

    setShowArrivalNotification(false);
    setArrivalService("");
    setArrivalRequestId("");
  };

  const handleCompletionConfirm = () => {
    if (completedOrderId) {
      const updatedIds = orderIds.filter(id => id !== completedOrderId);
      saveStoredOrderIds(updatedIds);
      setOrderIds(updatedIds);

      if (timerRefs.current.has(`order-${completedOrderId}`)) {
        clearInterval(timerRefs.current.get(`order-${completedOrderId}`));
        timerRefs.current.delete(`order-${completedOrderId}`);
      }
    }

    setShowCompletionModal(false);
    setCompletedService("");
    setCompletedOrderId("");
  };

  const showChargesConfirmation = (service, charge) => {
    setSelectedService(service);
    setSelectedServiceCharge(charge);
    setShowChargesModal(true);
  };

  const handleServiceConfirmation = async () => {
    setConfirmationInProgress(true);
    setShowChargesModal(false);
    
    if (selectedService === "Laundry") {
      await requestLaundryPickup(true);
    } else if (selectedService === "Housekeeping") {
      await requestHousekeeping(true);
    }
    
    setConfirmationInProgress(false);
    setSelectedService("");
    setSelectedServiceCharge(0);
  };

  const requestLaundryPickup = async (confirmed = false) => {
    if (!adminId) {
      alert("Missing adminId. Please verify again from QR.");
      return;
    }

    if (!bookingQuery) {
      alert("Booking not active. Please verify again.");
      navigate("/guest");
      return;
    }

    const chargeAmount = getServiceCharge("Laundry");
    const needsCharges = chargeAmount > 0;
    
    if (needsCharges && !confirmed) {
      showChargesConfirmation("Laundry", chargeAmount);
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
        charges: chargeAmount,
        currency: "INR",
        isFreeRequest: chargeAmount === 0,
        requestNumber: (requestCounts.laundry || 0) + 1,
      });

      addRequestIdToStorage(docRef.id);
      
      setRequestCounts(prev => ({
        ...prev,
        laundry: (prev.laundry || 0) + 1
      }));
      
      showToast(chargeAmount === 0 ? "✅ Free laundry pickup request sent!" : "✅ Laundry pickup request sent!");
      setActiveTab("requests");
    } catch (err) {
      console.error("Laundry request error:", err);
      alert("Failed to send request. Check internet / permissions.");
    } finally {
      setSending(false);
    }
  };

  const requestHousekeeping = async (confirmed = false) => {
    if (!adminId) {
      alert("Missing adminId. Please verify again from QR.");
      return;
    }

    if (!bookingQuery) {
      alert("Booking not active. Please verify again.");
      navigate("/guest");
      return;
    }

    const chargeAmount = getServiceCharge("Housekeeping");
    const needsCharges = chargeAmount > 0;
    
    if (needsCharges && !confirmed) {
      showChargesConfirmation("Housekeeping", chargeAmount);
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
        charges: chargeAmount,
        currency: "INR",
        isFreeRequest: chargeAmount === 0,
        requestNumber: (requestCounts.housekeeping || 0) + 1,
      });

      addRequestIdToStorage(docRef.id);

      setRequestCounts(prev => ({
        ...prev,
        housekeeping: (prev.housekeeping || 0) + 1
      }));

      showToast(chargeAmount === 0 ? "✅ Free housekeeping request sent!" : "✅ Housekeeping request sent!");
      setActiveTab("requests");
    } catch (err) {
      console.error("Housekeeping request error:", err);
      alert("Failed to send request. Check internet / permissions.");
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    const existing = unsubRef.current;

    for (const [id, unsub] of existing.entries()) {
      if (!requestIds.includes(id)) {
        try {
          unsub();
        } catch {}
        existing.delete(id);
      }
    }

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
          
          if (data.status === "in-progress" && 
              data.estimatedTime && 
              data.acceptedAt) {
            
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

  useEffect(() => {
    if (!adminId || !roomNumberForQuery || !safeMobile) return;

    const ordersQuery = query(
      collection(db, "foodOrders"),
      where("adminId", "==", adminId),
      where("roomNumber", "==", roomNumberForQuery),
      where("guestMobile", "==", safeMobile)
    );

    if (ordersUnsubRef.current) {
      ordersUnsubRef.current();
    }

    const unsubscribe = onSnapshot(
      ordersQuery,
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          const order = { id: change.doc.id, ...change.doc.data() };
          
          if (change.type === "added" || change.type === "modified") {
            if (change.type === "added") {
              addOrderIdToStorage(order.id);
            }
            
            const progressData = calculateProgress(order);
            const updatedOrder = {
              ...order,
              percentage: progressData.percentage,
              remainingMs: progressData.remainingMs
            };
            
            setOrdersMap(prev => ({
              ...prev,
              [order.id]: updatedOrder
            }));
            
            if (order.status === "completed" && !order.completionNotified) {
              setCompletedService(order.dishName || "Food Order");
              setCompletedOrderId(order.id);
              setShowCompletionModal(true);
              
              setOrdersMap(prev => ({
                ...prev,
                [order.id]: { ...prev[order.id], completionNotified: true }
              }));
            }
            
            if (order.status === "in-progress" && order.estimatedTime && order.acceptedAt) {
              if (timerRefs.current.has(`order-${order.id}`)) {
                clearInterval(timerRefs.current.get(`order-${order.id}`));
              }
              
              const intervalId = setInterval(() => {
                setOrdersMap(prev => {
                  if (!prev[order.id]) return prev;
                  const progress = calculateProgress(prev[order.id]);
                  return {
                    ...prev,
                    [order.id]: {
                      ...prev[order.id],
                      percentage: progress.percentage,
                      remainingMs: progress.remainingMs
                    }
                  };
                });
              }, 1000);
              
              timerRefs.current.set(`order-${order.id}`, intervalId);
            }
            
            if ((order.status === "completed" || order.status === "cancelled") && 
                timerRefs.current.has(`order-${order.id}`)) {
              clearInterval(timerRefs.current.get(`order-${order.id}`));
              timerRefs.current.delete(`order-${order.id}`);
            }
          }
          
          if (change.type === "removed") {
            setOrdersMap(prev => {
              const copy = { ...prev };
              delete copy[order.id];
              return copy;
            });
            
            if (timerRefs.current.has(`order-${order.id}`)) {
              clearInterval(timerRefs.current.get(`order-${order.id}`));
              timerRefs.current.delete(`order-${order.id}`);
            }
          }
        });
      },
      (error) => {
        console.error("Food orders listener error:", error);
        
        const guestOrdersQuery = query(
          collection(db, "foodOrders"),
          where("guestMobile", "==", safeMobile),
          where("roomNumber", "==", roomNumberForQuery)
        );
        
        const guestUnsub = onSnapshot(guestOrdersQuery, (snap) => {
          snap.docChanges().forEach((change) => {
            const order = { id: change.doc.id, ...change.doc.data() };
            if (change.type === "added" || change.type === "modified") {
              addOrderIdToStorage(order.id);
              
              const progressData = calculateProgress(order);
              const updatedOrder = {
                ...order,
                percentage: progressData.percentage,
                remainingMs: progressData.remainingMs
              };
              
              setOrdersMap(prev => ({
                ...prev,
                [order.id]: updatedOrder
              }));
            }
          });
        });
        
        ordersUnsubRef.current = guestUnsub;
      }
    );

    ordersUnsubRef.current = unsubscribe;

    return () => {
      if (ordersUnsubRef.current) {
        ordersUnsubRef.current();
      }
      
      timerRefs.current.forEach((intervalId, key) => {
        if (key.startsWith('order-')) {
          clearInterval(intervalId);
          timerRefs.current.delete(key);
        }
      });
    };
  }, [adminId, roomNumberForQuery, safeMobile]);

  useEffect(() => {
    const interval = setInterval(checkArrivalNotifications, 30000);
    return () => clearInterval(interval);
  }, [requestsMap]);

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

  const ordersList = useMemo(() => {
    const arr = orderIds
      .map((id) => ordersMap[id] || { id, status: "loading" })
      .map((r) => ({
        ...r,
        createdMs: r?.createdAt?.toMillis?.() ?? 0,
      }))
      .sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0));

    return arr;
  }, [orderIds, ordersMap]);

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

  const goToMenu = () => {
    navigate("/menu", { state });
  };

  if (sessionExpired) {
    return (
      <div style={styles.expiredContainer}>
        <div style={styles.expiredCard}>
          <div style={styles.expiredIcon}>🔒</div>
          <div style={styles.expiredTitle}>Session Terminated</div>
          <div style={styles.expiredMessage}>
            {logoutReason || "Your session has been terminated."}
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

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  return (
    <div style={styles.page} className="safeArea">
      <GlobalStyles />

      {showChargesModal && (
        <div style={styles.chargesOverlay}>
          <div style={styles.chargesModal}>
            <div style={styles.chargesIcon}>
              {selectedServiceCharge === 0 ? "🎁" : "💸"}
            </div>
            <div style={styles.chargesTitle}>
              {selectedServiceCharge === 0 ? "Free Service" : "Service Charges"}
            </div>
            <div style={styles.chargesMessage}>
              {selectedServiceCharge === 0 ? (
                <>
                  Your <strong>{selectedService}</strong> service is <strong>FREE</strong> (first 2 requests)
                </>
              ) : (
                <>
                  You've used your 2 free {selectedService} requests.
                  <br />
                  Additional requests cost:
                </>
              )}
            </div>
            {selectedServiceCharge > 0 && (
              <div style={styles.chargesAmount}>
                ₹{selectedServiceCharge}
              </div>
            )}
            <div style={styles.chargesNote}>
              {selectedServiceCharge === 0 
                ? "This service will not be charged to your room bill"
                : "This charge will be added to your room bill"}
            </div>
            <div style={styles.chargesActions}>
              <button
                onClick={() => setShowChargesModal(false)}
                style={styles.chargesCancelBtn}
                className="tapButton"
                disabled={confirmationInProgress}
              >
                Cancel
              </button>
              <button
                onClick={handleServiceConfirmation}
                style={{
                  ...styles.chargesConfirmBtn,
                  backgroundColor: selectedServiceCharge === 0 ? "#16A34A" : "#F59E0B"
                }}
                className="tapButton"
                disabled={confirmationInProgress}
              >
                {confirmationInProgress ? "Processing..." : selectedServiceCharge === 0 ? "Request Free Service" : "Confirm & Request"}
              </button>
            </div>
          </div>
        </div>
      )}

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
            onClick={() => setActiveTab("orders")}
            style={{
              ...styles.tabBtn,
              ...(activeTab === "orders" ? styles.tabBtnActive : null),
            }}
          >
            Orders
            {orderIds.length ? (
              <span style={styles.tabBadge}>{orderIds.length}</span>
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
              title="Laundry"
              subtitle={getServiceSubtitle("laundry")}
              accent="#2563EB"
              disabled={sending || confirmationInProgress}
              onClick={() => {
                const charge = getServiceCharge("Laundry");
                if (charge > 0) {
                  showChargesConfirmation("Laundry", charge);
                } else {
                  requestLaundryPickup(true);
                }
              }}
            />

            <ServiceCard
              icon="🧹"
              title="Housekeeping"
              subtitle={getServiceSubtitle("housekeeping")}
              accent="#F59E0B"
              disabled={sending || confirmationInProgress}
              onClick={() => {
                const charge = getServiceCharge("Housekeeping");
                if (charge > 0) {
                  showChargesConfirmation("Housekeeping", charge);
                } else {
                  requestHousekeeping(true);
                }
              }}
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
                          {r.isFreeRequest && (
                            <span style={styles.freeBadge}>
                              FREE
                            </span>
                          )}
                          {r.charges && r.charges > 0 && (
                            <span style={styles.chargesBadge}>
                              ₹{r.charges}
                            </span>
                          )}
                        </div>
                        <div style={{ ...styles.reqStatus, backgroundColor: chip.bg, color: chip.text }}>
                          {chip.label}
                        </div>
                      </div>
                      <div style={styles.reqMeta}>
                        Room {r.roomNumber ?? safeRoomNumber} • {formatTime(r.createdAt)}
                        {r.requestNumber && ` • Request #${r.requestNumber}`}
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

        {activeTab === "orders" ? (
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
                onClick={clearOrderHistory}
                style={styles.clearBtn}
                disabled={!orderIds.length}
                title="Clear order history"
              >
                Clear
              </button>
            </div>

            {orderIds.length === 0 ? (
              <div style={styles.emptyBox}>
                <div style={styles.emptyTitle}>No food orders yet</div>
                <div style={styles.emptySub}>
                  Orders placed by admin will appear here automatically.
                </div>
              </div>
            ) : (
              <div style={styles.reqList}>
                {ordersList.map((r) => {
                  const chip = statusChip(r.status);
                  const isInProgress = r.status === "in-progress";
                  const isPending = (r.status || "pending") === "pending";
                  const isCompleted = r.status === "completed";
                  const hasEstimatedTime = isInProgress && r.estimatedTime;
                  const hasProgress = hasEstimatedTime && r.percentage !== undefined;
                  
                  return (
                    <div key={r.id} style={styles.reqCard}>
                      <div style={styles.reqTop}>
                        <div style={styles.reqType}>
                          {r.dishName || "Food Order"}
                          {r.mealCategory && ` (${r.mealCategory})`}
                        </div>
                        <div style={{ ...styles.reqStatus, backgroundColor: chip.bg, color: chip.text }}>
                          {chip.label}
                        </div>
                      </div>
                      
                      {r.notes && (
                        <div style={styles.reqNotes}>
                          <strong>Notes:</strong> {r.notes}
                        </div>
                      )}
                      
                      <div style={styles.reqMeta}>
                        Room {r.roomNumber ?? safeRoomNumber} • {formatTime(r.createdAt)}
                        {r.quantity && ` • Qty: ${r.quantity}`}
                        {r.price && ` • ₹${r.price}`}
                      </div>
                      
                      {hasProgress && !isCompleted && (
                        <div style={styles.progressSection}>
                          <div style={styles.progressHeader}>
                            <span style={styles.progressLabel}>
                              Ready in {formatTimeForProgress(r.remainingMs || 0)}
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
                                backgroundColor: "#16A34A"
                              }}
                            />
                          </div>
                          <div style={styles.progressSubtext}>
                            Estimated time: {r.estimatedTime} minutes
                            {r.remainingMs > 0 && ` • ${formatTimeForProgress(r.remainingMs)} remaining`}
                          </div>
                        </div>
                      )}
                      
                      {isPending && (
                        <div style={styles.pendingMessage}>
                          <span style={styles.pendingIcon}>⏳</span>
                          <span style={styles.pendingText}>Your order is pending acceptance</span>
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
        <span style={styles.serviceActionText}>Request</span>
        <span style={styles.serviceArrow}>→</span>
      </div>
    </button>
  );
}

function GlobalStyles() {
  return (
    <style>{`
      :root{
        --sat: env(safe-area-inset-top, 0px);
        --sar: env(safe-area-inset-right, 0px);
        --sab: env(safe-area-inset-bottom, 0px);
        --sal: env(safe-area-inset-left, 0px);
      }
      html, body {
        margin: 0;
        padding: 0;
        background: #F9FAFB;
      }
      * {
        box-sizing: border-box;
        -webkit-tap-highlight-color: transparent;
      }
      .safeArea {
        padding-top: calc(16px + var(--sat));
        padding-left: calc(16px + var(--sal));
        padding-right: calc(16px + var(--sar));
        padding-bottom: calc(16px + var(--sab));
      }
      @media (max-width: 520px) {
        .pillsRow {
          grid-template-columns: 1fr !important;
        }
        .servicesGrid {
          grid-template-columns: 1fr !important;
        }
      }
      .tapCard:active {
        transform: scale(0.99);
      }
      .tapCard {
        transition: transform 120ms ease, box-shadow 120ms ease;
      }
      .tapCard:hover {
        box-shadow: 0 10px 22px rgba(17, 24, 39, 0.10);
      }
      .tapButton:active {
        transform: scale(0.98);
      }
      @keyframes pulse {
        0% { transform: scale(1); }
        50% { transform: scale(1.1); }
        100% { transform: scale(1); }
      }
    `}</style>
  );
}

const styles = {
  freeBadge: {
    marginLeft: 8,
    backgroundColor: "rgba(22, 163, 74, 0.15)",
    color: "#16A34A",
    padding: "2px 8px",
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 900,
    border: "1px solid rgba(22, 163, 74, 0.3)",
  },

  chargesOverlay: {
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
  chargesModal: {
    backgroundColor: "#fff",
    borderRadius: 24,
    padding: 30,
    maxWidth: 400,
    width: "100%",
    textAlign: "center",
    boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
  },
  chargesIcon: {
    fontSize: 60,
    marginBottom: 20,
  },
  chargesTitle: {
    fontSize: 24,
    fontWeight: 900,
    color: "#111827",
    marginBottom: 12,
  },
  chargesMessage: {
    fontSize: 16,
    color: "#6B7280",
    marginBottom: 16,
    lineHeight: 1.5,
  },
  chargesAmount: {
    fontSize: 42,
    fontWeight: 900,
    color: "#F59E0B",
    marginBottom: 16,
  },
  chargesNote: {
    fontSize: 14,
    color: "#9CA3AF",
    marginBottom: 24,
    fontStyle: "italic",
  },
  chargesActions: {
    display: "flex",
    gap: 12,
  },
  chargesCancelBtn: {
    flex: 1,
    backgroundColor: "#fff",
    color: "#6B7280",
    border: "2px solid #E5E7EB",
    padding: "16px 24px",
    borderRadius: 14,
    fontSize: 16,
    fontWeight: 900,
    cursor: "pointer",
    transition: "all 0.2s ease",
  },
  chargesConfirmBtn: {
    flex: 1,
    color: "#fff",
    border: "none",
    padding: "16px 24px",
    borderRadius: 14,
    fontSize: 16,
    fontWeight: 900,
    cursor: "pointer",
    transition: "all 0.2s ease",
  },

  chargesBadge: {
    marginLeft: 8,
    backgroundColor: "rgba(245, 158, 11, 0.15)",
    color: "#F59E0B",
    padding: "2px 8px",
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 900,
    border: "1px solid rgba(245, 158, 11, 0.3)",
  },

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

  reqNotes: {
    marginTop: 8,
    padding: 10,
    backgroundColor: "#F9FAFB",
    borderRadius: 8,
    fontSize: 13,
    color: "#6B7280",
    borderLeft: "3px solid #F59E0B",
  },

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
  pillText: { minWidth: 0 },
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
  sectionHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 10, marginBottom: 10, flexWrap: "wrap" },
  sectionLeft: { display: "flex", alignItems: "center", gap: 10 },
  sectionIcon: { width: 30, height: 30, borderRadius: 10, backgroundColor: "#2563EB", display: "flex", alignItems: "center", justifyContent: "center" },
  sectionTitle: { fontSize: 16, fontWeight: 900, color: "#111827" },
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