import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";
const firebaseConfig = {
  apiKey: "AIzaSyBe4qKoMbia4kR8nEk2qxITvpKZz1XMO9c",
  authDomain: "roomio-admin.firebaseapp.com",
  projectId: "roomio-admin",
  storageBucket: "roomio-admin.appspot.com",
  messagingSenderId: "607134762324",
  appId: "1:607134762324:web:37cf93ccb9461a9a7374c1",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
