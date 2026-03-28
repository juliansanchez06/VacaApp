import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { auth } from './firebase';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { 
  PieChart, Pie, Cell, Tooltip as RTooltip, ResponsiveContainer, 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend 
} from 'recharts';
import { 
  TrendingUp, DollarSign, Percent, Calendar, ChevronRight, 
  BarChart3, Info, LogOut, Home, Calculator, History, Settings,
  ArrowLeft, ChevronDown, CheckCircle2, AlertCircle
} from 'lucide-react';

// --- TU CÓDIGO DE LOGO Y COMPONENTES (Copiá y pegá aquí tus componentes como PoderDeCompra, etc.) ---

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [vistaActual, setVistaActual] = useState('inicio');

  // Lógica de Seguridad
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setLoginError("Email o clave incorrectos.");
    }
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-slate-900 text-white">Cargando VacaApp...</div>;

  // PANTALLA DE LOGIN
  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900 p-4">
        <form onSubmit={handleLogin} className="bg-white p-8 rounded-2xl shadow-2xl w-full max-w-md border-t-4 border-blue-600">
          <h1 className="text-3xl font-black text-slate-800 text-center mb-2">VacaApp</h1>
          <p className="text-slate-500 text-center mb-8 font-medium">Gestión Ganadera Profesional</p>
          {loginError && <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm border border-red-100">{loginError}</div>}
          <div className="space-y-4">
            <input type="email" placeholder="Email" className="w-full p-3 border rounded-xl" onChange={(e) => setEmail(e.target.value)} required />
            <input type="password" placeholder="Contraseña" className="w-full p-3 border rounded-xl" onChange={(e) => setPassword(e.target.value)} required />
            <button type="submit" className="w-full bg-blue-600 text-white p-4 rounded-xl font-bold hover:bg-blue-700 transition shadow-lg">Entrar</button>
          </div>
        </form>
      </div>
    );
  }

  // PANEL DE INICIO (DASHBOARD)
  if (vistaActual === 'inicio') {
    return (
      <div className="min-h-screen bg-slate-50 p-6 md:p-12">
        <div className="max-w-6xl mx-auto">
          <div className="flex justify-between items-center mb-10">
            <div>
              <h2 className="text-3xl font-black text-slate-800">Hola, {user.email.split('@')[0]}</h2>
              <p className="text-slate-500 font-medium">¿Qué vamos a calcular hoy?</p>
            </div>
            <button onClick={() => signOut(auth)} className="flex items-center gap-2 text-slate-500 hover:text-red-600 font-medium transition">
              <LogOut size={20} /> Salir
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <button onClick={() => setVistaActual('poder')} className="bg-white p-8 rounded-3xl shadow-sm border border-slate-200 hover:shadow-xl hover:border-blue-400 transition-all text-left group">
              <div className="bg-blue-100 text-blue-600 w-14 h-14 rounded-2xl flex items-center justify-center mb-6 group-hover:bg-blue-600 group-hover:text-white transition-colors">
                <DollarSign size={28} />
              </div>
              <h3 className="text-xl font-bold text-slate-800 mb-2">Poder de Compra</h3>
              <p className="text-slate-500 text-sm">Calculá cuánto podés pagar según tus gastos.</p>
            </button>

            <button onClick={() => setVistaActual('vientres')} className="bg-white p-8 rounded-3xl shadow-sm border border-slate-200 hover:shadow-xl hover:border-emerald-400 transition-all text-left group">
              <div className="bg-emerald-100 text-emerald-600 w-14 h-14 rounded-2xl flex items-center justify-center mb-6 group-hover:bg-emerald-600 group-hover:text-white transition-colors">
                <Calculator size={28} />
              </div>
              <h3 className="text-xl font-bold text-slate-800 mb-2">Proyecto Vientres</h3>
              <p className="text-slate-500 text-sm">Simulá la inversión en vacas y proyecciones.</p>
            </button>

            <button onClick={() => setVistaActual('invernada')} className="bg-white p-8 rounded-3xl shadow-sm border border-slate-200 hover:shadow-xl hover:border-orange-400 transition-all text-left group">
              <div className="bg-orange-100 text-orange-600 w-14 h-14 rounded-2xl flex items-center justify-center mb-6 group-hover:bg-orange-600 group-hover:text-white transition-colors">
                <TrendingUp size={28} />
              </div>
              <h3 className="text-xl font-bold text-slate-800 mb-2">Comp. Invernada</h3>
              <p className="text-slate-500 text-sm">Analizá márgenes y rinde de invernada.</p>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // VISTA DE LOS SIMULADORES
  return (
    <div className="min-h-screen bg-slate-50 pb-20 font-sans">
      <nav className="bg-white border-b border-slate-200 p-4 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <button onClick={() => setVistaActual('inicio')} className="flex items-center gap-2 text-slate-600 font-bold hover:text-blue-600 transition">
            <ArrowLeft size={20} /> Volver al Inicio
          </button>
          <span className="bg-slate-100 px-4 py-1 rounded-full text-slate-500 text-sm font-bold uppercase tracking-wider">
            {vistaActual.replace('invernada', 'Invernada').replace('poder', 'Poder de Compra').replace('vientres', 'Vientres')}
          </span>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto p-4 md:p-8">
        {/* AQUÍ VA LA LÓGICA DE TUS SIMULADORES (PoderDeCompra, etc.) */}
      </main>
    </div>
  );
}

export default App;
