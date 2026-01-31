import { Routes, Route } from "react-router-dom";
import RoomAccess from "./pages/RoomAccess";
import Dashboard from "./pages/Dashboard";
import Menu from "./pages/Menu"; // ✅ Add this

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RoomAccess />} />
      <Route path="/guest" element={<RoomAccess />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/menu" element={<Menu />} /> {/* ✅ New route */}
    </Routes>
  );
}