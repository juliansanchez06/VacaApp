import React, { useState, useMemo, useEffect, useRef, useCallback, createContext, useContext } from "react";

// ─── Micro store (Zustand-like) + localStorage persist ───────────────────────
const LS_KEY = "soypekun_store_v2";

function loadFromLS(userEmail) {
  try {
    const data = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (!data) return null;
    // Si pedimos datos de un usuario específico, SOLO devolver si el localStorage
    // está firmado con ese mismo email. Si no tiene firma (datos viejos) o es de
    // otro usuario, lo ignoramos para no mezclar campos.
    if (userEmail) {
      if (!data.__owner || data.__owner !== userEmail) return null;
    }
    return data;
  } catch { return null; }
}
function saveToLS(state, userEmail) {
  try {
    // Solo guardar los datos del campo, no UI state
    const toSave = {
      global: state.global, gastos: state.gastos,
      campoCria: state.campoCria, campoRecria: state.campoRecria,
      campoTerminacion: state.campoTerminacion, campoPastaje: state.campoPastaje,
      campo: state.campo, simulaciones: state.simulaciones,
      __owner: userEmail || state.__userEmail || null,
      savedAt: Date.now(),
    };
    localStorage.setItem(LS_KEY, JSON.stringify(toSave));
  } catch (e) { console.warn("localStorage write failed:", e); }
}

// Cola de operaciones pendientes para sync offline
const QUEUE_KEY = "soypekun_pending_queue";
function loadQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch { return []; } }
function saveQueue(q) { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch {} }

let pendingQueue = loadQueue();

function enqueueSync(userEmail, state) {
  // Reemplazar cualquier operación previa del mismo usuario (última escritura gana)
  pendingQueue = pendingQueue.filter(op => op.userEmail !== userEmail);
  pendingQueue.push({ userEmail, state, timestamp: Date.now() });
  saveQueue(pendingQueue);
}

async function flushQueue() {
  if (pendingQueue.length === 0) return;
  const ops = [...pendingQueue];
  pendingQueue = [];
  saveQueue([]);
  for (const op of ops) {
    try {
      await guardarEstadoData(op.userEmail, op.state);
      console.log("✅ Sync offline → Firestore para", op.userEmail);
    } catch (e) {
      // Re-encolar si falla
      pendingQueue.push(op);
      saveQueue(pendingQueue);
      console.warn("❌ Sync failed, re-enqueued:", e.message);
    }
  }
}

// Detectar cuando vuelve la conexión y hacer flush automático
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    console.log("🌐 Conexión restaurada — sincronizando...");
    flushQueue();
  });
}

function createStore(init) {
  let state = {};
  const listeners = new Set();
  const setState = (partial) => {
    state = { ...state, ...(typeof partial === "function" ? partial(state) : partial) };
    listeners.forEach(fn => fn(state));
  };
  const getState = () => state;
  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  state = init(setState, getState);
  return { getState, setState, subscribe };
}
function useStore(store, selector = s => s) {
  const [slice, setSlice] = useState(() => selector(store.getState()));
  useEffect(() => {
    const unsub = store.subscribe(s => setSlice(selector(s)));
    return unsub;
  }, [store, selector]);
  return slice;
}
import { initializeApp } from "firebase/app";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  sendPasswordResetEmail,
} from "firebase/auth";
import {
  getFirestore,
  doc, setDoc, getDoc, collection, getDocs, writeBatch,
} from "firebase/firestore";
import { PieChart, Pie, Cell, Tooltip as RTooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { DollarSign, Calculator, TrendingUp, ArrowLeft, Wheat, Scale, Zap, Map as MapIcon, BarChart2, Plus, Minus, RefreshCw } from "lucide-react";

// ── Firebase init ─────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyAt_J0nsKI_9X69jgr_Q8R2z-KbO875nhg",
  authDomain: "vacaapp-ff72a.firebaseapp.com",
  projectId: "vacaapp-ff72a",
  storageBucket: "vacaapp-ff72a.firebasestorage.app",
  messagingSenderId: "1089865872169",
  appId: "1:1089865872169:web:836d34d16ef365a7563d38",
};
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db   = getFirestore(firebaseApp);
// Deshabilitar heartbeat y analytics automáticos que causan errores 404
try {
  firebaseApp.automaticDataCollectionEnabled = false;
} catch(e) {}

setPersistence(auth, browserLocalPersistence).catch(console.error);

// ── Guardar / cargar estado en Firestore (con soporte offline) ───────────────

function emailToKey(userEmail) {
  return userEmail.replace(/\./g, "_").replace(/@/g, "_at_");
}

// ── Subcolecciones (movimientos, simulaciones, historialAnos) ────────────────
// Estos datos crecen sin techo. NO van en el doc raíz (límite 1 MiB + reescritura
// completa del doc en cada guardado). Viven en subcolecciones y se escriben con
// DIFFING: solo se sube lo que cambió y se borra lo que se eliminó. La cache
// refleja "lo que hay en Firestore", de modo que un borrado hecho offline se
// propaga al reconectar (si no, el doc borrado reaparecería).
const _subcolCache = {
  movimientos:   new Map(),
  simulaciones:  new Map(),
  historialAnos: new Map(),
};
function resetSubcolCache() {
  _subcolCache.movimientos   = new Map();
  _subcolCache.simulaciones  = new Map();
  _subcolCache.historialAnos = new Map();
}
function setCacheDesde(nombre, entradas) {
  _subcolCache[nombre] = new Map(entradas.map(([id, data]) => [String(id), JSON.stringify(data)]));
}

// Escribe en una subcolección solo los docs nuevos/cambiados y borra los que ya
// no están. Chunkea en lotes de 450 (el límite de writeBatch es 500).
async function syncSubcoleccion(key, nombre, entradas) {
  const cache  = _subcolCache[nombre];
  const colRef = collection(db, "usuarios", key, nombre);
  const vistos = new Set();
  const cambios = [];
  for (const [rawId, data] of entradas) {
    const id = String(rawId);
    vistos.add(id);
    const json = JSON.stringify(data);
    if (cache.get(id) !== json) cambios.push({ tipo: "set", id, data, json });
  }
  for (const id of [...cache.keys()]) {
    if (!vistos.has(id)) cambios.push({ tipo: "del", id });
  }
  if (cambios.length === 0) return 0;
  for (let i = 0; i < cambios.length; i += 450) {
    const lote  = cambios.slice(i, i + 450);
    const batch = writeBatch(db);
    for (const c of lote) {
      const ref = doc(colRef, c.id);
      if (c.tipo === "set") batch.set(ref, c.data);
      else                  batch.delete(ref);
    }
    await batch.commit();
    // recién se actualiza la cache cuando el lote confirmó en el server
    for (const c of lote) {
      if (c.tipo === "set") cache.set(c.id, c.json);
      else                  cache.delete(c.id);
    }
  }
  return cambios.length;
}

async function syncSubcolecciones(key, fullState) {
  await syncSubcoleccion(key, "movimientos",   (fullState.movimientos  || []).map(m => [m.id, m]));
  await syncSubcoleccion(key, "simulaciones",  (fullState.simulaciones || []).map(x => [x.id, x]));
  await syncSubcoleccion(key, "historialAnos", Object.entries(fullState.historialAnos || {}));
}

// Lee las tres subcolecciones y deja la cache lista para diffs futuros.
async function cargarSubcolecciones(key) {
  const [movSnap, simSnap, histSnap] = await Promise.all([
    getDocs(collection(db, "usuarios", key, "movimientos")),
    getDocs(collection(db, "usuarios", key, "simulaciones")),
    getDocs(collection(db, "usuarios", key, "historialAnos")),
  ]);
  const movimientos  = movSnap.docs.map(d => d.data());
  const simulaciones = simSnap.docs.map(d => d.data());
  const historialAnos = {};
  histSnap.docs.forEach(d => { historialAnos[d.id] = d.data(); });
  setCacheDesde("movimientos",   movimientos.map(m => [m.id, m]));
  setCacheDesde("simulaciones",  simulaciones.map(x => [x.id, x]));
  setCacheDesde("historialAnos", Object.entries(historialAnos));
  return { movimientos, simulaciones, historialAnos };
}

// Migración one-time NO destructiva: si el doc raíz todavía trae los arrays
// viejos y las subcolecciones están vacías, los copia a las subcolecciones.
// NO borra los arrays del raíz (quedan como respaldo hasta que confirmes la
// migración y corras la limpieza por separado).
async function migrarSiHaceFalta(key, data, sub) {
  const rootTieneViejos =
    (Array.isArray(data.movimientos)  && data.movimientos.length  > 0) ||
    (Array.isArray(data.simulaciones) && data.simulaciones.length > 0) ||
    (data.historialAnos && Object.keys(data.historialAnos).length > 0);
  const subVacias =
    sub.movimientos.length === 0 &&
    sub.simulaciones.length === 0 &&
    Object.keys(sub.historialAnos).length === 0;
  if (!(rootTieneViejos && subVacias)) return sub;

  console.log("🚚 Migrando datos del doc raíz a subcolecciones…");
  const datos = {
    movimientos:   data.movimientos   || [],
    simulaciones:  data.simulaciones  || [],
    historialAnos: data.historialAnos || {},
  };
  await syncSubcolecciones(key, datos); // cache vacía → escribe todo
  return datos;
}

// Función pura que guarda datos en Firestore: doc raíz (sin los arrays grandes)
// + subcolecciones. La usan tanto el guardado online como el flush de la cola.
async function guardarEstadoData(userEmail, payload) {
  const key = emailToKey(userEmail);
  const ref = doc(db, "usuarios", key);
  // Sacamos del doc raíz lo que ahora vive en subcolecciones.
  const { movimientos, simulaciones, historialAnos, ...rootPayload } = payload;
  await setDoc(ref, rootPayload, { merge: true });
  await syncSubcolecciones(key, { movimientos, simulaciones, historialAnos });
}

// Guarda todos los datos del store — funciona offline (encola si no hay internet)
async function guardarEstado(userEmail) {
  if (!userEmail || !db) {
    console.error("❌ guardarEstado: userEmail o db nulo", { userEmail, db });
    throw new Error("Sin usuario o base de datos");
  }
  // ── Guard anti-pérdida de datos ─────────────────────────────────────────────
  // Si el estado todavía NO se cargó correctamente (firestoreCargado !== true),
  // el store está en CERO (valores por defecto). Guardar en ese momento pisaría
  // los datos reales del usuario en la nube. Por eso se omite el guardado hasta
  // que haya una carga exitosa (applyData o "usuario nuevo" la marcan en true).
  if (vacaStore.getState().firestoreCargado !== true) {
    console.warn("⏸️ Guardado omitido: el estado aún no se cargó (anti-pérdida de datos).");
    return;
  }
  const s = vacaStore.getState();
  const payload = {
    global:           s.global,
    gastos:           s.gastos,
    campoCria:        s.campoCria,
    campoRecria:      s.campoRecria,
    campoTerminacion: s.campoTerminacion,
    campoPastaje:     s.campoPastaje,
    campo:            s.campo,
    movimientos:      s.movimientos,
    simulaciones:     s.simulaciones,
    anoGanaderoActual: s.anoGanaderoActual,
    historialAnos:    s.historialAnos,
    savedAt:          new Date().toISOString(),
  };

  // Siempre guardar en localStorage (disponible offline, incluye los arrays)
  saveToLS(payload, userEmail);

  if (navigator.onLine) {
    try {
      await guardarEstadoData(userEmail, payload);
    } catch(e) {
      // Si falla el write online, encolar para después
      console.warn("⚠️ Firestore write failed, encolando para sync:", e.message);
      enqueueSync(userEmail, payload);
    }
  } else {
    // Sin internet → encolar para cuando vuelva la conexión
    console.log("📴 Sin conexión — guardado localmente, sync pendiente");
    enqueueSync(userEmail, payload);
  }
}

// Carga el estado desde Firestore con fallback a localStorage cuando offline
async function cargarEstado(userEmail, intentos = 3) {
  if (!userEmail || !db) return false;
  const key = userEmail.replace(/\./g, "_").replace(/@/g, "_at_");
  const ref = doc(db, "usuarios", key);

  function applyData(data) {
    const s = vacaStore.getState();
    if (data.global)            s.setGlobal(data.global);
    if (data.gastos)            s.setGastos(data.gastos);
    if (data.campoCria)         s.setCampoCria(data.campoCria);
    if (data.campoRecria)       s.setCampoRecria(data.campoRecria);
    if (data.campoTerminacion)  s.setCampoTerminacion(data.campoTerminacion);
    if (data.campoPastaje)      s.setCampoPastaje(data.campoPastaje);
    if (data.campo)             s.setCampo(data.campo);
    if (data.movimientos)       vacaStore.setState({ movimientos: data.movimientos });
    if (data.simulaciones)      vacaStore.setState({ simulaciones: data.simulaciones });
    if (data.historialAnos)     vacaStore.setState({ historialAnos: data.historialAnos });
    if (data.anoGanaderoActual) vacaStore.setState({ anoGanaderoActual: data.anoGanaderoActual });
    // Cache de subcolecciones: clave para que un borrado hecho offline se
    // propague al reconectar. En el camino online se sobrescribe luego con el
    // contenido real de las subcolecciones (más preciso).
    setCacheDesde("movimientos",   (data.movimientos  || []).map(m => [m.id, m]));
    setCacheDesde("simulaciones",  (data.simulaciones || []).map(x => [x.id, x]));
    setCacheDesde("historialAnos", Object.entries(data.historialAnos || {}));
    vacaStore.setState({ firestoreCargado: true });
  }

  // Aplica el estado vacío (campo en cero) — para usuarios nuevos
  function aplicarVacio() {
    const v = getEstadoVacio();
    const s = vacaStore.getState();
    s.setCampoCria(v.campoCria);
    s.setCampoRecria(v.campoRecria);
    s.setCampoTerminacion(v.campoTerminacion);
    s.setCampoPastaje(v.campoPastaje);
    s.setCampo(v.campo);
    vacaStore.setState({ movimientos: [], simulaciones: [], historialAnos: {} });
    resetSubcolCache();
    vacaStore.setState({ firestoreCargado: true });
  }

  // Sin internet → usar localStorage (solo si es del mismo usuario)
  if (!navigator.onLine) {
    const lsData = loadFromLS(userEmail);
    if (lsData) {
      console.log("📴 Sin conexión — cargando desde localStorage");
      applyData(lsData);
      return true;
    }
    // Sin internet y sin datos locales propios → arrancar vacío
    aplicarVacio();
    return true;
  }

  for (let i = 0; i < intentos; i++) {
    try {
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        // Usuario nuevo: no tiene datos en la nube. Arrancar en cero.
        // (No usar localStorage acá porque podría ser de otro usuario del mismo equipo)
        console.log("👤 Usuario nuevo — arrancando con campo vacío");
        aplicarVacio();
        return true;
      }
      const data = snap.data();
      applyData(data);
      saveToLS(data, userEmail);
      // Subcolecciones: fuente de verdad de movimientos/simulaciones/historialAnos.
      // Si el doc raíz todavía trae los arrays viejos, se migran (no destructivo).
      try {
        let sub = await cargarSubcolecciones(key);
        sub = await migrarSiHaceFalta(key, data, sub);
        vacaStore.setState({
          movimientos:   sub.movimientos,
          simulaciones:  sub.simulaciones,
          historialAnos: sub.historialAnos,
        });
      } catch (e) {
        console.warn("⚠️ No se pudieron cargar/migrar subcolecciones:", e.message);
        // Fallback: nos quedamos con lo que vino del doc raíz (ya aplicado).
      }
      return true;
    } catch (err) {
      if (i < intentos - 1) {
        await new Promise(r => setTimeout(r, 1500 * (i + 1)));
      } else {
        const lsData = loadFromLS(userEmail);
        if (lsData) {
          console.warn("⚠️ Firestore no disponible, usando localStorage:", err.message);
          applyData(lsData);
          return true;
        }
        console.warn("❌ cargarEstado falló:", err.message);
        return false;
      }
    }
  }
  return false;
}


// Estado inicial en CERO para usuarios nuevos (sin datos cargados de tu campo)
function getEstadoVacio() {
  return {
    campoCria: {
      vacas: 0, vaquillonas1: 0, vaquillonas2: 0, toros: 0, vacias: 0,
      vacaCut: 0, vaqRechazo: 0,
      pctMortandadCria: 2, pctMachos: 50, pctReposicion: 70,
      pesoVacaDescarte: 380, gdpTernero: 1.0,
      ciclos: [{
        id: "ciclo_1", servicio: "primavera",
        paricionMes: 9, paricionAnio: new Date().getMonth() >= 9 ? new Date().getFullYear() : new Date().getFullYear() - 1,
        mesesDestete: 6, pctPreniez: 85, pctDestete: 75, pesoDesteteKg: 187,
        ternerosAlPie: 0, pctMachos: 50, estado: "al_pie",
        ternerosDestetados: 0, machosDestetados: 0, hembrasDestetadas: 0, fechaDesteReal: null,
      }],
    },
    campoRecria: {
      ternerosLiquidaMachos: 0, ternerosLiquidaHembras: 0,
      ternerosCompraMachos: 0, ternerosCompraHembras: 0,
      novillos: 0, vaquillonaRecria: 0, mej: 0,
      pctMortandadRecria: 2, gdpNovilloInv: 0.5, gdpVaquillonaDesc: 0.5,
      precioCompraKgRecria: 0, pesoEntradaRecria: 180, cabCompradasRecria: 0,
    },
    campoTerminacion: {
      novillosCampo: 0, novillosFeedlot: 0,
      mejTerminacion: 0, vacaEngorde: 0, vaqEngorde: 0,
      pesoPromedioKg: 420, diasRestantes: 45, diasFeedlot: 100,
      costoComidaDia: 4500, costoHoteleriaDia: 800,
      pctMortandadFeedlot: 2, gdpNovilloFaena: 1.1,
      novillosHilton: 0, novillosUE481: 0,
    },
    campoPastaje: { tropas: [], periodos: [], terceros: [], precios: {}, precioNov: 0 },
    movimientos: [],
    simulaciones: [],
  };
}

// ── Emails autorizados ────────────────────────────────────────────────────────
const EMAILS_AUTORIZADOS = [
  "juliansanchez06@gmail.com",
];

// ── DEV BYPASS — DESACTIVADO en producción ───────────────────────────────
const DEV_BYPASS = false;
const DEV_USER   = { email: "juliansanchez06@gmail.com" };

// ── Magic link settings removed — usando email+contraseña ────────────────────



// ─── Logo (embedded) ─────────────────────────────────────────────────────────
const LOGO_B64 = "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";
const LOGO_LOGIN_B64 = "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";


// ═══════════════════════════════════════════════════════════════════════════
// STORE GLOBAL — Estado centralizado (Pilares 1, 2 y 3)
// ═══════════════════════════════════════════════════════════════════════════
function getAnoGanadero() {
  const h = new Date(); const m = h.getMonth(); const a = h.getFullYear();
  return m >= 6 ? `${a}/${a+1}` : `${a-1}/${a}`;
}

const vacaStore = createStore((set, get) => ({
  // ── Cotizaciones globales (sincronizadas en todos los simuladores) ──────────
  global: {
    inmagVientres:      10,
    inmagInvernada:     8,
    precioNovilloInmag: 1800,
    precioInvernada:    1600,  // $/kg — precio ternero/invernada (menor que novillo gordo)
    inflacionMensual:   4,
    dolar:              1420,
    tasaDescuento:      8,
    tasaOportunidadUSD: 5,    // % anual en USD — referencia plazo fijo / LECAP en USD
    valorCabPromedio:   1500000, // $ valor promedio de cabeza para costo oportunidad
  },
  gastos: {
    fleteCompraOn: false, kmCompra: 370, precioKmCompra: 3500,
    fleteVentaOn:  false, kmVenta:  300, precioKmVenta:  3500,
    comisionCompraOn: true, comisionCompra: 3,
    comisionVentaOn:  true, comisionVenta:  3,
  },
  // ── Stock del campo (arranca en CERO — datos reales vienen de Firestore por usuario) ──
  campoCria: {
    vacas: 0, vaquillonas1: 0, vaquillonas2: 0, toros: 0, vacias: 0,
    vacaCut: 0, vaqRechazo: 0,
    pctMortandadCria: 2,
    pctMachos: 50, pctReposicion: 70,
    pesoVacaDescarte: 380,
    gdpTernero: 1.0,
    ciclos: [
      {
        id: "ciclo_1",
        servicio: "primavera",
        paricionMes: 9,
        paricionAnio: new Date().getMonth() >= 9 ? new Date().getFullYear() : new Date().getFullYear() - 1,
        mesesDestete: 6,
        pctPreniez: 85,
        pctDestete: 75,
        pesoDesteteKg: 187,
        ternerosAlPie: 0,
        pctMachos: 50,
        estado: "al_pie",
        ternerosDestetados: 0,
        fechaDesteReal: null,
      }
    ],
  },
  campoRecria: {
    ternerosLiquidaMachos: 0, ternerosLiquidaHembras: 0,
    ternerosCompraMachos: 0,  ternerosCompraHembras: 0,
    novillos: 0, vaquillonaRecria: 0, mej: 0,
    pctMortandadRecria: 2,
    gdpNovilloInv: 0.5, gdpVaquillonaDesc: 0.5,
    precioCompraKgRecria: 0,
    pesoEntradaRecria:    180,
    cabCompradasRecria:   0,
  },
  campoTerminacion: {
    novillosCampo: 0, novillosFeedlot: 0,
    mejTerminacion: 0, vacaEngorde: 0, vaqEngorde: 0,
    pesoPromedioKg: 420, diasRestantes: 45, diasFeedlot: 100,
    costoComidaDia: 4500, costoHoteleriaDia: 800,
    pctMortandadFeedlot: 2, gdpNovilloFaena: 1.1,
    // Exportación
    novillosHilton: 0,       // cab Cuota Hilton (pasto, tipificación EUROP)
    novillosUE481: 0,        // cab UE 481 (feedlot certificado, mín 100 días)
    // Hilton
    hiltonPesoEntrada: 380,  // kg vivo al inicio de terminación
    hiltonDias: 120,         // días de terminación a pasto
    hiltonGdp: 0.7,          // kg/día GDP a pasto
    hiltonRendRes: 60,       // % rendimiento a res (58-62%)
    hiltonPrecioUSDton: 8000,// USD/ton res con hueso (Cuota Hilton premium)
    hiltonCostoPasto: 0,     // $/cab/mes costo verdeo/pastura (0 = campo propio)
    hiltonCertSenasa: 5000,  // $/cab certificación SENASA
    // UE 481
    ue481PesoEntrada: 340,   // kg vivo al ingreso feedlot
    ue481Dias: 100,          // días mínimo en feedlot
    ue481Gdp: 1.1,           // kg/día en feedlot
    ue481RendRes: 58,        // % rendimiento a res
    ue481PrecioUSDton: 7000, // USD/ton res con hueso UE
    ue481RacionKgDia: 8,     // kg MS/cab/día
    ue481PrecioRacionTon: 80000, // $/ton de ración
    ue481Hoteleria: 0,       // $/cab/día si es feedlot externo
    ue481CertSenasa: 8000,   // $/cab certificación UE 481
  },
  simulaciones: [],
  anoGanaderoActual: getAnoGanadero(),
  historialAnos: {},

  // ── Campo — costos de estructura y parámetros productivos ───────────────
  campo: {
    dolar:   1420,
    gasoil:  1100,
    hectareas: 0,
    sanidadPorCabAnio: 40000,  // $/cabeza/año — vacuna + desparasitación + minerales
    gdpTernero: 1.0,
    gdpNovilloInv: 0.5,
    gdpNovilloFaena: 1.1,
    gdpVaquillonaDesc: 0.5,
    // Impuestos
    pctIIBB: 3.0,           // % sobre ventas (ingresos brutos provincial)
    pctGanancias: 35,       // % sobre utilidad neta (estimado)
    inmobiliarioAnual: 0,   // $/año impuesto inmobiliario rural
    tasasAnuales: 0,        // $/año tasas viales, sanitarias, etc.
    // Amortizaciones
    amorMejoras: 0,         // $/año — alambrados, aguadas, corrales (vida útil 20 años)
    amorHaciendaReproductora: 0, // $/año — toros (vida útil 5 años)
    amorMaquinaria: 0,      // $/año — tractores, implementos (vida útil 10 años)
    empleados: [],
    maquinaria: { tractores: 0, mantenimientoMes: 0 },
    rolado: { hectareas: 0, litrosGasoilHa: 80, siembraHa: 0, costoSiembraHa: 25000 },
    viajes: { viajesAlMes: 0, kmPorViaje: 0, litrosCada100: 12 },
  },
  campoPastaje: {
    tropas:   [],
    periodos: [],
    terceros: [],
    precios:  { vacas: 6, toros: 5.5, terneras: 5.5, recria: 5.5 },
  },
  movimientos: [], // registro de compras y ventas del año ganadero
  __userEmail: "",         // email del usuario logueado para auto-guardado

  // ── Setters ────────────────────────────────────────────────────────────────
  setGlobal:          (p) => set(s => ({ global:          { ...s.global,          ...(typeof p === "function" ? p(s.global)          : p) } })),
  setGastos:          (p) => set(s => ({ gastos:          { ...s.gastos,          ...(typeof p === "function" ? p(s.gastos)          : p) } })),
  setCampoCria:       (p) => set(s => ({ campoCria:       { ...s.campoCria,       ...(typeof p === "function" ? p(s.campoCria)       : p) } })),
  setCampoRecria:     (p) => set(s => ({ campoRecria:     { ...s.campoRecria,     ...(typeof p === "function" ? p(s.campoRecria)     : p) } })),
  setCampoTerminacion:(p) => set(s => ({ campoTerminacion:{ ...s.campoTerminacion,...(typeof p === "function" ? p(s.campoTerminacion) : p) } })),
  setCampoPastaje:    (p) => set(s => ({ campoPastaje:    { ...s.campoPastaje,    ...(typeof p === "function" ? p(s.campoPastaje)    : p) } })),
  setCampo:           (p) => set(s => ({ campo:           { ...s.campo,           ...(typeof p === "function" ? p(s.campo)           : p) } })),
  setMovimientos:     (fn) => set(s => ({ movimientos: typeof fn === "function" ? fn(s.movimientos) : fn })),

  // ── Agregar al campo desde simulador ─────────────────────────────────────
  agregarAlCampo: ({ categoria, cantidad }) => set(s => {
    switch (categoria) {
      case "terneros-compra-machos":  return { campoRecria:     { ...s.campoRecria,     ternerosCompraMachos:  s.campoRecria.ternerosCompraMachos  + cantidad } };
      case "terneros-compra-hembras": return { campoRecria:     { ...s.campoRecria,     ternerosCompraHembras: s.campoRecria.ternerosCompraHembras + cantidad } };
      case "vacas":                   return { campoCria:        { ...s.campoCria,        vacas:          s.campoCria.vacas          + cantidad } };
      case "vaquillonas1":            return { campoCria: { ...s.campoCria, vaquillonas1: (s.campoCria.vaquillonas1??s.campoCria.vaquillonas??0) + cantidad } };
      case "vaquillonas2":            return { campoCria: { ...s.campoCria, vaquillonas2: (s.campoCria.vaquillonas2??0) + cantidad } };
      case "novillos-campo":          return { campoTerminacion: { ...s.campoTerminacion, novillosCampo:  s.campoTerminacion.novillosCampo  + cantidad } };
      case "novillos-feedlot":        return { campoTerminacion: { ...s.campoTerminacion, novillosFeedlot:s.campoTerminacion.novillosFeedlot + cantidad } };
      case "vaquillonas":             return { campoCria:        { ...s.campoCria,        vaquillonas1:  (s.campoCria.vaquillonas1 ?? s.campoCria.vaquillonas ?? 0) + cantidad } };
      case "novillos":                return { campoTerminacion: { ...s.campoTerminacion, novillosCampo: s.campoTerminacion.novillosCampo + cantidad } };
      default: return {};
    }
  }),

  // ── Simulaciones ─────────────────────────────────────────────────────────
  agregarSimulacion: (sim) => set(s => ({ simulaciones: [{ ...sim, id: Date.now() }, ...s.simulaciones] })),
  borrarSimulacion:  (id)  => set(s => ({ simulaciones: s.simulaciones.filter(x => x.id !== id) })),
  borrarTodas:       ()    => set({ simulaciones: [] }),

  // ════════════════════════════════════════════════════════════════════════════
  // PILAR 2 — Cerrar año con dinámica biológica real
  // ════════════════════════════════════════════════════════════════════════════
  cerrarAnoGanadero: () => {
    const { campoCria: c, campoRecria: r, campoTerminacion: t, anoGanaderoActual, historialAnos, global: gl, campo: cp } = get();
    const mortCria   = c.pctMortandadCria   / 100;
    const mortRecria = r.pctMortandadRecria  / 100;
    const pctRepos   = c.pctReposicion      / 100;
    const pctMachos  = c.pctMachos          / 100;
    // Fuente de verdad de terneros al pie: los ciclos (con fallback al campo plano)
    const ternerosAlPie = ((c.ciclos ?? []).reduce((a,x)=>a+(x.ternerosAlPie??0),0)) || (c.ternerosNoDestetados ?? 0);

    const preniadas    = Math.round((c.vacas + (c.vaquillonas1??c.vaquillonas??0) + (c.vaquillonas2??0)) * c.pctPreniez / 100);
    const nacidos      = Math.round(preniadas * (1 - mortCria));
    const totalDest    = ternerosAlPie > 0 ? ternerosAlPie : Math.round(nacidos * c.pctDestete / 100);
    const hembrasDest  = Math.round(totalDest * (1 - pctMachos));
    const hembrasRepos = Math.round(hembrasDest * pctRepos);

    const vacasMort   = Math.round(c.vacas * mortCria);
    const nuevasVacas = Math.max(0, c.vacas - c.vacias - vacasMort + (c.vaquillonas1??c.vaquillonas??0) + (c.vaquillonas2??0));
    const nuevasVaq   = hembrasRepos;
    const machosSobrev = Math.round((r.ternerosLiquidaMachos + r.ternerosCompraMachos) * (1 - mortRecria));

    // Balance economico del ano
    const precioNov = gl.precioNovilloInmag || 1800;
    const totalStock = c.vacas + (c.vaquillonas1??c.vaquillonas??0) + (c.vaquillonas2??0) + ternerosAlPie + c.toros + (c.vacias||0) + (c.vacaCut??0) + (c.vaqRechazo??0)
      + r.ternerosLiquidaMachos + r.ternerosLiquidaHembras + r.ternerosCompraMachos + r.ternerosCompraHembras + r.novillos
      + t.novillosCampo + t.novillosFeedlot;
    const hectareas = (cp&&cp.hectareas) || 1000;
    const evTotal = c.vacas*1.0 + ((c.vaquillonas1??c.vaquillonas??0)+(c.vaquillonas2??0))*0.85 + c.toros*1.3 + ternerosAlPie*0.55
      + (c.vacias||0)*1.0 + r.ternerosLiquidaMachos*0.7 + r.ternerosLiquidaHembras*0.7
      + r.ternerosCompraMachos*0.7 + r.ternerosCompraHembras*0.7 + r.novillos*0.95 + t.novillosCampo*1.0;

    const kgDestetados = totalDest * 165;
    const kgRecria = (r.ternerosLiquidaMachos + r.ternerosCompraMachos + r.novillos) * 320;
    const kgTerm = (t.novillosCampo + t.novillosFeedlot) * (t.pesoPromedioKg || 420);
    const kgVacasDescarte = Math.round((c.vacias||0) * 0.65 * 420);
    const kgTotalAnio = kgDestetados + kgRecria + kgTerm + kgVacasDescarte;
    const kgHaAnio = hectareas > 0 ? Math.round(kgTotalAnio / hectareas) : 0;

    const empleados = (cp&&cp.empleados) || [];
    const sanidadMesSnap = totalStock * ((cp&&cp.sanidadPorCabAnio)||40000) / 12;
    const empCosto = empleados.reduce((s,e) => {
      const bruto = e.sueldo * e.cantidad;
      return s + bruto + bruto*(e.cargasSociales/100) + (e.aguinaldo?bruto/12:0) + e.premio*e.cantidad;
    }, 0);
    const maqCosto = ((cp&&cp.maquinaria&&cp.maquinaria.tractores)||3) * ((cp&&cp.maquinaria&&cp.maquinaria.mantenimientoMes)||120000);
    const costoEst = (empCosto + maqCosto + sanidadMesSnap) * 12;

    const ingresoAnio = kgTotalAnio * precioNov;
    const margenAnio  = ingresoAnio - costoEst;
    const costoOpAnio = totalStock * ((gl.valorCabPromedio)||1500000) * ((gl.tasaOportunidadUSD||5)/100);
    const rendimientoReal = margenAnio - costoOpAnio;

    const snapshot = {
      ano: anoGanaderoActual,
      cria: { ...c }, recria: { ...r }, terminacion: { ...t },
      fechaCierre: new Date().toLocaleDateString("es-AR"),
      resumen: { totalDest, hembrasDest, hembrasRepos, vacasDescarte: c.vacias||0, machosSobrev },
      balance: {
        kgTotalAnio, kgHaAnio, ingresoAnio, costoEst, margenAnio,
        costoOpAnio, rendimientoReal,
        evPorHa: Math.round((evTotal / hectareas) * 100) / 100,
        pctDestete: Math.round(totalDest / ((c.vacas + (c.vaquillonas1??c.vaquillonas??0) + (c.vaquillonas2??0)) || 1) * 100),
        totalStock, hectareas,
      },
    };
    const [anioIn] = anoGanaderoActual.split("/").map(Number);

    set({
      campoCria:        { ...c, vacas: nuevasVacas, vaquillonas1: nuevasVaq, vaquillonas2: 0, vaquillonas: 0, ternerosNoDestetados: 0, vacias: 0, ciclos: (c.ciclos ?? []).map(x => ({ ...x, ternerosAlPie: 0 })) },
      // Ascenso de categoría: los novillos que ya hicieron su recría suben a terminación;
      // los terneros que recriaron este año pasan a ser el nuevo pool de novillos en recría.
      campoRecria:      { ...r, ternerosLiquidaMachos: 0, ternerosLiquidaHembras: 0, ternerosCompraMachos: 0, ternerosCompraHembras: 0, novillos: machosSobrev },
      campoTerminacion: { ...t, novillosCampo: r.novillos, novillosFeedlot: 0 },
      anoGanaderoActual: `${anioIn+1}/${anioIn+2}`,
      historialAnos: { ...historialAnos, [anoGanaderoActual]: snapshot },
    });
    return snapshot;
  },
}));

// Hooks selectivos para cada componente (evitan re-renders innecesarios)
function useGlobal()       { return useStore(vacaStore, function(s) { return s.global; }); }
function useGastos()       { return useStore(vacaStore, function(s) { return s.gastos; }); }
function useCampoCria()    { return useStore(vacaStore, function(s) { return s.campoCria; }); }
function useCampoRecria()  { return useStore(vacaStore, function(s) { return s.campoRecria; }); }
function useCampoTerm()    { return useStore(vacaStore, function(s) { return s.campoTerminacion; }); }
function useSimulaciones() { return useStore(vacaStore, function(s) { return s.simulaciones; }); }

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmt(n, dec = 0) {
  if (isNaN(n) || !isFinite(n)) return "—";
  return new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  }).format(n);
}

function fmtMoney(n, dec = 0) {
  return (isNaN(n) || !isFinite(n)) ? "—" : "$ " + fmt(n, dec);
}

function fmtKg(n, dec = 1) {
  return (isNaN(n) || !isFinite(n)) ? "—" : fmt(n, dec) + " kg";
}

function fmtPct(n, dec = 1) {
  return (isNaN(n) || !isFinite(n)) ? "—" : (n > 0 ? "+" : "") + fmt(n, dec) + "%";
}

// ─── Global CSS (slider thumb enlarge + pastel bg) ───────────────────────────
const GLOBAL_STYLE = `
  /* ── Background ──────────────────────────────────────────────────── */
  .app-bg { background: #F4EEE1; min-height: 100vh; }
  body { background-color: #F4EEE1; }

  /* ════════════════════════════════════════════════════════════════ */
  /*  TEMA "CAMPO PREMIUM" — re-tinte cálido global.                    */
  /*  Pisa los grises fríos de Tailwind con tonos tierra / crema.       */
  /*  Para reajustar toda la paleta, cambiá los HEX de este bloque.     */
  /* ════════════════════════════════════════════════════════════════ */
  .bg-white                    { background-color: #FBF8F1 !important; }
  .bg-slate-50, .bg-gray-50    { background-color: #F4EEE1 !important; }
  .bg-slate-100, .bg-gray-100  { background-color: #EFE6D4 !important; }

  .border-slate-200, .border-gray-200 { border-color: #E7DCC6 !important; }
  .border-slate-100                    { border-color: #EFE6D4 !important; }

  .text-slate-400 { color: #B6A98E !important; }
  .text-slate-500 { color: #9A8C72 !important; }
  .text-slate-600 { color: #7C6F58 !important; }
  .text-slate-700 { color: #5A5040 !important; }
  .text-slate-800 { color: #2A2018 !important; }
  .text-slate-900 { color: #1F1A12 !important; }

  /* Verde de marca: más profundo y "de campo" */
  .bg-emerald-600, .bg-green-600 { background-color: #2F7D4F !important; }
  .text-emerald-600, .text-green-600, .text-emerald-700 { color: #2F7D4F !important; }

  /* Tarjetas: sombra cálida y suave en lugar de la gris plana */
  .shadow-sm           { box-shadow: 0 1px 2px rgba(80,60,30,0.06) !important; }
  .shadow, .shadow-md  { box-shadow: 0 2px 6px rgba(80,60,30,0.08) !important; }

  /* ── Login Screen ──────────────────────────────────────────────────── */
  @keyframes loginCardIn {
    from { opacity:0; transform: translateY(40px) scale(0.96); }
    to   { opacity:1; transform: translateY(0) scale(1); }
  }
  @keyframes bgFloat1 {
    0%,100% { transform: translate(0,0) scale(1); }
    50%      { transform: translate(20px,-30px) scale(1.05); }
  }
  @keyframes bgFloat2 {
    0%,100% { transform: translate(0,0) scale(1); }
    50%      { transform: translate(-15px,20px) scale(1.08); }
  }
  @keyframes bgFloat3 {
    0%,100% { transform: translate(0,0); }
    50%      { transform: translate(10px,15px); }
  }
  @keyframes loginFadeUp {
    from { opacity:0; transform: translateY(16px); }
    to   { opacity:1; transform: translateY(0); }
  }
  @keyframes spinDot {
    to { transform: rotate(360deg); }
  }
  .login-bg {
    min-height: 100vh;
    background: #163d44;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem 1rem;
    position: relative;
    overflow: hidden;
  }
  /* ════════════════════════════════════════════════════════════════ */
  /*  TAMAÑO DE TEXTO MOBILE — EDITAR ACÁ (este bloque es el que manda) */
  /*  index_2.css NO tiene efecto: estos !important lo pisan siempre.   */
  /*  Subí/bajá los px de abajo para agrandar o achicar.                */
  /* ════════════════════════════════════════════════════════════════ */
  @media (max-width: 640px) {
    html { font-size: 28px !important; }
    body { font-size: 28px !important; }

    /* Forzar tamaño mínimo en TODO elemento de texto */
    div, p, span, td, th, li, a, label, button, input, select, textarea, h1, h2, h3, h4, h5, h6 {
      font-size: 26px;
    }

    /* Clases de Tailwind explícitas (mayor prioridad) */
    .text-xs   { font-size: 24px !important; line-height: 1.5 !important; }
    .text-sm   { font-size: 27px !important; line-height: 1.5 !important; }
    .text-base { font-size: 30px !important; }
    .text-lg   { font-size: 35px !important; }
    .text-xl   { font-size: 40px !important; }
    .text-2xl  { font-size: 48px !important; }
    .text-3xl  { font-size: 56px !important; }
    .text-4xl  { font-size: 64px !important; }
    .text-\[10px\], .text-\[11px\], .text-\[12px\] { font-size: 23px !important; }

    /* Números mono siempre grandes */
    .font-mono { font-size: 30px !important; }
    .font-mono.text-2xl, .font-mono.text-3xl, .font-mono.text-4xl { font-size: 54px !important; }
    .font-mono.text-xl { font-size: 42px !important; }

    /* Uppercase labels */
    .uppercase.tracking-widest { font-size: 22px !important; letter-spacing: 0.03em !important; }
    .uppercase.tracking-wider  { font-size: 23px !important; }

    /* Inputs y selects */
    input, select, textarea { font-size: 28px !important; }

    /* Botones más fáciles de tocar */
    button { min-height: 60px !important; }

    /* Cards con más padding */
    .rounded-2xl { padding: 16px !important; }
    .rounded-3xl { padding: 18px !important; }
  }

  /* ════════════════════════════════════════════════════════════════════ */
  /*  MOBILE ROBUSTO — se aplica por clase .is-mobile (dispositivo táctil), */
  /*  NO por ancho de pantalla. Así funciona aunque el navegador del cel    */
  /*  esté en "modo escritorio" o reporte un ancho raro.                    */
  /*  La especificidad (html.is-mobile .clase) le gana a Tailwind.          */
  /*  Para agrandar/achicar TODO: cambiá los px de acá.                     */
  /* ════════════════════════════════════════════════════════════════════ */
  html.is-mobile { font-size: 30px !important; }
  html.is-mobile body { font-size: 30px !important; }

  html.is-mobile div, html.is-mobile p, html.is-mobile span,
  html.is-mobile td, html.is-mobile th, html.is-mobile li,
  html.is-mobile a, html.is-mobile label,
  html.is-mobile h1, html.is-mobile h2, html.is-mobile h3,
  html.is-mobile h4, html.is-mobile h5, html.is-mobile h6 { font-size: 28px; }

  html.is-mobile .text-xs   { font-size: 25px !important; line-height: 1.5 !important; }
  html.is-mobile .text-sm   { font-size: 28px !important; line-height: 1.5 !important; }
  html.is-mobile .text-base { font-size: 31px !important; }
  html.is-mobile .text-lg   { font-size: 36px !important; }
  html.is-mobile .text-xl   { font-size: 42px !important; }
  html.is-mobile .text-2xl  { font-size: 50px !important; }
  html.is-mobile .text-3xl  { font-size: 58px !important; }
  html.is-mobile .text-4xl  { font-size: 66px !important; }
  html.is-mobile .text-\\[10px\\], html.is-mobile .text-\\[11px\\],
  html.is-mobile .text-\\[12px\\] { font-size: 24px !important; }

  html.is-mobile .font-mono { font-size: 31px !important; }
  html.is-mobile .font-mono.text-2xl, html.is-mobile .font-mono.text-3xl,
  html.is-mobile .font-mono.text-4xl { font-size: 56px !important; }
  html.is-mobile .font-mono.text-xl { font-size: 44px !important; }

  html.is-mobile .uppercase.tracking-widest { font-size: 23px !important; letter-spacing: 0.03em !important; }
  html.is-mobile .uppercase.tracking-wider  { font-size: 24px !important; }

  /* Inputs y selects más grandes y cómodos */
  html.is-mobile input, html.is-mobile select, html.is-mobile textarea {
    font-size: 30px !important;
    min-height: 70px !important;
    padding: 12px 16px !important;
  }

  /* Botones grandes y fáciles de tocar */
  html.is-mobile button {
    font-size: 30px !important;
    min-height: 72px !important;
    padding: 14px 20px !important;
  }
  /* Botones chicos de +/- (steppers): cuadrados y grandes */
  html.is-mobile button.w-9, html.is-mobile button.w-10,
  html.is-mobile button.w-11, html.is-mobile button.w-12 {
    min-width: 72px !important;
    min-height: 72px !important;
  }

  /* Más aire en las tarjetas */
  html.is-mobile .rounded-2xl { padding: 18px !important; }
  html.is-mobile .rounded-3xl { padding: 20px !important; }

  @keyframes floatDollar1{0%,100%{transform:translateY(0) rotate(-15deg)}50%{transform:translateY(-40px) rotate(-8deg)}}
  @keyframes floatDollar2{0%,100%{transform:translateY(0) rotate(20deg)}50%{transform:translateY(-55px) rotate(28deg)}}
  @keyframes floatDollar3{0%,100%{transform:translateY(0) rotate(-5deg)}50%{transform:translateY(-30px) rotate(5deg)}}
  @keyframes floatDollar4{0%,100%{transform:translateY(0) rotate(35deg)}50%{transform:translateY(-48px) rotate(25deg)}}
  @keyframes floatDollar5{0%,100%{transform:translateY(0) rotate(-25deg)}50%{transform:translateY(-36px) rotate(-18deg)}}
  @keyframes floatDollar6{0%,100%{transform:translateY(0) rotate(10deg)}50%{transform:translateY(-60px) rotate(18deg)}}
  .login-dollar {
    position: absolute;
    color: #a7f3d0;
    font-weight: 900;
    pointer-events: none;
    user-select: none;
    line-height: 1;
  }
  .ld1{font-size:72px;opacity:.09;top:8%;left:4%;animation:floatDollar1 7s ease-in-out infinite;}
  .ld2{font-size:48px;opacity:.07;top:15%;right:6%;animation:floatDollar2 9s ease-in-out 1s infinite;}
  .ld3{font-size:96px;opacity:.06;bottom:12%;left:2%;animation:floatDollar3 8s ease-in-out 2s infinite;}
  .ld4{font-size:36px;opacity:.09;bottom:25%;right:4%;animation:floatDollar4 6s ease-in-out .5s infinite;}
  .ld5{font-size:60px;opacity:.07;top:55%;right:12%;animation:floatDollar5 10s ease-in-out 1.5s infinite;}
  .ld6{font-size:44px;opacity:.08;top:42%;left:15%;animation:floatDollar6 7.5s ease-in-out 3s infinite;}
  .login-blob {
    position: absolute;
    border-radius: 50%;
    opacity: 0.13;
    pointer-events: none;
  }
  .login-blob-1 { width:520px; height:520px; background:#0f2e33; top:-180px; right:-140px; animation: bgFloat1 8s ease-in-out infinite; }
  .login-blob-2 { width:340px; height:340px; background:#1e5560; bottom:-100px; left:-80px;  animation: bgFloat2 10s ease-in-out infinite; }
  .login-blob-3 { width:180px; height:180px; background:#256b73; top:40%; left:8%;          animation: bgFloat3 6s ease-in-out infinite; }
  .login-blob-4 { width:100px; height:100px; background:#2d7c85; bottom:20%; right:10%;      animation: bgFloat1 7s ease-in-out 2s infinite; }
  .login-card {
    background: #ffffff;
    border-radius: 28px;
    padding: 2.75rem 2.25rem 2rem;
    width: 100%;
    max-width: 420px;
    position: relative;
    z-index: 2;
    animation: loginCardIn 0.9s cubic-bezier(0.16,1,0.3,1) both;
    box-shadow: 0 32px 80px -8px rgba(6,78,59,0.45);
  }
  .login-logo-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-bottom: 1.25rem;
    animation: loginLogoIn 0.6s cubic-bezier(0.34,1.56,0.64,1) 0.1s both;
  }
  @keyframes loginLogoIn {
    from { opacity:0; transform: scale(0.6) rotate(-6deg); }
    to   { opacity:1; transform: scale(1) rotate(0deg); }
  }
  .login-line {
    height: 2px;
    width: 56px;
    background: linear-gradient(90deg, #10b981, #34d399, transparent);
    border-radius: 2px;
    margin-bottom: 8px;
    animation: loginLineGrow 0.5s cubic-bezier(0.34,1.56,0.64,1) 0.5s both;
  }
  @keyframes loginLineGrow {
    from { width: 0; opacity: 0; }
    to   { width: 56px; opacity: 1; }
  }
  .login-slogan-badge {
    background: linear-gradient(135deg, #163d44, #1e5560);
    color: #a7f3d0;
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 3px 9px;
    border-radius: 20px;
  }
  .login-slogan {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.18em;
    color: #6b7280;
    text-transform: uppercase;
    margin: 0;
  }
  .login-heading {
    font-size: 22px;
    font-weight: 900;
    color: #111827;
    margin: 0 0 0.3rem;
    text-align: center;
    letter-spacing: -0.5px;
    animation: loginFadeUp 0.5s 0.18s both;
  }
  .login-sub {
    font-size: 13px;
    color: #6b7280;
    text-align: center;
    margin: 0 0 1.5rem;
    line-height: 1.55;
    animation: loginFadeUp 0.5s 0.24s both;
  }
  .login-input-wrap {
    position: relative;
    margin-bottom: 0.75rem;
    animation: loginFadeUp 0.5s 0.3s both;
  }
  .login-input-icon {
    position: absolute;
    left: 14px;
    top: 50%;
    transform: translateY(-50%);
    opacity: 0.35;
    pointer-events: none;
  }
  .login-input {
    width: 100%;
    box-sizing: border-box;
    padding: 14px 14px 14px 44px;
    font-size: 16px;
    border: 2px solid #e5e7eb;
    border-radius: 14px;
    outline: none;
    font-family: inherit;
    color: #111827;
    background: #f9fafb;
    transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
  }
  .login-input:focus {
    border-color: #10b981;
    background: #fff;
    box-shadow: 0 0 0 4px rgba(16,185,129,0.14);
  }
  .login-input::placeholder { color: #9ca3af; }
  .login-input.error {
    border-color: #ef4444;
    box-shadow: 0 0 0 4px rgba(239,68,68,0.12);
  }
  .login-btn {
    width: 100%;
    padding: 14px;
    background: linear-gradient(135deg, #163d44 0%, #1e5560 100%);
    color: #fff;
    border: none;
    border-radius: 14px;
    font-size: 15px;
    font-weight: 800;
    cursor: pointer;
    letter-spacing: 0.02em;
    transition: transform 0.2s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.2s, opacity 0.2s;
    animation: loginFadeUp 0.5s 0.36s both;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .login-btn:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 10px 28px rgba(6,78,59,0.4);
  }
  .login-btn:active:not(:disabled) { transform: scale(0.97); }
  .login-btn:disabled { opacity: 0.7; cursor: not-allowed; }
  .login-feats {
    display: flex;
    justify-content: center;
    gap: 24px;
    margin-top: 1.5rem;
    animation: loginFadeUp 0.5s 0.44s both;
  }
  .login-feat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
  }
  .login-feat-icon {
    width: 38px; height: 38px;
    border-radius: 11px;
    display: flex; align-items: center; justify-content: center;
  }
  .login-feat-label {
    font-size: 10px;
    font-weight: 700;
    color: #9ca3af;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    line-height: 1.3;
  }
  .login-toast {
    margin-top: 0.75rem;
    background: #ecfdf5;
    border: 2px solid #6ee7b7;
    border-radius: 14px;
    padding: 13px 15px;
    display: flex;
    align-items: flex-start;
    gap: 11px;
    animation: loginFadeUp 0.4s both;
  }
  .login-toast-dot {
    width: 10px; height: 10px;
    background: #10b981;
    border-radius: 50%;
    margin-top: 3px;
    flex-shrink: 0;
    animation: pulse-glow 1.5s ease-in-out infinite;
  }
  .login-error-msg {
    margin-top: 0.6rem;
    background: #fef2f2;
    border: 1.5px solid #fca5a5;
    border-radius: 12px;
    padding: 10px 13px;
    font-size: 13px;
    color: #dc2626;
    font-weight: 600;
    animation: loginFadeUp 0.3s both;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .login-note {
    font-size: 11px;
    color: #9ca3af;
    text-align: center;
    margin-top: 1.25rem;
    line-height: 1.55;
    animation: loginFadeUp 0.5s 0.5s both;
  }
  .login-spinner {
    width: 18px; height: 18px;
    border: 2.5px solid rgba(255,255,255,0.4);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spinDot 0.7s linear infinite;
  }

  /* ── Google Fonts ──────────────────────────────────────────────────── */
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800;900&display=swap');

  /* ── Mobile-first touch sizing ───────────────────────────────────── */
  @media (max-width: 640px) {
    input[type=number] { font-size: 20px !important; }
  }

  /* ── New animations ─────────────────────────────────────────────────── */
  @keyframes popIn {
    0%   { opacity: 0; transform: scale(0.8) translateY(10px); }
    70%  { transform: scale(1.04) translateY(-2px); }
    100% { opacity: 1; transform: scale(1) translateY(0); }
  }
  @keyframes slideRight {
    from { opacity: 0; transform: translateX(-16px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  @keyframes gradientShift {
    0%   { background-position: 0% 50%; }
    50%  { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
  @keyframes wiggle {
    0%,100% { transform: rotate(-3deg); }
    50%      { transform: rotate(3deg); }
  }
  @keyframes pulseScale {
    0%,100% { transform: scale(1); }
    50%      { transform: scale(1.06); }
  }
  @keyframes glow {
    0%,100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); }
    50%      { box-shadow: 0 0 16px 4px rgba(16,185,129,0.3); }
  }
  @keyframes countUp {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* ── Animated components ──────────────────────────────────────────── */
  .section-enter { animation: slideRight 0.4s cubic-bezier(0.16,1,0.3,1) both; }
  .kpi-pop       { animation: popIn 0.7s cubic-bezier(0.34,1.56,0.64,1) both; }
  .kpi-pop:nth-child(1) { animation-delay: 0.08s; }
  .kpi-pop:nth-child(2) { animation-delay: 0.18s; }
  .kpi-pop:nth-child(3) { animation-delay: 0.28s; }
  .kpi-pop:nth-child(4) { animation-delay: 0.38s; }
  .kpi-pop:nth-child(5) { animation-delay: 0.48s; }
  .kpi-pop:nth-child(6) { animation-delay: 0.58s; }
  .value-update  { animation: countUp 0.3s ease both; }

  /* ── Gradient text ────────────────────────────────────────────────── */
  .gradient-text {
    background: linear-gradient(135deg, #10b981, #0ea5e9, #8b5cf6);
    background-size: 200% 200%;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    animation: gradientShift 4s ease infinite;
  }

  /* ── Section title accent line ────────────────────────────────────── */
  .section-accent {
    background: linear-gradient(90deg, #10b981, #0ea5e9, transparent);
    height: 2px;
    border-radius: 2px;
  }

  /* ── Glowing positive values ──────────────────────────────────────── */
  .glow-green { animation: glow 2.5s ease-in-out infinite; border-radius: 12px; }

  /* ── Hover lift on cards ──────────────────────────────────────────── */
  .card-hover {
    transition: transform 0.2s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.2s ease;
  }
  .card-hover:hover { transform: translateY(-3px); box-shadow: 0 12px 32px -4px rgba(0,0,0,0.12); }

  /* ── Pulsing badge ────────────────────────────────────────────────── */
  .badge-pulse { animation: pulseScale 2s ease-in-out infinite; }

  /* ── Field focus ring glow ────────────────────────────────────────── */
  input[type=number]:focus { box-shadow: 0 0 0 3px rgba(16,185,129,0.25) !important; }

  /* ── Sliders ──────────────────────────────────────────────────────── */
  input[type=range] {
    -webkit-appearance: none;
    appearance: none;
    height: 6px;
    border-radius: 9999px;
    outline: none;
    cursor: pointer;
    transition: all 0.2s;
  }
  input[type=range]::-webkit-slider-runnable-track {
    height: 6px;
    border-radius: 9999px;
  }
  input[type=range]::-moz-range-track {
    height: 6px;
    border-radius: 9999px;
    background: #d1fae5;
  }
  input[type=range]::-moz-range-progress {
    height: 6px;
    border-radius: 9999px;
    background: #10b981;
  }
  input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #10b981;
    cursor: pointer;
    border: 2px solid white;
    box-shadow: 0 1px 4px rgba(0,0,0,.2);
    transition: transform 0.18s cubic-bezier(.34,1.56,.64,1);
  }
  input[type=range]:hover::-webkit-slider-thumb { transform: scale(1.25); }
  input[type=range]:active::-webkit-slider-thumb,
  input[type=range]:focus::-webkit-slider-thumb { transform: scale(1.5); }
  input[type=range]::-moz-range-thumb {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #10b981;
    cursor: pointer;
    border: 2px solid white;
    box-shadow: 0 1px 4px rgba(0,0,0,.2);
    transition: transform 0.18s cubic-bezier(.34,1.56,.64,1);
  }
  input[type=range]:hover::-moz-range-thumb { transform: scale(1.25); }
  input[type=range]:active::-moz-range-thumb { transform: scale(1.5); }

  /* ── Desktop layout improvements ─────────────────────────────────── */
  @media (min-width: 1024px) {
    .desktop-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  }

  /* Toast animation */
  @keyframes toastIn {
    from { opacity: 0; transform: translateY(20px) scale(0.95); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }


  /* ── xs breakpoint ────────────────────────────────────────────────────── */
  @media (min-width: 480px) {
    .xs\:inline { display: inline !important; }
    .xs\:hidden  { display: none !important; }
  }
  @media (max-width: 479px) {
    .xs\:inline { display: none !important; }
    .xs\:hidden  { display: inline !important; }
  }

  /* ── Mobile optimizations ────────────────────────────────────────────── */
  @media (max-width: 640px) {
    input[type=number] { font-size: 20px !important; min-height: 52px; }
  }

  /* ── Extra vivid accents ─────────────────────────────────────────────── */
  @keyframes rainbowBorder {
    0%   { border-color: #10b981; }
    25%  { border-color: #0ea5e9; }
    50%  { border-color: #8b5cf6; }
    75%  { border-color: #f59e0b; }
    100% { border-color: #10b981; }
  }
  @keyframes slideUp {
    from { opacity: 0; transform: translateY(20px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes zoomIn {
    from { opacity: 0; transform: scale(0.9); }
    to   { opacity: 1; transform: scale(1); }
  }

  .result-positive {
    background: linear-gradient(135deg, #ecfdf5, #d1fae5);
    border-color: #10b981 !important;
    animation: glow 3s ease-in-out infinite;
  }
  .result-negative {
    background: linear-gradient(135deg, #fef2f2, #fee2e2);
    border-color: #ef4444 !important;
  }
  .nav-accent {
    background: linear-gradient(135deg, #1e293b, #334155);
  }
  .module-badge-poder     { background: linear-gradient(135deg, #0ea5e9, #06b6d4); }
  .module-badge-vientres  { background: linear-gradient(135deg, #8b5cf6, #7c3aed); }
  .module-badge-invernada { background: linear-gradient(135deg, #10b981, #0d9488); }

  /* ── Vibrant section backgrounds ────────────────────────────────────── */
  .section-teal    { background: linear-gradient(135deg, #f0fdfa, #ccfbf1); border-color: #5eead4; }
  .section-violet  { background: linear-gradient(135deg, #faf5ff, #ede9fe); border-color: #c4b5fd; }
  .section-amber   { background: linear-gradient(135deg, #fffbeb, #fef3c7); border-color: #fcd34d; }
  .section-lime    { background: linear-gradient(135deg, #f7fee7, #ecfccb); border-color: #bef264; }
  .section-sky     { background: linear-gradient(135deg, #f0f9ff, #e0f2fe); border-color: #7dd3fc; }

  /* ── Animated number display ─────────────────────────────────────────── */
  .num-positive { color: #059669; font-weight: 900; }
  .num-negative { color: #dc2626; font-weight: 900; }
  .num-neutral  { color: #1e293b; font-weight: 900; }

  /* Smooth horizontal scroll for tables on mobile */
  .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .table-scroll::-webkit-scrollbar { height: 4px; }
  .table-scroll::-webkit-scrollbar-track { background: #f1f5f9; border-radius: 2px; }
  .table-scroll::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 2px; }

  /* ── Dashboard animations ───────────────────────────────────────────── */
  @keyframes fadeSlideUp {
    from { opacity: 0; transform: translateY(24px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  .dash-card {
    animation: fadeSlideUp 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .dash-card:nth-child(1) { animation-delay: 0.08s; }
  .dash-card:nth-child(2) { animation-delay: 0.22s; }
  .dash-card:nth-child(3) { animation-delay: 0.36s; }
  .dash-welcome { animation: fadeSlideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) both; }
  .dash-stats   { animation: fadeSlideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) 0.35s both; }
  .simulator-enter { animation: fadeSlideUp 0.35s cubic-bezier(0.16, 1, 0.3, 1) both; }

  /* ── Simulator zoom-in from center ──────────────────────────────────────── */
  @keyframes zoomFromCenter {
    0%   { opacity: 0; transform: scale(0.3) translateY(20px); }
    60%  { opacity: 1; transform: scale(1.03) translateY(-3px); }
    100% { opacity: 1; transform: scale(1) translateY(0); }
  }
  @keyframes zoomFromCenterFast {
    0%   { opacity: 0; transform: scale(0.2); }
    55%  { transform: scale(1.04); }
    100% { opacity: 1; transform: scale(1); }
  }
  .sim-zoom-enter {
    animation: zoomFromCenter 0.65s cubic-bezier(0.34, 1.56, 0.64, 1) both;
    transform-origin: center center;
  }

  /* ── Dashboard card hover ───────────────────────────────────────────── */
  .dash-card-inner {
    transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.22s ease;
  }
  .dash-card-inner:hover {
    transform: translateY(-6px) scale(1.015);
    box-shadow: 0 20px 48px -8px rgba(0,0,0,0.18);
  }
  .dash-card-inner:active {
    transform: translateY(-2px) scale(1.005);
  }

  /* ── Card shimmer effect ─────────────────────────────────────────────── */
  @keyframes shimmer {
    0%   { background-position: -200% center; }
    100% { background-position: 200% center; }
  }
  @keyframes pulse-glow {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); }
    50%       { box-shadow: 0 0 20px 4px rgba(255,255,255,0.4); }
  }
  @keyframes float {
    0%, 100% { transform: translateY(0px) rotate(0deg); }
    33%       { transform: translateY(-6px) rotate(3deg); }
    66%       { transform: translateY(-3px) rotate(-2deg); }
  }
  @keyframes spin-slow {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  @keyframes bounce-icon {
    0%, 100% { transform: scale(1) translateY(0); }
    50%       { transform: scale(1.15) translateY(-4px); }
  }
  .card-icon-float { animation: float 3s ease-in-out infinite; }
  .card-icon-bounce { animation: bounce-icon 2s ease-in-out infinite; }
  .card-icon-spin   { animation: spin-slow 8s linear infinite; }

  /* ── Card gradient backgrounds ───────────────────────────────────────── */
  .card-green {
    background: linear-gradient(135deg, #163d44 0%, #1a4a52 40%, #1e5560 100%);
  }
  .card-multi {
    background: linear-gradient(135deg, #312e81 0%, #4c1d95 30%, #7c3aed 60%, #db2777 100%);
  }
  .card-amber {
    background: linear-gradient(135deg, #92400e 0%, #b45309 40%, #d97706 100%);
  }
  .card-strip-green  { background: linear-gradient(90deg, #10b981, #34d399, #6ee7b7); }
  .card-strip-multi  { background: linear-gradient(90deg, #6366f1, #a855f7, #ec4899); }
  .card-strip-amber  { background: linear-gradient(90deg, #f59e0b, #fb923c, #ef4444); }
  .card-campo        { background: linear-gradient(135deg, #1e3a5f 0%, #1e4d8c 50%, #1a6b5c 100%); }
  .card-strip-campo  { background: linear-gradient(90deg, #3b82f6, #0ea5e9, #10b981); }
  .card-simulador    { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); }
  .card-strip-sim    { background: linear-gradient(90deg, #8b5cf6, #6366f1, #3b82f6); }

  /* ── Campo animations ─────────────────────────────────────────────── */
  @keyframes catPop {
    0%   { opacity:0; transform: scale(0.85) translateY(8px); }
    70%  { transform: scale(1.03); }
    100% { opacity:1; transform: scale(1) translateY(0); }
  }
  .cat-enter { animation: catPop 0.7s cubic-bezier(0.34,1.56,0.64,1) both; }
  .cat-enter:nth-child(1) { animation-delay: 0.05s; }
  .cat-enter:nth-child(2) { animation-delay: 0.12s; }
  .cat-enter:nth-child(3) { animation-delay: 0.19s; }

  /* ════════════════════════════════════════════════════════════════
     NEUMORFISMO — REDESIGN VISUAL EXCLUSIVO
     Solo se modifican: background, box-shadow, border-color, color.
     Layout intacto: ningún width, height, flex, grid ni media-query
     estructural fue alterado.
     ════════════════════════════════════════════════════════════════ */

  /* ── Variables del sistema ────────────────────────────────────── */
  :root {
    --nm-bg:   #EAE1D0;                            /* base — fondo = componentes */
    --nm-deep: #DDD2BC;                            /* tono más oscuro */
    --nm-sl:   rgba(255,253,247,0.92);             /* sombra CLARA (luz arriba-izq) */
    --nm-sd:   rgba(176,158,124,0.52);             /* sombra OSCURA (derecha-abajo)  */
    --nm-text: #2E2A20;                            /* texto — contraste ~9:1 sobre nm-bg */
    --nm-sub:  #6E6450;                            /* texto secundario ~4:1          */
    --nm-up:   7px 7px 16px var(--nm-sd), -6px -6px 14px var(--nm-sl);
    --nm-up-s: 3px 3px  8px var(--nm-sd), -3px -3px  8px var(--nm-sl);
    --nm-dn:   inset 5px 5px 11px var(--nm-sd), inset -4px -4px 9px var(--nm-sl);
    --nm-dn-s: inset 3px 3px  6px var(--nm-sd), inset -3px -3px  6px var(--nm-sl);
  }

  /* ── 1. Fondo global ──────────────────────────────────────────── */
  body, .app-bg {
    background: var(--nm-bg) !important;
    color: var(--nm-text) !important;
  }

  /* ── 2. Textos: contraste garantizado ────────────────────────── */
  .text-slate-800, .text-slate-700 { color: var(--nm-text) !important; }
  .text-slate-600, .text-slate-500 { color: var(--nm-sub)  !important; }
  .text-slate-400, .text-slate-300 { color: rgba(100,116,139,0.68) !important; }

  /* ── 3. Fondos blancos / grises neutros → base neumórfica ────── */
  .bg-white, .bg-slate-50, .bg-slate-100, .bg-gray-50 {
    background: var(--nm-bg) !important;
  }

  /* ── 4. Gradientes → base neumórfica (neumorfismo = monocromático) */
  /* (desactivado) los gradientes vuelven a mostrar color por seccion */
  .nm-disabled-grad-placeholder { display:none; }

  /* ── 5. Paneles tintados (bg-*-50/100) → base neumórfica ─────── */
  /* (desactivado) paneles tintados conservan su color por seccion */
  .nm-disabled-tint-placeholder { display:none; }

  /* ── 6. Tarjetas: efecto extruido ────────────────────────────── */
  .rounded-3xl, .rounded-2xl {
    background:   var(--nm-bg) !important;
    box-shadow:   var(--nm-up) !important;
    border-color: transparent  !important;
  }
  .rounded-xl {
    background:   var(--nm-bg)   !important;
    box-shadow:   var(--nm-up-s) !important;
    border-color: transparent    !important;
  }

  /* ── 7. Sombras de Tailwind → neumórficas ────────────────────── */
  .shadow-xl, .shadow-lg, .shadow-md { box-shadow: var(--nm-up)   !important; }
  .shadow-sm, .shadow               { box-shadow: var(--nm-up-s) !important; }

  /* ── 8. Bordes: color → transparente (box-sizing intacto) ───── */
  [class*="border-slate"],   [class*="border-lime"],
  [class*="border-emerald"], [class*="border-violet"],
  [class*="border-sky"],     [class*="border-purple"],
  [class*="border-amber"],   [class*="border-teal"],
  [class*="border-cyan"],    [class*="border-gray"],
  [class*="border-blue"]     { border-color: transparent !important; }

  /* ── 9. Restaurar MenuCards oscuras (identidad visual del menú) */
  .card-green     { background: linear-gradient(135deg,#163d44 0%,#1a4a52 40%,#1e5560 100%) !important; }
  .card-multi     { background: linear-gradient(135deg,#312e81 0%,#4c1d95 30%,#7c3aed 60%,#db2777 100%) !important; }
  .card-amber     { background: linear-gradient(135deg,#92400e 0%,#b45309 40%,#d97706 100%) !important; }
  .card-campo     { background: linear-gradient(135deg,#1e3a5f 0%,#1e4d8c 50%,#1a6b5c 100%) !important; }
  .card-simulador { background: linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%) !important; }
  .card-green, .card-multi, .card-amber, .card-campo, .card-simulador {
    box-shadow: 8px 8px 20px rgba(0,0,0,0.55), -3px -3px 10px rgba(255,255,255,0.07) !important;
  }

  /* ── 10. Restaurar CTAs coloreados + sombra neumórfica de color */
  .bg-emerald-600 {
    background: #059669 !important;
    box-shadow: 5px 5px 13px rgba(4,120,87,0.50), -3px -3px 9px rgba(167,243,208,0.60) !important;
  }
  .bg-emerald-700 { background: #047857 !important; }
  .bg-emerald-500 { background: #10b981 !important; }
  .bg-lime-600 {
    background: #65a30d !important;
    box-shadow: 5px 5px 13px rgba(70,110,10,0.45), -3px -3px 9px rgba(217,249,157,0.60) !important;
  }
  .bg-violet-500 {
    background: #8b5cf6 !important;
    box-shadow: 5px 5px 13px rgba(100,50,200,0.45),-3px -3px 9px rgba(237,233,254,0.60) !important;
  }
  .bg-violet-600 {
    background: #7c3aed !important;
    box-shadow: 5px 5px 13px rgba(90,40,185,0.50), -3px -3px 9px rgba(237,233,254,0.55) !important;
  }
  .bg-teal-600 {
    background: #0d9488 !important;
    box-shadow: 5px 5px 13px rgba(10,120,110,0.50),-3px -3px 9px rgba(204,251,241,0.60) !important;
  }
  .bg-sky-500 {
    background: #0ea5e9 !important;
    box-shadow: 5px 5px 13px rgba(10,130,200,0.45),-3px -3px 9px rgba(224,242,254,0.60) !important;
  }
  .bg-sky-600   { background: #0284c7 !important; }
  .bg-blue-600  { background: #2563eb !important; }
  .bg-red-500, .bg-red-600 {
    background: #ef4444 !important;
    box-shadow: 5px 5px 13px rgba(180,30,30,0.50), -3px -3px 9px rgba(254,226,226,0.60) !important;
  }
  .bg-amber-600 {
    background: #d97706 !important;
    box-shadow: 5px 5px 13px rgba(170,90,10,0.50), -3px -3px 9px rgba(254,243,199,0.60) !important;
  }
  .bg-rose-500  { background: #f43f5e !important; }
  .bg-slate-700, .bg-slate-800 { background: #334155 !important; }

  /* ── 11. Login (pantalla de acceso — fondo oscuro intacto) ───── */
  .login-bg { background: #163d44 !important; box-shadow: none !important; }

  /* ── 12. Inputs: efecto hundido (inset) ──────────────────────── */
  input[type="text"],
  input[type="number"],
  input[type="email"],
  input[type="search"],
  select, textarea {
    background:   var(--nm-bg)  !important;
    box-shadow:   var(--nm-dn)  !important;
    border-color: transparent   !important;
    color:        var(--nm-text) !important;
  }
  input[type="text"]:focus,
  input[type="number"]:focus,
  select:focus, textarea:focus {
    box-shadow: inset 5px 5px 12px var(--nm-sd),
                inset -5px -5px 12px var(--nm-sl),
                0 0 0 3px rgba(16,185,129,0.22) !important;
    outline: none !important;
  }

  /* ── 13. Botones: transición + sombra neumórfica de color ────── */
  button { transition: box-shadow 0.15s ease !important; }

  button[class*="bg-emerald"], button[class*="bg-green"] {
    box-shadow: 5px 5px 13px rgba(4,120,87,0.50), -3px -3px 9px rgba(167,243,208,0.60) !important;
  }
  button[class*="bg-emerald"]:active, button[class*="bg-green"]:active {
    box-shadow: inset 4px 4px 9px rgba(4,120,87,0.45),
                inset -3px -3px 7px rgba(167,243,208,0.50) !important;
  }
  button[class*="bg-lime"] {
    box-shadow: 5px 5px 13px rgba(70,110,10,0.45), -3px -3px 9px rgba(217,249,157,0.60) !important;
  }
  button[class*="bg-lime"]:active {
    box-shadow: inset 4px 4px 9px rgba(70,110,10,0.40),
                inset -3px -3px 7px rgba(217,249,157,0.50) !important;
  }
  button[class*="bg-violet"], button[class*="bg-purple"] {
    box-shadow: 5px 5px 13px rgba(100,50,200,0.45), -3px -3px 9px rgba(237,233,254,0.60) !important;
  }
  button[class*="bg-violet"]:active, button[class*="bg-purple"]:active {
    box-shadow: inset 4px 4px 9px rgba(100,50,200,0.40),
                inset -3px -3px 7px rgba(237,233,254,0.50) !important;
  }
  button[class*="bg-sky"], button[class*="bg-blue"], button[class*="bg-cyan"] {
    box-shadow: 5px 5px 13px rgba(10,100,180,0.45), -3px -3px 9px rgba(224,242,254,0.60) !important;
  }
  button[class*="bg-teal"] {
    box-shadow: 5px 5px 13px rgba(10,120,110,0.50), -3px -3px 9px rgba(204,251,241,0.60) !important;
  }
  button[class*="bg-amber"] {
    box-shadow: 5px 5px 13px rgba(170,90,10,0.50), -3px -3px 9px rgba(254,243,199,0.60) !important;
  }
  button[class*="bg-red"], button[class*="bg-rose"] {
    box-shadow: 5px 5px 13px rgba(180,30,30,0.50), -3px -3px 9px rgba(254,226,226,0.60) !important;
  }

  /* ── 14. Slider: track hundido + thumb extruido ──────────────── */
  input[type=range] { background: transparent !important; box-shadow: none !important; }
  input[type=range]::-webkit-slider-runnable-track {
    background:    var(--nm-deep) !important;
    box-shadow:    inset 2px 2px 5px var(--nm-sd), inset -2px -2px 5px var(--nm-sl) !important;
    border-radius: 8px !important;
    height:        6px !important;
  }
  input[type=range]::-moz-range-track {
    background:    var(--nm-deep) !important;
    box-shadow:    inset 2px 2px 5px var(--nm-sd), inset -2px -2px 5px var(--nm-sl) !important;
    border-radius: 8px !important;
    height:        6px !important;
  }
  input[type=range]::-webkit-slider-thumb {
    background: var(--nm-bg) !important;
    box-shadow: 3px 3px 7px var(--nm-sd), -2px -2px 5px var(--nm-sl) !important;
    border:     2px solid rgba(163,177,198,0.20) !important;
  }
  input[type=range]::-moz-range-thumb {
    background: var(--nm-bg) !important;
    box-shadow: 3px 3px 7px var(--nm-sd), -2px -2px 5px var(--nm-sl) !important;
    border:     2px solid rgba(163,177,198,0.20) !important;
  }

  /* ── 15. Header sticky ───────────────────────────────────────── */
  .sticky.top-0 {
    background:   var(--nm-bg) !important;
    box-shadow:   0 5px 16px var(--nm-sd), 0 -2px 8px var(--nm-sl) !important;
    border-color: transparent !important;
  }

  /* ── 16. Tablas ──────────────────────────────────────────────── */
  table { background: transparent !important; }
  tr    { border-color: rgba(163,177,198,0.20) !important; }

  /* ── 17. Scrollbar ───────────────────────────────────────────── */
  ::-webkit-scrollbar       { width:6px; height:6px; }
  ::-webkit-scrollbar-track {
    background: var(--nm-bg) !important;
    box-shadow: inset 2px 2px 5px var(--nm-sd) !important;
    border-radius: 10px;
  }
  ::-webkit-scrollbar-thumb {
    background:  var(--nm-deep) !important;
    box-shadow:  2px 2px 4px var(--nm-sd), -1px -1px 3px var(--nm-sl) !important;
    border-radius: 10px;
  }

`;

// ─── Long-press hook ──────────────────────────────────────────────────────────
function useLongPress(callback, delay = 120) {
  const intervalRef  = useRef(null);
  const timeoutRef   = useRef(null);
  const callbackRef  = useRef(callback);
  const isActiveRef  = useRef(false);

  // Mantener siempre la referencia al callback actualizado
  useEffect(() => { callbackRef.current = callback; }, [callback]);

  // Cleanup garantizado al desmontar el componente
  useEffect(() => () => { stop(); }, []);

  function stop() {
    isActiveRef.current = false;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }

  function start(e) {
    // Prevenir doble disparo por superposición de eventos touch/mouse
    if (e && e.type === 'mousedown' && e.sourceCapabilities?.firesTouchEvents) return;

    // Siempre limpiar cualquier intervalo/timeout previo antes de iniciar
    stop();

    isActiveRef.current = true;
    callbackRef.current(); // disparo inmediato al presionar

    timeoutRef.current = setTimeout(() => {
      if (!isActiveRef.current) return;
      intervalRef.current = setInterval(() => {
        if (!isActiveRef.current) {
          stop();
          return;
        }
        callbackRef.current();
      }, delay);
    }, 400);
  }

  return {
    onMouseDown:  start,
    onMouseUp:    stop,
    onMouseLeave: stop,
    onTouchStart: (e) => { e.preventDefault(); start(e); },
    onTouchEnd:   stop,
    onTouchCancel: stop,
  };
}

// ─── Slider config per field type ────────────────────────────────────────────
function getSliderConfig(unit, step, value) {
  const s = step ?? 1;
  if (unit === "%")       return { min: 0, max: 100,     step: s };
  if (unit === "días")    return { min: 0, max: 365,     step: s };
  if (unit === "meses")   return { min: 0, max: 36,      step: s };
  if (unit === "años")    return { min: 0, max: 20,      step: s };
  if (unit === "cab")     return { min: 0, max: 5000,    step: s };
  if (unit === "kg")      return { min: 0, max: 700,     step: s };
  if (unit === "$/kg")    return { min: 0, max: 10000,   step: s };
  if (unit === "$/día")   return { min: 0, max: 30000,   step: s };
  if (unit === "$/mes")   return { min: 0, max: 150000,  step: s };
  if (unit === "$/cab")   return { min: 0, max: 2000000, step: s };
  if (unit === "km")      return { min: 0, max: 1500,    step: s }; // ← MEJORA 4: más km
  if (unit === "$/km")    return { min: 2500, max: 6000, step: s }; // ← MEJORA 4: rango precio flete
  if (unit === "kg INMAG" || unit === "kg/mes") return { min: 0, max: 30, step: s };
  if (unit === "kg/día")  return { min: 0, max: 3,       step: s };
  if (unit === "kg/ha")   return { min: 0, max: 300,     step: s };
  if (unit === "kg toros") return { min: 0, max: 10,     step: s };
  const mag = Math.max(value * 3, 5000000);
  return { min: 0, max: mag, step: s };
}

// ─── Field component (with long-press + decimal fix) ─────────────────────────
function Field({ label, value, onChange, unit, hint, highlight, readOnly, step, sliderMax, noSlider, minVal, compact }) {
  const s = step ?? 1;
  const minV = minVal ?? 0;
  const numVal = Number(value) || 0;
  // Local string state so user can clear the field while typing
  const [inputStr, setInputStr] = useState(null); // null = use prop value

  const handleChange = (raw) => {
    if (!onChange) return;
    let v = Math.max(minV, Number(raw));
    // MEJORA 2: fix decimal floating point para pasos de 0.1
    if (s < 1) {
      v = Math.round(v * 10) / 10;
    }
    onChange(v);
  };

  const handleInputChange = (e) => {
    const raw = e.target.value;
    setInputStr(raw); // only update local display — don't commit yet
  };

  const handleInputBlur = () => {
    const raw = inputStr;
    setInputStr(null);
    if (raw === '' || raw === null) {
      onChange && onChange(minV);
      return;
    }
    if (!onChange) return;
    let v = Math.max(minV, Number(raw));
    if (s < 1) v = Math.round(v * 10) / 10;
    if (!isNaN(v)) onChange(v);
  };

  // MEJORA 3: Long-press handlers
  const incFn = useCallback(() => {
    if (s < 1) {
      onChange(Math.round((numVal + s) * 10) / 10);
    } else {
      onChange(numVal + s);
    }
  }, [numVal, s, onChange]);

  const decFn = useCallback(() => {
    if (s < 1) {
      onChange(Math.max(minV, Math.round((numVal - s) * 10) / 10));
    } else {
      onChange(Math.max(minV, numVal - s));
    }
  }, [numVal, s, minV, onChange]);

  const incPress = useLongPress(incFn);
  const decPress = useLongPress(decFn);

  const reset = () => handleChange(minV);

  const sliderCfg = getSliderConfig(unit, s, numVal);
  const sliderMax_ = sliderMax ?? sliderCfg.max;

  const accent = highlight
    ? { border: "border-emerald-400", bg: "bg-emerald-50", text: "text-emerald-800", ring: "focus:ring-emerald-400/50 focus:border-emerald-500", btn: "bg-emerald-500 hover:bg-emerald-600 text-white active:bg-emerald-700", sliderClass: "" }
    : { border: "border-slate-200", bg: "bg-white", text: "text-slate-800", ring: "focus:ring-emerald-400/50 focus:border-emerald-400", btn: "bg-slate-800 hover:bg-slate-900 text-white active:bg-black", sliderClass: "" };

  if (readOnly) {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-xs font-semibold tracking-wider uppercase text-slate-500">{label}</label>
        <div className={`w-full rounded-lg border ${accent.border} ${accent.bg} px-3 py-2.5 text-sm font-mono ${accent.text} opacity-60 cursor-not-allowed`}>
          {numVal} {unit && <span className="text-xs text-slate-400 ml-1">{unit}</span>}
        </div>
        {hint && <p className="text-xs text-slate-400 italic">{hint}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold tracking-wider uppercase text-slate-500">{label}</label>
        <button onClick={reset} title="Poner en cero"
          className="text-xs font-black bg-gradient-to-r from-orange-400 to-red-400 hover:from-orange-500 hover:to-red-500 text-white border-0 transition-all px-2 py-0.5 rounded-lg leading-none tabular-nums select-none shadow-sm active:scale-95">×0</button>
      </div>

      <div className={`flex items-stretch rounded-xl border ${accent.border} overflow-hidden shadow-sm`}>
        {/* Decrement con long-press */}
        <button {...decPress}
          className={`${accent.btn} flex items-center justify-center ${compact ? "w-8 min-h-[40px] text-base" : "w-9 min-h-[44px] text-base"} shrink-0 font-black transition-all active:scale-95 border-r ${accent.border} touch-manipulation select-none`}
          aria-label="Reducir">−</button>

        <div className="relative flex-1 min-w-0">
          <input type="number" min={minV} step={s}
            value={inputStr !== null ? inputStr : value}
            onChange={handleInputChange}
            onBlur={handleInputBlur}
            onFocus={(e) => { setInputStr(String(value)); e.target.select(); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
            className={`w-full h-full ${accent.bg} ${accent.text} ${compact ? "px-1 py-2.5 text-sm" : "px-1 py-2.5 text-base"} font-mono font-semibold text-center
              [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none
              focus:outline-none focus:ring-2 ${accent.ring} transition-all`} />
        </div>

        {unit && (
          <span className={`${accent.bg} ${accent.text} opacity-60 flex items-center ${compact ? "px-1 text-xs" : "px-2 text-xs"} font-mono border-l ${accent.border} shrink-0 whitespace-nowrap`}>
            {unit}
          </span>
        )}

        {/* Increment con long-press */}
        <button {...incPress}
          className={`${accent.btn} flex items-center justify-center ${compact ? "w-8 min-h-[40px] text-base" : "w-9 min-h-[44px] text-base"} shrink-0 font-black transition-all active:scale-95 border-l ${accent.border} touch-manipulation select-none`}
          aria-label="Aumentar">+</button>
      </div>

      {/* MEJORA 7: slider styled via global CSS, grows on active */}
      {!noSlider && sliderMax_ > 0 && (() => {
        const sliderVal = Math.min(numVal, sliderMax_);
        const pct = sliderMax_ > sliderCfg.min
          ? ((sliderVal - sliderCfg.min) / (sliderMax_ - sliderCfg.min)) * 100
          : 0;
        return (
          <input type="range"
            min={sliderCfg.min}
            max={sliderMax_}
            step={s}
            value={sliderVal}
            onChange={(e) => handleChange(e.target.value)}
            className="w-full touch-manipulation"
            style={{
              accentColor: "#10b981",
              background: `linear-gradient(to right, #10b981 ${pct}%, #d1fae5 ${pct}%)`
            }}
          />
        );
      })()}

      {hint && <p className="text-xs text-slate-400 italic leading-tight">{hint}</p>}
    </div>
  );
}

function SectionTitle({ children, icon, color = "text-emerald-600" }) {
  return (
    <div className="flex items-center gap-2 mb-4 mt-1 section-enter">
      {icon && <span className="text-base">{icon}</span>}
      <h3 className={`text-xs font-black tracking-widest uppercase ${color}`}>{children}</h3>
      <div className="flex-1 section-accent" />
    </div>
  );
}

function KpiCard({ label, value, sub, color = "text-slate-800", bg = "bg-white", border = "border-slate-200", large }) {
  return (
    <div className={`rounded-2xl border-2 p-4 flex flex-col gap-1 card-hover kpi-pop ${bg} ${border}`}>
      <span className="text-xs font-bold tracking-wider uppercase text-slate-400">{label}</span>
      <span className={`font-mono font-black tabular-nums value-update ${large ? "text-3xl" : "text-2xl"} ${color}`}>{value}</span>
      {sub && <span className="text-xs text-slate-400 leading-tight">{sub}</span>}
    </div>
  );
}

function Divider() { return <div className="my-6" style={{height:'2px',background:'linear-gradient(90deg,transparent,#e2e8f0,#10b981,#e2e8f0,transparent)'}} />; }

// ─── Botón Fijar (Guardar configuración) ──────────────────────────────────────
function SaveButton({ onSave, saving, saved }) {
  return (
    <button
      onClick={onSave}
      disabled={saving}
      className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-black text-sm transition-all shadow-md select-none
        ${saved
          ? "bg-emerald-500 text-white border-2 border-emerald-600 scale-95"
          : saving
          ? "bg-slate-200 text-slate-400 border-2 border-slate-300 cursor-wait"
          : "bg-white text-emerald-700 border-2 border-emerald-400 hover:bg-emerald-50 hover:border-emerald-500 active:scale-95"
        }`}
    >
      {saving ? (
        <><span className="animate-spin">⏳</span> Guardando...</>
      ) : saved ? (
        <><span>✅</span> ¡Fijado!</>
      ) : (
        <><span>📌</span> Fijar</>
      )}
    </button>
  );
}

// ─── Inflation Indicator ──────────────────────────────────────────────────────
function InflationIndicator({ precioCompra, precioVenta, inflacionMensual, meses, label }) {
  const variacionNominal = precioCompra > 0 ? ((precioVenta - precioCompra) / precioCompra) * 100 : 0;
  const inflacionAcumulada = (Math.pow(1 + inflacionMensual / 100, meses) - 1) * 100;
  const delta = variacionNominal - inflacionAcumulada;
  const status =
    Math.abs(delta) < 0.5
      ? { label: "Empata inflación", color: "text-amber-600", bg: "bg-amber-50", border: "border-amber-200", icon: "≈" }
      : delta > 0
      ? { label: "Le gana a la inflación", color: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-200", icon: "▲" }
      : { label: "Pierde contra la inflación", color: "text-red-600", bg: "bg-red-50", border: "border-red-200", icon: "▼" };
  return (
    <div className={`rounded-xl border p-4 space-y-3 ${status.bg} ${status.border}`}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-black uppercase tracking-widest text-slate-500">📈 Inflación — {label}</p>
        <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${status.bg} ${status.border} ${status.color}`}>
          {status.icon} {status.label}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-white/70 rounded-lg p-2.5 border border-white">
          <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider">Var. Nominal</p>
          <p className={`font-mono font-bold text-lg ${variacionNominal >= 0 ? "text-slate-700" : "text-red-500"}`}>{fmtPct(variacionNominal)}</p>
          <p className="text-xs text-slate-400">precio carne</p>
        </div>
        <div className="bg-white/70 rounded-lg p-2.5 border border-white">
          <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider">Inflación ({fmt(meses, 1)} m)</p>
          <p className="font-mono font-bold text-lg text-orange-600">{fmtPct(inflacionAcumulada)}</p>
          <p className="text-xs text-slate-400">acumulada</p>
        </div>
        <div className={`rounded-lg p-2.5 border border-white/50 ${status.bg}`}>
          <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider">Diferencial</p>
          <p className={`font-mono font-bold text-xl ${status.color}`}>{fmtPct(delta)}</p>
          <p className={`text-xs font-semibold ${status.color}`}>variación real</p>
        </div>
      </div>
    </div>
  );
}

// ─── Toggle Switch ────────────────────────────────────────────────────────────
function ToggleSwitch({ on, onToggle, label }) {
  return (
    <button onClick={onToggle}
      className="flex items-center gap-2 select-none group"
      title={on ? "Activo — clic para desactivar" : "Inactivo — clic para activar"}>
      <div className={`relative w-12 h-6 rounded-full transition-all duration-300 shadow-inner
        ${on
          ? "bg-gradient-to-r from-emerald-400 to-emerald-600 shadow-emerald-200"
          : "bg-slate-200"}`}>
        <div className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full shadow-md transition-all duration-300
          ${on ? "translate-x-6 bg-white shadow-emerald-300" : "translate-x-0 bg-white"}`}
          style={{transition:"transform 0.3s cubic-bezier(0.34,1.56,0.64,1)"}} />
      </div>
      <span className={`text-xs font-bold transition-all duration-200
        ${on ? "text-emerald-700" : "text-slate-400"}`}>{label}</span>
    </button>
  );
}

// ─── Gastos Comerciales ───────────────────────────────────────────────────────
function GastosComerciales({ gastos, setGastos }) {
  const set = (k) => (v) => setGastos((p) => ({ ...p, [k]: v }));

  // Totales visibles (0 cuando el toggle está off)
  const fleteCompra = gastos.fleteCompraOn ? gastos.kmCompra * gastos.precioKmCompra : 0;
  const fleteVenta  = gastos.fleteVentaOn  ? gastos.kmVenta  * gastos.precioKmVenta  : 0;

  // Toggles independientes del valor numérico
  const toggleFlete = (tipo) => () =>
    setGastos((p) => ({
      ...p,
      [tipo === "compra" ? "fleteCompraOn" : "fleteVentaOn"]:
        !p[tipo === "compra" ? "fleteCompraOn" : "fleteVentaOn"],
    }));

  const toggleComision = (tipo) => () =>
    setGastos((p) => ({
      ...p,
      [tipo === "compra" ? "comisionCompraOn" : "comisionVentaOn"]:
        !p[tipo === "compra" ? "comisionCompraOn" : "comisionVentaOn"],
    }));

  const FleteBlock = ({ tipo }) => {
    const onKey  = tipo === "compra" ? "fleteCompraOn"  : "fleteVentaOn";
    const kmKey  = tipo === "compra" ? "kmCompra"       : "kmVenta";
    const pkmKey = tipo === "compra" ? "precioKmCompra" : "precioKmVenta";
    const label  = tipo === "compra" ? "Flete Compra"   : "Flete Venta";
    const icon   = tipo === "compra" ? "🚛"             : "🚚";
    const on     = gastos[onKey];
    const flete  = on ? gastos[kmKey] * gastos[pkmKey] : 0;
    return (
      <div className={`rounded-2xl border-2 p-3.5 transition-all duration-300 ${on
        ? "bg-white border-sky-200 shadow-md shadow-sky-50"
        : "bg-slate-50 border-slate-100"}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-base">{icon}</span>
            <span className={`text-xs font-black uppercase tracking-widest transition-colors ${on ? "text-sky-700" : "text-slate-400"}`}>{label}</span>
            {on && <span className="text-xs font-bold bg-sky-100 text-sky-600 px-2 py-0.5 rounded-full border border-sky-200 animate-pulse">{fmtMoney(flete)}</span>}
          </div>
          <ToggleSwitch on={on} onToggle={toggleFlete(tipo)} label={on ? "Activo" : "Off"} />
        </div>
        <div className={`overflow-hidden transition-all duration-300 ease-in-out ${on ? "max-h-60 opacity-100 mt-3" : "max-h-0 opacity-0"}`}>
          <div className="space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Field label={`KM ${tipo}`} value={gastos[kmKey]} onChange={set(kmKey)} unit="km" step={10} sliderMax={1500} />
              <Field label="Precio / km" value={gastos[pkmKey]} onChange={set(pkmKey)} unit="$/km" step={50} />
            </div>
            <div className="rounded-xl bg-sky-50 border border-sky-200 px-3 py-2.5 flex justify-between items-center">
              <span className="text-xs text-sky-600 font-bold uppercase tracking-wider">Flete total</span>
              <span className="font-mono font-black text-sky-800 text-base">{fmtMoney(flete)}</span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const ComisionBlock = ({ tipo }) => {
    const onKey = tipo === "compra" ? "comisionCompraOn" : "comisionVentaOn";
    const key   = tipo === "compra" ? "comisionCompra"   : "comisionVenta";
    const label = tipo === "compra" ? "Comisión Compra"  : "Comisión Venta";
    const icon  = tipo === "compra" ? "📋"               : "📄";
    const on    = gastos[onKey];
    return (
      <div className={`rounded-2xl border-2 p-3.5 transition-all duration-300 ${on
        ? "bg-white border-emerald-200 shadow-md shadow-emerald-50"
        : "bg-slate-50 border-slate-100"}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-base">{icon}</span>
            <span className={`text-xs font-black uppercase tracking-widest transition-colors ${on ? "text-emerald-700" : "text-slate-400"}`}>{label}</span>
            {on && <span className="text-xs font-bold bg-emerald-100 text-emerald-600 px-2 py-0.5 rounded-full border border-emerald-200 animate-pulse">{gastos[key]}%</span>}
          </div>
          <ToggleSwitch on={on} onToggle={toggleComision(tipo)} label={on ? "Activo" : "Off"} />
        </div>
        <div className={`overflow-hidden transition-all duration-300 ease-in-out ${on ? "max-h-40 opacity-100 mt-3" : "max-h-0 opacity-0"}`}>
          <Field label="Porcentaje" value={gastos[key]} onChange={set(key)} unit="%" step={0.5} sliderMax={5} />
        </div>
      </div>
    );
  };

  return (
    <div className="rounded-2xl border-2 border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4 space-y-3 shadow-lg">
      <div className="flex items-center gap-2">
        <span className="w-7 h-7 rounded-lg bg-gradient-to-br from-slate-700 to-slate-900 flex items-center justify-center text-sm shadow-sm">🧾</span>
        <p className="text-xs font-black uppercase tracking-widest text-slate-700">Gastos Comerciales</p>
        <span className="text-xs text-slate-400 normal-case">— activá los que apliquen</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FleteBlock tipo="compra" />
        <ComisionBlock tipo="compra" />
        <FleteBlock tipo="venta" />
        <ComisionBlock tipo="venta" />
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        {[
          { label: `Flete compra ${fmtMoney(fleteCompra)}`,  on: gastos.fleteCompraOn },
          { label: `Com. compra ${gastos.comisionCompra}%`,  on: gastos.comisionCompraOn },
          { label: `Flete venta ${fmtMoney(fleteVenta)}`,    on: gastos.fleteVentaOn },
          { label: `Com. venta ${gastos.comisionVenta}%`,    on: gastos.comisionVentaOn },
        ].map(({ label, on }) => (
          <span key={label} className={`text-xs px-2.5 py-1 rounded-full font-semibold border transition-all
            ${on ? "bg-red-50 border-red-200 text-red-600" : "bg-slate-100 border-slate-200 text-slate-400 line-through"}`}>
            {label}
          </span>
        ))}
      </div>
      <p className="text-xs text-slate-400 italic">Compra → suma a la inversión · Venta → se resta del ingreso bruto</p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENTE REUTILIZABLE: PLAN DE PAGO (financiamiento diferido)
// ═══════════════════════════════════════════════════════════════════════════
// Divide un monto total en plazos (contado / 30 / 60 / 90 días) y analiza el
// beneficio de pagar diferido: ahorro por inflación + rendimiento de invertir.
function PlanPago({ montoTotal, inflacionMensual = 4, color = "emerald" }) {
  const [abierto, setAbierto] = React.useState(false);
  // % en cada plazo. Default: todo contado.
  const [reparto, setReparto] = React.useState({ contado: 100, d30: 0, d60: 0, d90: 0 });
  const [tasaInversion, setTasaInversion] = React.useState(0); // % mensual que rinde el dinero si lo invertís (ej: plazo fijo)

  const COLORS = {
    emerald: { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-700", btn: "bg-emerald-600 hover:bg-emerald-700", accent: "accent-emerald-500" },
    amber:   { bg: "bg-amber-50",   border: "border-amber-200",   text: "text-amber-700",   btn: "bg-amber-500 hover:bg-amber-600",   accent: "accent-amber-500" },
    blue:    { bg: "bg-blue-50",    border: "border-blue-200",    text: "text-blue-700",    btn: "bg-blue-600 hover:bg-blue-700",     accent: "accent-blue-500" },
    violet:  { bg: "bg-violet-50",  border: "border-violet-200",  text: "text-violet-700",  btn: "bg-violet-600 hover:bg-violet-700",  accent: "accent-violet-500" },
    sky:     { bg: "bg-sky-50",     border: "border-sky-200",     text: "text-sky-700",     btn: "bg-sky-600 hover:bg-sky-700",       accent: "accent-sky-500" },
  };
  const c = COLORS[color] || COLORS.emerald;

  const sumaPct = reparto.contado + reparto.d30 + reparto.d60 + reparto.d90;
  const fmtP = (n) => "$" + Math.round(n).toLocaleString("es-AR");

  // Plazos en meses para descuento
  const plazos = [
    { key: "contado", label: "Contado",   meses: 0 },
    { key: "d30",     label: "30 días",   meses: 1 },
    { key: "d60",     label: "60 días",   meses: 2 },
    { key: "d90",     label: "90 días",   meses: 3 },
  ];

  // Cálculo: para cada cuota, su valor presente (descontado por inflación)
  // y cuánto generaría si invierto ese dinero hasta la fecha de pago.
  const infl = inflacionMensual / 100;
  const tasa = tasaInversion / 100;

  let valorPresenteTotal = 0;   // lo que realmente "cuesta" hoy pagar diferido
  let rendimientoInversion = 0; // lo que ganás invirtiendo el dinero no desembolsado
  const detalle = plazos.map(p => {
    const monto = montoTotal * (reparto[p.key] || 0) / 100;
    // Valor presente: cuánto vale hoy esa cuota futura (inflación la licúa)
    const vp = monto / Math.pow(1 + infl, p.meses);
    valorPresenteTotal += vp;
    // Si invierto el monto de la cuota durante los meses hasta pagarla
    const rinde = tasa > 0 ? monto * (Math.pow(1 + tasa, p.meses) - 1) : 0;
    rendimientoInversion += rinde;
    return { ...p, monto, vp, ahorroInflacion: monto - vp, rinde };
  });

  const ahorroInflacionTotal = montoTotal - valorPresenteTotal;
  const costoRealHoy = valorPresenteTotal - rendimientoInversion; // lo más cercano al costo económico real
  const beneficioTotal = ahorroInflacionTotal + rendimientoInversion;
  const pctBeneficio = montoTotal > 0 ? (beneficioTotal / montoTotal) * 100 : 0;

  const setPct = (key, val) => {
    setReparto(prev => ({ ...prev, [key]: Math.max(0, Math.min(100, Number(val) || 0)) }));
  };

  if (!abierto) return (
    <button onClick={() => setAbierto(true)}
      className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-2xl border-2 ${c.border} ${c.bg} ${c.text} font-black text-sm transition-all active:scale-95`}>
      💳 Analizar plan de pago (contado / 30 / 60 / 90 días)
    </button>
  );

  return (
    <div className={`border-2 ${c.border} rounded-3xl overflow-hidden`}>
      <div className={`px-4 py-3 ${c.bg} flex items-center justify-between`}>
        <div className="flex items-center gap-2">
          <span className="text-xl">💳</span>
          <div>
            <p className={`text-xs font-black uppercase tracking-widest ${c.text}`}>Plan de pago diferido</p>
            <p className="text-xs text-slate-500">Total a financiar: {fmtP(montoTotal)}</p>
          </div>
        </div>
        <button onClick={() => setAbierto(false)} className="text-slate-400 hover:text-slate-600 font-black text-sm px-2">✕</button>
      </div>

      <div className="p-4 space-y-4">
        {/* Reparto por plazo */}
        <div>
          <p className="text-xs font-black uppercase tracking-widest text-slate-400 mb-2">¿Cómo dividís el pago?</p>
          <div className="space-y-3">
            {plazos.map(p => (
              <div key={p.key} className="flex items-center gap-3">
                <span className="text-xs font-bold text-slate-600 w-16">{p.label}</span>
                <input type="range" min="0" max="100" step="5" value={reparto[p.key]}
                  onChange={e => setPct(p.key, e.target.value)}
                  className={`flex-1 ${c.accent}`} />
                <div className="flex items-center gap-1 w-20">
                  <input type="number" value={reparto[p.key]} onChange={e => setPct(p.key, e.target.value)}
                    className={`w-14 border-2 ${c.border} rounded-lg px-2 py-1 text-sm text-right font-mono`} />
                  <span className="text-xs text-slate-400">%</span>
                </div>
                <span className="text-xs font-mono text-slate-500 w-24 text-right">{fmtP(montoTotal * (reparto[p.key]||0) / 100)}</span>
              </div>
            ))}
          </div>
          {sumaPct !== 100 && (
            <p className={`text-xs font-bold mt-2 ${sumaPct > 100 ? "text-red-500" : "text-amber-600"}`}>
              ⚠️ La suma de los plazos es {sumaPct}% — tiene que dar 100%
            </p>
          )}
        </div>

        {/* Tasa de inversión */}
        <div className={`${c.bg} rounded-xl p-3`}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold text-slate-600">¿Cuánto rinde tu plata si la invertís?</p>
              <p className="text-xs text-slate-400">Plazo fijo, dólar, etc. — % mensual</p>
            </div>
            <div className="flex items-center gap-1">
              <input type="number" value={tasaInversion} onChange={e => setTasaInversion(Math.max(0, Number(e.target.value) || 0))}
                step="0.5" className={`w-16 border-2 ${c.border} rounded-lg px-2 py-1.5 text-sm text-right font-mono`} />
              <span className="text-xs text-slate-400">%/mes</span>
            </div>
          </div>
        </div>

        {/* Resultados (solo si reparto válido) */}
        {sumaPct === 100 && (
          <div className="space-y-3">
            {/* Cronograma */}
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="w-full text-xs">
                <thead className={`${c.bg}`}>
                  <tr className="text-slate-500">
                    <th className="text-left py-2 px-3 font-black">Plazo</th>
                    <th className="text-right py-2 px-2 font-black">Pagás</th>
                    <th className="text-right py-2 px-2 font-black">Vale hoy</th>
                    <th className="text-right py-2 px-3 font-black">Ahorrás</th>
                  </tr>
                </thead>
                <tbody>
                  {detalle.filter(d => d.monto > 0).map(d => (
                    <tr key={d.key} className="border-t border-slate-100">
                      <td className="py-2 px-3 font-bold text-slate-700">{d.label}</td>
                      <td className="py-2 px-2 text-right font-mono text-slate-600">{fmtP(d.monto)}</td>
                      <td className="py-2 px-2 text-right font-mono text-slate-500">{fmtP(d.vp)}</td>
                      <td className={`py-2 px-3 text-right font-mono font-bold ${c.text}`}>{d.ahorroInflacion > 0 ? fmtP(d.ahorroInflacion) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Beneficios */}
            <div className="grid grid-cols-2 gap-2">
              <div className={`${c.bg} rounded-xl p-3 text-center border ${c.border}`}>
                <p className="text-xs text-slate-500">Ahorro por inflación</p>
                <p className={`text-xl font-black ${c.text} font-mono`}>{fmtP(ahorroInflacionTotal)}</p>
                <p className="text-xs text-slate-400">las cuotas futuras valen menos</p>
              </div>
              <div className={`${c.bg} rounded-xl p-3 text-center border ${c.border}`}>
                <p className="text-xs text-slate-500">Rinde si lo invertís</p>
                <p className={`text-xl font-black ${c.text} font-mono`}>{tasaInversion > 0 ? fmtP(rendimientoInversion) : "—"}</p>
                <p className="text-xs text-slate-400">{tasaInversion > 0 ? `a ${tasaInversion}%/mes` : "cargá una tasa arriba"}</p>
              </div>
            </div>

            {/* Total */}
            <div className={`rounded-2xl p-4 text-white text-center ${c.btn.split(" ")[0]}`}>
              <p className="text-xs uppercase tracking-widest opacity-80 font-black">Beneficio total de pagar diferido</p>
              <p className="text-3xl font-black font-mono mt-1">{fmtP(beneficioTotal)}</p>
              <p className="text-xs opacity-80 mt-1">
                Equivale a un {pctBeneficio.toFixed(1)}% de descuento real sobre el precio de lista
              </p>
            </div>

            <p className="text-xs text-slate-400 text-center leading-relaxed">
              💡 Pagar a plazo, con inflación de {inflacionMensual}%/mes, te conviene mientras el vendedor
              no te recargue más que ese {pctBeneficio.toFixed(1)}% por financiarte.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO: PODER DE COMPRA
// ═══════════════════════════════════════════════════════════════════════════
function PoderDeCompra({ onGuardar, onToast, initialVenta, onAgregarAlCampo }) {
  const gastos = useGastos(); // lee del store global — reactivo
  const inflacionMensual = useStore(vacaStore, s => s.global?.inflacionMensual ?? 4);
  const [venta, setVenta] = useState(initialVenta || { cantidad: 100, pesoPromedio: 430, precioKg: 2200 });
  const [compra, setCompra] = useState({ pesoAnimal: 200, precioKg: 1800 });
  const setV = (k) => (v) => setVenta((p) => ({ ...p, [k]: v }));
  const setC = (k) => (v) => setCompra((p) => ({ ...p, [k]: v }));

  const calc = useMemo(() => {
    const ingresoBrutoVenta = venta.cantidad * venta.pesoPromedio * venta.precioKg;
    const fleteVentaCalc = gastos.fleteVentaOn ? gastos.kmVenta * gastos.precioKmVenta : 0;
    const fleteCompraCalc = gastos.fleteCompraOn ? gastos.kmCompra * gastos.precioKmCompra : 0;
    const comisionVentaPct = gastos.comisionVentaOn ? gastos.comisionVenta / 100 : 0;
    const comisionCompraPct = gastos.comisionCompraOn ? gastos.comisionCompra / 100 : 0;
    const gastoComisionVenta = ingresoBrutoVenta * comisionVentaPct;
    const ingresoNetoVenta = ingresoBrutoVenta - fleteVentaCalc - gastoComisionVenta;
    const precioAnimalBruto = compra.pesoAnimal * compra.precioKg;
    const costoUnitarioBruto = precioAnimalBruto * (1 + comisionCompraPct);
    const cabezasComprables = costoUnitarioBruto > 0
      ? Math.floor((ingresoNetoVenta - fleteCompraCalc) / costoUnitarioBruto)
      : 0;
    const costoRealTotal = cabezasComprables * costoUnitarioBruto + fleteCompraCalc;
    const sobrante = ingresoNetoVenta - costoRealTotal;
    const relacionVentaCompra = venta.cantidad > 0 ? cabezasComprables / venta.cantidad : 0;
    return { ingresoBrutoVenta, ingresoNetoVenta, costoUnitarioBruto, cabezasComprables, costoRealTotal, sobrante, relacionVentaCompra };
  }, [venta, compra, gastos]);

  const ratio = calc.relacionVentaCompra;
  const ratioColor = ratio >= 1.3 ? "text-emerald-600" : ratio >= 1 ? "text-amber-600" : "text-red-500";
  const comisionCompraPct = gastos.comisionCompraOn ? gastos.comisionCompra / 100 : 0;
  const fleteCompraCalc = gastos.fleteCompraOn ? gastos.kmCompra * gastos.precioKmCompra : 0;

  return (
    <div className="rounded-2xl border-2 border-sky-200 p-5 md:p-6 space-y-5 shadow-lg card-hover" style={{background:"linear-gradient(135deg,#f0f9ff,#ecfeff)"}}>
      <div className="flex items-center gap-3">
        <span className="w-8 h-8 rounded-lg bg-sky-500 flex items-center justify-center text-white font-black text-sm">⇄</span>
        <div>
          <p className="font-black text-sky-800 text-base tracking-tight">Poder de Compra — Triangulación Venta / Compra</p>
          <p className="text-xs text-sky-600">¿Si vendo X, cuántos Y puedo comprar? Los gastos comerciales se aplican automáticamente.</p>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl border p-4 space-y-3 section-sky">
          <p className="text-xs font-black uppercase tracking-widest text-sky-700">📤 Origen — Animales que Vendo</p>
          <div className="grid grid-cols-1 gap-3">
            <Field label="Cantidad" value={venta.cantidad} onChange={setV("cantidad")} unit="cab" />
            <Field label="Peso prom." value={venta.pesoPromedio} onChange={setV("pesoPromedio")} unit="kg" />
            <Field label="Precio venta" value={venta.precioKg} onChange={setV("precioKg")} unit="$/kg" step={50} />
          </div>
          <div className="rounded-lg bg-sky-50 border border-sky-100 p-3 space-y-1">
            <div className="flex justify-between text-xs text-slate-500">
              <span>Ingreso bruto</span><span className="font-mono font-semibold">{fmtMoney(calc.ingresoBrutoVenta)}</span>
            </div>
            <div className="flex justify-between text-xs text-red-400">
              <span>− Flete + comisión venta{gastos.comisionVentaOn ? ` (${gastos.comisionVenta}%)` : ""}</span>
              <span className="font-mono">−{fmtMoney(calc.ingresoBrutoVenta - calc.ingresoNetoVenta)}</span>
            </div>
            <div className="flex justify-between text-sm font-bold border-t border-sky-200 pt-1 text-sky-800">
              <span>= Ingreso neto disponible</span><span className="font-mono">{fmtMoney(calc.ingresoNetoVenta)}</span>
            </div>
          </div>
        </div>
        <div className="rounded-xl border p-4 space-y-3 section-sky">
          <p className="text-xs font-black uppercase tracking-widest text-sky-700">📥 Destino — Animales que Compro</p>
          <div className="grid grid-cols-1 gap-3">
            <Field label="Peso del animal" value={compra.pesoAnimal} onChange={setC("pesoAnimal")} unit="kg" />
            <Field label="Precio compra" value={compra.precioKg} onChange={setC("precioKg")} unit="$/kg" step={50} />
          </div>
          <div className="rounded-lg bg-sky-50 border border-sky-100 p-3 space-y-1">
            <div className="flex justify-between text-xs text-slate-500">
              <span>Precio animal</span><span className="font-mono font-semibold">{fmtMoney(compra.pesoAnimal * compra.precioKg)}</span>
            </div>
            <div className="flex justify-between text-xs text-red-400">
              <span>+ Comisión compra{gastos.comisionCompraOn ? ` (${gastos.comisionCompra}%)` : ""}</span>
              <span className="font-mono">+{fmtMoney(compra.pesoAnimal * compra.precioKg * comisionCompraPct)}</span>
            </div>
            <div className="flex justify-between text-sm font-bold border-t border-sky-200 pt-1 text-sky-800">
              <span>= Costo real / cabeza</span><span className="font-mono">{fmtMoney(calc.costoUnitarioBruto)}</span>
            </div>
          </div>
        </div>
      </div>
      <div className="rounded-2xl border-2 border-sky-300 bg-white p-5 flex flex-col md:flex-row items-center gap-6">
        <div className="flex-1 text-center md:text-left">
          <p className="text-xs font-black uppercase tracking-widest text-slate-400 mb-1">Resultado de la Triangulación</p>
          <p className="text-slate-600 text-sm leading-relaxed">Con la venta de <span className="font-black text-slate-800">{fmt(venta.cantidad)} novillos</span> podés reponer</p>
          <p className={`font-mono font-black text-5xl mt-1 ${ratioColor}`}>{calc.cabezasComprables > 0 ? fmt(calc.cabezasComprables) : "—"}</p>
          <p className="text-slate-500 text-sm mt-0.5">terneros — relación <span className={`font-black ${ratioColor}`}>{fmt(ratio, 2)}:1</span></p>
        </div>
        <div className="shrink-0 grid grid-cols-2 gap-3 w-full md:w-auto">
          <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 text-center">
            <p className="text-xs text-slate-400 uppercase tracking-wider font-semibold">Sobrante</p>
            <p className={`font-mono font-bold text-xl ${calc.sobrante >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtMoney(calc.sobrante)}</p>
          </div>
          <div className="rounded-xl bg-sky-50 border border-sky-200 px-4 py-3 text-center">
            <p className="text-xs text-sky-600 uppercase tracking-wider font-semibold">Flete compra</p>
            <p className="font-mono font-bold text-xl text-sky-700">{fmtMoney(fleteCompraCalc)}</p>
            <p className="text-xs text-sky-400">incluido en cálculo</p>
          </div>
        </div>
      </div>

      {/* Plan de pago diferido */}
      <PlanPago montoTotal={calc.costoRealTotal} inflacionMensual={inflacionMensual} color="sky" />

      {/* Asesor IA — Poder de Compra */}
      <AsesorIA
        color="blue"
        titulo="Análisis del poder de compra"
        placeholder="Ej: ¿Es buen momento para comprar? ¿Qué relación ternero/novillo conviene? ¿Cuándo vender?"
        contexto={[
          `Poder de Compra — triangulación venta/compra`,
          `Venta: ${venta.cantidad} cab × ${venta.pesoPromedio} kg × $${venta.precioKg}/kg = ${fmtMoney(calc.ingresoBrutoVenta)}`,
          `Ingreso neto de venta: ${fmtMoney(calc.ingresoNetoVenta)}`,
          `Compra: ${compra.pesoAnimal} kg/cab × $${compra.precioKg}/kg = $${Math.round(calc.costoUnitarioBruto).toLocaleString("es-AR")}/animal`,
          `Cabezas comprables: ${calc.cabezasComprables} cab`,
          `Relación venta/compra: ${calc.relacionVentaCompra.toFixed(2)} (${calc.relacionVentaCompra >= 1.3 ? "excelente" : calc.relacionVentaCompra >= 1 ? "aceptable" : "peligroso"})`,
          `Sobrante: ${fmtMoney(calc.sobrante)}`,
        ].join("\n")}
      />

      {/* Guardar simulación */}
      <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
        <BotonExportarPDF color="sky"
          titulo="Poder de Compra — Triangulación Venta / Compra"
          subtitulo={`Vendo ${fmt(venta.cantidad)} cab para comprar ${fmt(calc.cabezasComprables)} cab`}
          secciones={[
            { grupo: "Venta (lo que liquidás)" },
            { label: "Cantidad", value: `${fmt(venta.cantidad)} cab` },
            { label: "Peso promedio", value: `${fmt(venta.pesoPromedio)} kg/cab` },
            { label: "Precio venta", value: `$${fmt(venta.precioKg)}/kg` },
            { label: "Kg totales vendidos", value: `${fmt(venta.cantidad * venta.pesoPromedio)} kg` },
            { label: "Ingreso bruto", value: fmtMoney(calc.ingresoBrutoVenta) },
            { label: "Comisión venta", value: gastos.comisionVentaOn ? `${gastos.comisionVenta}%` : "—" },
            { label: "Flete venta", value: gastos.fleteVentaOn ? `${gastos.kmVenta} km × $${gastos.precioKmVenta}` : "—" },
            { label: "Ingreso neto", value: fmtMoney(calc.ingresoNetoVenta), destacado: true, color: "#0369a1" },

            { grupo: "Compra (lo que adquirís)" },
            { label: "Peso animal", value: `${fmt(compra.pesoAnimal)} kg/cab` },
            { label: "Precio compra", value: `$${fmt(compra.precioKg)}/kg` },
            { label: "Comisión compra", value: gastos.comisionCompraOn ? `${gastos.comisionCompra}%` : "—" },
            { label: "Costo real por cabeza", value: fmtMoney(calc.costoUnitarioBruto) },
            { label: "Flete compra", value: gastos.fleteCompraOn ? `${gastos.kmCompra} km × $${gastos.precioKmCompra}` : "—" },
            { label: "Inversión total compra", value: fmtMoney(calc.costoRealTotal), destacado: true, color: "#0369a1" },

            { grupo: "Resultado" },
            { label: "Terneros comprables", value: `${fmt(calc.cabezasComprables)} cab`, destacado: true, color: "#065f46" },
            { label: "Relación venta/compra", value: `${fmt(calc.relacionVentaCompra, 2)}:1` },
            { label: "Dinero sobrante", value: fmtMoney(calc.sobrante), color: calc.sobrante >= 0 ? "#065f46" : "#dc2626" },
          ]}
        />
        {onAgregarAlCampo && calc.cabezasComprables > 0 && (
          <div className="rounded-2xl border-2 border-sky-200 bg-sky-50 p-4 space-y-3 mb-2">
            <p className="text-xs font-black uppercase tracking-widest text-sky-700">🚀 Ejecutar Movimiento — Agregar compra a Mi Campo</p>
            <p className="text-xs text-sky-600">Incorporar <span className="font-black">{Math.floor(calc.cabezasComprables)} animales</span> de {compra.pesoAnimal} kg — elegí la categoría:</p>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => onAgregarAlCampo({ categoria:"terneros-compra-machos", cantidad: Math.floor(calc.cabezasComprables) })}
                className="bg-sky-600 hover:bg-sky-700 text-white font-black text-xs px-3 py-2.5 rounded-xl transition-all active:scale-95">
                + Recría — machos compra
              </button>
              <button onClick={() => onAgregarAlCampo({ categoria:"terneros-compra-hembras", cantidad: Math.floor(calc.cabezasComprables) })}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs px-3 py-2.5 rounded-xl transition-all active:scale-95">
                + Recría — hembras compra
              </button>
              <button onClick={() => onAgregarAlCampo({ categoria:"novillos-campo", cantidad: Math.floor(calc.cabezasComprables) })}
                className="bg-amber-600 hover:bg-amber-700 text-white font-black text-xs px-3 py-2.5 rounded-xl transition-all active:scale-95">
                + Terminación campo
              </button>
              <button onClick={() => onAgregarAlCampo({ categoria:"vacas", cantidad: Math.floor(calc.cabezasComprables) })}
                className="bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs px-3 py-2.5 rounded-xl transition-all active:scale-95">
                + Cría — vacas
              </button>
            </div>
          </div>
        )}
        <BotonGuardarSim color="sky" onToast={onToast} onGuardar={() => onGuardar({
          tab: "poder",
          nombre: `Triangulación: ${fmt(venta.cantidad)} nov ${fmt(venta.pesoPromedio)}kg → ${fmt(calc.cabezasComprables)} terneros`,
          kpiLabel: "Cabezas",
          kpiValue: fmt(calc.cabezasComprables),
          params: [
            { label: "Cant. vendidos", value: `${fmt(venta.cantidad)} cab` },
            { label: "Peso prom. venta", value: `${fmt(venta.pesoPromedio)} kg` },
            { label: "Precio venta", value: `$${fmt(venta.precioKg)}/kg` },
            { label: "Peso animal compra", value: `${fmt(compra.pesoAnimal)} kg` },
            { label: "Precio compra", value: `$${fmt(compra.precioKg)}/kg` },
            { label: "Flete compra", value: gastos.fleteCompraOn ? `${fmt(gastos.kmCompra)} km × $${fmt(gastos.precioKmCompra)}/km` : "Desactivado" },
            { label: "Flete venta", value: gastos.fleteVentaOn ? `${fmt(gastos.kmVenta)} km × $${fmt(gastos.precioKmVenta)}/km` : "Desactivado" },
            { label: "Com. compra", value: gastos.comisionCompraOn ? `${gastos.comisionCompra}%` : "Desactivado" },
            { label: "Com. venta", value: gastos.comisionVentaOn ? `${gastos.comisionVenta}%` : "Desactivado" },
          ],
          detalle: [
            { label: "Ingreso bruto venta", value: fmtMoney(calc.ingresoBrutoVenta) },
            { label: "Ingreso neto disponible", value: fmtMoney(calc.ingresoNetoVenta) },
            { label: "Costo real / cabeza", value: fmtMoney(calc.costoUnitarioBruto) },
            { label: "Terneros comprables", value: fmt(calc.cabezasComprables) },
            { label: "Relación", value: `${fmt(calc.relacionVentaCompra, 2)}:1` },
            { label: "Sobrante", value: fmtMoney(calc.sobrante) },
          ],
        })} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB 1 — PROYECTO VIENTRES
// ═══════════════════════════════════════════════════════════════════════════
function ProyectoVientres({ onDescarte, onGuardar, onToast, initialInputs, onAgregarAlCampo }) {
  // Lee del store global — reactivo, sincronizado con Dashboard y Comparador
  const globalStore = useGlobal();
  const gastos      = useGastos();
  const { inmagVientres, precioNovilloInmag, inflacionMensual, dolar = 1420, tasaDescuento = 8 } = globalStore;
  const global = globalStore;
  const setGlobal = (p) => vacaStore.getState().setGlobal(p);

  const [tipoCompra, setTipoCompra] = useState("terneras");
  const [inputs, setInputs] = useState(initialInputs || {
    cantidad: 50,
    pesoCompra: 180,
    precioKgCompra: 1800,
    precioBulto: 350000,
    mesesRecriaPreServicio: 15,
    anosVidaUtil: 6,
    kgIatf: 8,
    pctDestete: 85,
    pesoTerneroDestetado: 160,
    precioTerneroKg: 2000,
    pesoVacaDescarte: 380,
    precioDescarteSalidaKg: 1600,
    // MEJORA 5: Costo de Toros en kg (se aplica a terneras y vacas preñadas)
    kgToros: 3,
    // Suplementación Terneras
    mesesSuplTerneras: [],
    costoSuplTernerasMes: 12000,
    // Suplementación Vacas Preñadas
    mesesSuplVacas: [],
    costoSuplVacasMes: 15000,
    // Años de suplementación (de los años de vida útil, cuántos suplementás)
    anosSuplementacion: 6,
    // Creep Feeding terneros
    kreepOn: false,
    kreepMeses: 3,
    kreepCostoMes: 8000,
    kreepKgExtra: 15,
  });
  const set = (k) => (v) => setInputs((p) => ({ ...p, [k]: v }));

  const calc = useMemo(() => {
    const inversionInicial =
      tipoCompra === "terneras"
        ? inputs.cantidad * inputs.pesoCompra * inputs.precioKgCompra
        : inputs.cantidad * inputs.precioBulto;

    const costoRecriaPreServicio = inmagVientres * precioNovilloInmag * inputs.mesesRecriaPreServicio * inputs.cantidad;
    const mesesTotalesVida = inputs.anosVidaUtil * 12;
    const costoPastoreoVida = inmagVientres * precioNovilloInmag * mesesTotalesVida * inputs.cantidad;
    const costoIatfTotal = inputs.kgIatf * precioNovilloInmag * inputs.anosVidaUtil * inputs.cantidad;

    // MEJORA 5: Costo de toros anual (kg × precio INMAG × años × cabezas)
    const costoTorosAnual = inputs.kgToros * precioNovilloInmag * inputs.cantidad;
    const costoTorosTotal = costoTorosAnual * inputs.anosVidaUtil;

    // Suplementación Terneras (se aplica durante el período de recría pre-servicio)
    const mesesSuplTernerasValidos = inputs.mesesSuplTerneras.filter((m) => m <= inputs.mesesRecriaPreServicio);
    const costoSuplTerneras = mesesSuplTernerasValidos.length * inputs.costoSuplTernerasMes * inputs.cantidad;

    // Suplementación Vacas Preñadas — aplica solo en los años seleccionados
    const anosSupl = Math.min(inputs.anosSuplementacion ?? inputs.anosVidaUtil, inputs.anosVidaUtil);
    const costoSuplVacasAnual = inputs.mesesSuplVacas.length * inputs.costoSuplVacasMes * inputs.cantidad;
    const costoSuplVacasTotal = costoSuplVacasAnual * anosSupl;

    // Terneros (necesario antes del creep calc)
    const ternerosAnualesCalc = inputs.cantidad * (inputs.pctDestete / 100);

    // Creep Feeding terneros — costo adicional sobre los terneros que nacen
    const costoKreepAnual = inputs.kreepOn
      ? ternerosAnualesCalc * inputs.kreepMeses * (inputs.kreepCostoMes ?? 8000)
      : 0;
    const costoKreepTotal = costoKreepAnual * inputs.anosVidaUtil;
    // Peso extra por creep (agrega kg al peso de destete en el cálculo de ingreso)
    const pesoTerneroConKreep = inputs.kreepOn
      ? inputs.pesoTerneroDestetado + inputs.kreepKgExtra
      : inputs.pesoTerneroDestetado;

    const costoTotalProyecto = inversionInicial + costoRecriaPreServicio + costoPastoreoVida + costoIatfTotal + costoTorosTotal + costoSuplTerneras + costoSuplVacasTotal + costoKreepTotal;
    const costoRetencionAnual = costoTotalProyecto / inputs.anosVidaUtil;
    const costoTotalPorVientre = costoTotalProyecto / inputs.cantidad;

    const ternerosAnuales = ternerosAnualesCalc;
    const ingresoBrutoAnual = ternerosAnuales * pesoTerneroConKreep * inputs.precioTerneroKg;
    const comisionVentaPctV = gastos.comisionVentaOn ? gastos.comisionVenta / 100 : 0;
    const fleteVentaV = gastos.fleteVentaOn ? gastos.kmVenta * gastos.precioKmVenta : 0;
    const gastoComisionVentaAnual = ingresoBrutoAnual * comisionVentaPctV;
    const ingresoNetoAnual = ingresoBrutoAnual - fleteVentaV - gastoComisionVentaAnual;
    const ingresoNetoVidaUtil = ingresoNetoAnual * inputs.anosVidaUtil;

    const ingresoBrutoDescarte = inputs.cantidad * inputs.pesoVacaDescarte * inputs.precioDescarteSalidaKg;
    const gastoComisionDescarte = ingresoBrutoDescarte * comisionVentaPctV;
    const recuperoDescarte = ingresoBrutoDescarte - fleteVentaV - gastoComisionDescarte;

    const ingresoTotalProyecto = ingresoNetoVidaUtil + recuperoDescarte;
    const margenNeto = ingresoTotalProyecto - costoTotalProyecto;
    const margenPorVientrePorAno = inputs.cantidad > 0 && inputs.anosVidaUtil > 0
      ? margenNeto / inputs.cantidad / inputs.anosVidaUtil : 0;
    const roiPct = costoTotalProyecto > 0 ? (margenNeto / costoTotalProyecto) * 100 : 0;

    const precioCompraRef =
      tipoCompra === "terneras"
        ? inputs.precioKgCompra
        : inputs.pesoCompra > 0 ? inputs.precioBulto / inputs.pesoCompra : 0;

    // ════════════════════════════════════════════════════════════════════════
    // PILAR 3A — Flujos en MONEDA CONSTANTE (sin inflación nominal compuesta)
    // Razón: capitalizar inflación en pesos a 6 años da números irreales.
    // Trabajamos con precios relativos de HOY ($/kg novillo, $/kg ternero).
    // ════════════════════════════════════════════════════════════════════════
    // Flujo año 0: inversión inicial + recría pre-servicio + supl terneras
    const flujo0 = -(inversionInicial + costoRecriaPreServicio + costoSuplTerneras);
    // Flujos años 1..N: ingreso neto − costos operativos del año
    const costoPastoreoAnual = inmagVientres * precioNovilloInmag * 12 * inputs.cantidad;
    const costoIatfAnual     = inputs.kgIatf * precioNovilloInmag * inputs.cantidad;
    const costoTorosAnualFl  = inputs.kgToros * precioNovilloInmag * inputs.cantidad;
    const flujos = [flujo0];
    for (let t = 1; t <= inputs.anosVidaUtil; t++) {
      const suplExtra  = t <= anosSupl ? costoSuplVacasAnual : 0;
      const kreepExtra = inputs.kreepOn ? costoKreepAnual : 0;
      const flujoAnual = ingresoNetoAnual - costoPastoreoAnual - costoIatfAnual - costoTorosAnualFl - kreepExtra - suplExtra;
      flujos.push(t === inputs.anosVidaUtil ? flujoAnual + recuperoDescarte : flujoAnual);
    }

    // ════════════════════════════════════════════════════════════════════════
    // PILAR 3B — VAN (Valor Actual Neto) con tasa de descuento configurable
    // VAN > 0 → el proyecto supera el costo de oportunidad del capital.
    // ════════════════════════════════════════════════════════════════════════
    const r   = tasaDescuento / 100;
    const van = flujos.reduce((acc, f, t) => acc + f / Math.pow(1 + r, t), 0);

    // TIR aproximada por bisección
    let tir = null;
    { let lo = -0.99, hi = 10, mid = 0;
      const vanFn = (rate) => flujos.reduce((a, f, t) => a + f / Math.pow(1 + rate, t), 0);
      if (vanFn(lo) * vanFn(hi) < 0) {
        for (let i = 0; i < 40; i++) { mid = (lo + hi) / 2; if (Math.abs(vanFn(mid)) < 1) break; vanFn(mid)*vanFn(lo) < 0 ? (hi=mid) : (lo=mid); }
        tir = mid * 100;
      }
    }

    // Payback descontado
    let payback = null;
    { let acum = flujos[0];
      for (let t = 1; t <= inputs.anosVidaUtil && payback === null; t++) {
        acum += flujos[t] / Math.pow(1 + r, t);
        if (acum >= 0) payback = t;
      }
    }

    // Conversores a moneda constante
    const toUSD   = p => p / dolar;
    const toKgNov = p => p / precioNovilloInmag;

    // ── Punto de equilibrio del ternero ──────────────────────────────────────
    // Precio $/kg de ternero al que el margen neto = 0 (despejado de la fórmula).
    const kgTerneroVidaUtil = ternerosAnuales * pesoTerneroConKreep * inputs.anosVidaUtil;
    const factorNetoVenta   = 1 - comisionVentaPctV;
    const precioEquilibrioTernero =
      (ternerosAnuales > 0 && pesoTerneroConKreep > 0 && factorNetoVenta > 0 && inputs.anosVidaUtil > 0)
        ? (((costoTotalProyecto - recuperoDescarte) / inputs.anosVidaUtil) + fleteVentaV)
          / (ternerosAnuales * pesoTerneroConKreep * factorNetoVenta)
        : 0;
    // Costo neto por kg de ternero producido (descontado el recupero de descarte)
    const costoPorKgTernero = kgTerneroVidaUtil > 0
      ? (costoTotalProyecto - recuperoDescarte) / kgTerneroVidaUtil : 0;
    // Cuánto puede caer el precio actual antes de empezar a perder
    const margenSeguridadPct = (inputs.precioTerneroKg > 0 && precioEquilibrioTernero > 0)
      ? ((inputs.precioTerneroKg - precioEquilibrioTernero) / inputs.precioTerneroKg) * 100 : 0;

    return {
      inversionInicial, costoRecriaPreServicio, costoPastoreoVida,
      costoIatfTotal, costoTorosAnual, costoTorosTotal,
      costoSuplTerneras, costoSuplVacasAnual, costoSuplVacasTotal,
      costoKreepAnual, costoKreepTotal, pesoTerneroConKreep,
      anosSupl, costoTotalProyecto,
      costoRetencionAnual, costoTotalPorVientre,
      ternerosAnuales, ingresoBrutoAnual, ingresoNetoAnual, ingresoNetoVidaUtil,
      recuperoDescarte, ingresoTotalProyecto, margenNeto, margenPorVientrePorAno,
      roiPct, precioCompraRef,
      // Nuevos: moneda constante + VAN
      flujos, van, tir, payback, toUSD, toKgNov,
      precioEquilibrioTernero, costoPorKgTernero, margenSeguridadPct, kgTerneroVidaUtil,
    };
  }, [inputs, tipoCompra, inmagVientres, precioNovilloInmag, dolar, tasaDescuento, gastos]);

  const margenPositivo = calc.margenNeto >= 0;

  return (
    <div className="space-y-5 section-enter">
      {/* Tipo de compra */}
      <div>
        <SectionTitle icon="🐮" color="text-slate-600">Tipo de Compra</SectionTitle>
        <div className="inline-flex rounded-xl border border-slate-200 p-1 bg-slate-50 gap-1">
          {[{ id: "terneras", label: "Terneras", icon: "🐮" }, { id: "vacas", label: "Vacas Preñadas", icon: "🐄" }].map((t) => (
            <button key={t.id} onClick={() => setTipoCompra(t.id)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all flex items-center gap-2
                ${tipoCompra === t.id ? "bg-white shadow text-emerald-700 border border-emerald-200" : "text-slate-400 hover:text-slate-600"}`}>
              <span>{t.icon}</span> {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Parámetros */}
      <div>
        <SectionTitle icon="📋" color="text-slate-600">Parámetros de Compra y Recría</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          <Field label="Cantidad de cabezas" value={inputs.cantidad} onChange={set("cantidad")} unit="cab" />
          <Field label="Peso de compra" value={inputs.pesoCompra} onChange={set("pesoCompra")} unit="kg"
            sliderMax={tipoCompra === "vacas" ? 600 : 400}
            hint={tipoCompra === "vacas" ? "Ref. para inflación" : ""} />
          {tipoCompra === "terneras"
            ? <Field label="Precio por kg" value={inputs.precioKgCompra} onChange={set("precioKgCompra")} unit="$/kg" step={50} sliderMax={10000} />
            : <Field label="Precio al bulto" value={inputs.precioBulto} onChange={set("precioBulto")} unit="$/cab" step={50000} sliderMax={4000000} hint="Precio fijo sin importar el peso" />
          }
          <Field label="Meses recría pre-servicio" value={inputs.mesesRecriaPreServicio} onChange={set("mesesRecriaPreServicio")} unit="meses"
            minVal={1} hint="Tiempo que come sin producir terneros" />
          <Field label="Años de vida útil" value={inputs.anosVidaUtil} onChange={set("anosVidaUtil")} unit="años" />
          <Field label="Costo IATF" value={inputs.kgIatf} onChange={set("kgIatf")} unit="kg INMAG"
            hint={`≈ ${fmtMoney(inputs.kgIatf * precioNovilloInmag)}/servicio/cab`} highlight />
        </div>
      </div>

      {/* MEJORA 5: Costo de Toros — visible para terneras y vacas preñadas */}
      <div className="rounded-2xl border-2 p-4 space-y-3 shadow-sm card-hover section-violet">
        <div className="flex items-center gap-2">
          <span>🐂</span>
          <p className="text-xs font-black uppercase tracking-widest text-purple-700">Costo de Toros</p>
          <span className="text-xs text-purple-500 normal-case">— costo anual por vientre en kg INMAG</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Costo anual en kg" value={inputs.kgToros} onChange={set("kgToros")} unit="kg toros" step={0.5}
            hint={`≈ ${fmtMoney(inputs.kgToros * precioNovilloInmag)}/cab/año`} />
          <div className="space-y-2">
            <div className="rounded-lg bg-white border border-purple-200 px-3 py-2.5">
              <p className="text-xs text-purple-600 font-semibold uppercase tracking-wider">Costo toros / año</p>
              <p className="font-mono font-bold text-purple-800 text-lg">{fmtMoney(calc.costoTorosAnual)}</p>
              <p className="text-xs text-purple-400">{inputs.kgToros} kg × ${fmt(precioNovilloInmag)}/kg × {inputs.cantidad} cab</p>
            </div>
            <div className="rounded-lg bg-purple-100 border border-purple-300 px-3 py-2.5">
              <p className="text-xs text-purple-700 font-semibold uppercase tracking-wider">Costo toros total ({inputs.anosVidaUtil} años)</p>
              <p className="font-mono font-bold text-purple-900 text-xl">{fmtMoney(calc.costoTorosTotal)}</p>
            </div>
          </div>
        </div>
      </div>

      <Divider />

      {/* Suplementación — Terneras */}
      {tipoCompra === "terneras" && (
        <div className="rounded-2xl border-2 p-5 space-y-4 section-teal">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-teal-500 flex items-center justify-center text-white text-xs font-black shrink-0">🌾</span>
            <div>
              <p className="text-xs font-black uppercase tracking-widest text-teal-700">Suplementación — Terneras</p>
              <p className="text-xs text-teal-500">Marcá los meses en que suplementás durante la recría pre-servicio ({inputs.mesesRecriaPreServicio} meses)</p>
            </div>
          </div>
          <TimelineSuplementacion
            mesesActivos={inputs.mesesSuplTerneras}
            onChange={(next) => set("mesesSuplTerneras")(next)}
            costoMensual={inputs.costoSuplTernerasMes}
            cantidad={inputs.cantidad}
          />
          <Field label="Costo suplemento / mes / cab" value={inputs.costoSuplTernerasMes}
            onChange={set("costoSuplTernerasMes")} unit="$/mes" step={500}
            hint={`Total recría: ${fmtMoney(calc.costoSuplTerneras)}`} />
        </div>
      )}

      {/* Suplementación — Vacas Preñadas */}
      {tipoCompra === "vacas" && (
        <div className="rounded-2xl border-2 p-5 space-y-4 section-teal">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-teal-500 flex items-center justify-center text-white text-xs font-black shrink-0">🌾</span>
            <div>
              <p className="text-xs font-black uppercase tracking-widest text-teal-700">Suplementación — Vacas Preñadas</p>
              <p className="text-xs text-teal-500">Seleccioná los meses de bache forrajero y cuántos años del proyecto suplementás</p>
            </div>
          </div>

          {/* Años de suplementación */}
          <div className="rounded-xl bg-white border border-teal-200 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-black uppercase tracking-widest text-teal-700">¿Cuántos años suplementás?</p>
              <span className="text-xs font-bold bg-teal-100 text-teal-700 px-2 py-0.5 rounded-full border border-teal-300">
                {calc.anosSupl} de {inputs.anosVidaUtil} años
              </span>
            </div>
            <Field label="Años con suplementación" value={inputs.anosSuplementacion}
              onChange={(v) => set("anosSuplementacion")(Math.min(v, inputs.anosVidaUtil))}
              unit="años" sliderMax={inputs.anosVidaUtil} minVal={0}
              hint={`Los ${inputs.anosVidaUtil - calc.anosSupl} año${inputs.anosVidaUtil - calc.anosSupl !== 1 ? "s" : ""} restante${inputs.anosVidaUtil - calc.anosSupl !== 1 ? "s" : ""} no se suplementan (años buenos)`} />
          </div>

          <TimelineSuplementacion
            mesesActivos={inputs.mesesSuplVacas}
            onChange={(next) => set("mesesSuplVacas")(next)}
            costoMensual={inputs.costoSuplVacasMes}
            cantidad={inputs.cantidad}
          />
          <Field label="Costo suplemento / mes / cab" value={inputs.costoSuplVacasMes}
            onChange={set("costoSuplVacasMes")} unit="$/mes" step={500}
            hint={`Anual: ${fmtMoney(calc.costoSuplVacasAnual)} · Total ${calc.anosSupl} años: ${fmtMoney(calc.costoSuplVacasTotal)}`} />
        </div>
      )}

      <Divider />

      {/* Destete y venta de terneros */}
      <div>
        <SectionTitle icon="🐣" color="text-amber-600">Producción Anual — Destete</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          <Field label="% de destete" value={inputs.pctDestete} onChange={set("pctDestete")} unit="%" step={0.5}
            hint={`≈ ${fmt(inputs.cantidad * inputs.pctDestete / 100, 1)} terneros/año`} />
          <Field label="Peso ternero destetado" value={inputs.pesoTerneroDestetado} onChange={set("pesoTerneroDestetado")} unit="kg" />
          <Field label="Precio venta ternero" value={inputs.precioTerneroKg} onChange={set("precioTerneroKg")} unit="$/kg" step={50} />
          <div className="flex flex-col gap-1">
            <p className="text-xs font-semibold tracking-wider uppercase text-slate-500">Ingreso neto anual</p>
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2.5 flex-1 flex items-center">
              <span className="font-mono font-bold text-emerald-700 text-lg">{fmtMoney(calc.ingresoNetoAnual)}</span>
            </div>
            <p className="text-xs text-slate-400 italic">después de gastos de venta</p>
          </div>
        </div>
      </div>

      {/* Creep Feeding */}
      <div className="rounded-2xl border-2 p-5 space-y-4 section-lime">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-lime-500 flex items-center justify-center text-white text-xs font-black shrink-0">🌽</span>
            <div>
              <p className="text-xs font-black uppercase tracking-widest text-lime-700">Creep Feeding — Terneros</p>
              <p className="text-xs text-lime-600">Suplementación a los terneros para aumentar el peso al destete</p>
            </div>
          </div>
          <ToggleSwitch on={inputs.kreepOn} onToggle={() => set("kreepOn")(!inputs.kreepOn)} label={inputs.kreepOn ? "Activo" : "Off"} />
        </div>

        {inputs.kreepOn && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Meses de creep" value={inputs.kreepMeses}
                onChange={set("kreepMeses")} unit="meses" sliderMax={6} minVal={1}
                hint="Meses antes del destete" />
              <Field label="Costo / ternero / mes" value={inputs.kreepCostoMes}
                onChange={set("kreepCostoMes")} unit="$/mes" step={500}
                hint={`Total anual: ${fmtMoney(calc.costoKreepAnual)}`} />
              <Field label="Kg extra al destete" value={inputs.kreepKgExtra}
                onChange={set("kreepKgExtra")} unit="kg" sliderMax={40} minVal={1}
                hint={`Peso con creep: ${fmt(calc.pesoTerneroConKreep)} kg`} highlight />
            </div>

            {/* Resumen creep */}
            <div className="rounded-xl bg-white border border-lime-200 p-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <p className="text-xs text-lime-600 font-semibold uppercase tracking-wider">Terneros / año</p>
                <p className="font-mono font-bold text-lime-800 text-lg">{fmt(calc.ternerosAnuales, 1)} cab</p>
                <p className="text-xs text-lime-400">{inputs.pctDestete}% de {inputs.cantidad} vientres</p>
              </div>
              <div>
                <p className="text-xs text-lime-600 font-semibold uppercase tracking-wider">Costo creep / año</p>
                <p className="font-mono font-bold text-lime-800 text-lg">{fmtMoney(calc.costoKreepAnual)}</p>
                <p className="text-xs text-lime-400">{fmt(calc.ternerosAnuales, 1)} tern × {inputs.kreepMeses} m × ${fmt(inputs.kreepCostoMes)}/m</p>
              </div>
              <div>
                <p className="text-xs text-lime-600 font-semibold uppercase tracking-wider">Costo total ({inputs.anosVidaUtil} años)</p>
                <p className="font-mono font-bold text-lime-900 text-xl">{fmtMoney(calc.costoKreepTotal)}</p>
                <p className="text-xs text-emerald-600 font-semibold">+{fmt(inputs.kreepKgExtra)} kg → +{fmtMoney(calc.ternerosAnuales * inputs.kreepKgExtra * inputs.precioTerneroKg)} ingreso/año</p>
              </div>
            </div>
          </div>
        )}
      </div>

      <Divider />

      {/* Recupero por descarte */}
      <div>
        <SectionTitle icon="🔄" color="text-orange-600">Recupero — Venta de Descarte (Fin Vida Útil)</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          <Field label="Peso vaca al descarte" value={inputs.pesoVacaDescarte} onChange={set("pesoVacaDescarte")} unit="kg" sliderMax={600} />
          <Field label="Precio venta descarte" value={inputs.precioDescarteSalidaKg} onChange={set("precioDescarteSalidaKg")} unit="$/kg" step={50} sliderMax={6000} />
          <div className="flex flex-col gap-1">
            <p className="text-xs font-semibold tracking-wider uppercase text-slate-500">Recupero neto total</p>
            <div className="rounded-lg bg-orange-50 border border-orange-200 px-3 py-2.5 flex-1 flex items-center">
              <span className="font-mono font-bold text-orange-700 text-lg">{fmtMoney(calc.recuperoDescarte)}</span>
            </div>
            <p className="text-xs text-slate-400 italic">al cabo de {inputs.anosVidaUtil} años</p>
          </div>
        </div>
      </div>

      <Divider />

      {/* Costos */}
      <SectionTitle icon="📊" color="text-emerald-600">Desglose de Costos del Proyecto</SectionTitle>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Inversión Inicial" value={fmtMoney(calc.inversionInicial)}
          sub={tipoCompra === "terneras" ? `${inputs.cantidad} cab × ${fmt(inputs.pesoCompra)} kg × $${fmt(inputs.precioKgCompra)}/kg` : `${inputs.cantidad} cab × $${fmt(inputs.precioBulto)}/cab`}
          bg="bg-emerald-50" border="border-emerald-200" color="text-emerald-700" />
        <KpiCard label="Recría Pre-Servicio" value={fmtMoney(calc.costoRecriaPreServicio)}
          sub={`INMAG ${fmt(inmagVientres)} kg × ${inputs.mesesRecriaPreServicio} m × ${inputs.cantidad} cab`} />
        <KpiCard label="Pastoreo Vida Útil" value={fmtMoney(calc.costoPastoreoVida)}
          sub={`INMAG ${fmt(inmagVientres)} kg × ${inputs.anosVidaUtil * 12} m × ${inputs.cantidad} cab`} />
        <KpiCard label="IATF Total" value={fmtMoney(calc.costoIatfTotal)}
          sub={`${inputs.kgIatf} kg × ${inputs.anosVidaUtil} años × ${inputs.cantidad} cab`}
          bg="bg-violet-50" border="border-violet-200" color="text-violet-700" />
      </div>
      {/* MEJORA 5: mostrar costo de toros en el desglose */}
      <div className="rounded-xl border border-purple-200 bg-purple-50 px-4 py-3 flex justify-between items-center">
        <div>
          <p className="text-xs font-black uppercase tracking-widest text-purple-600">🐂 Toros — Costo Total</p>
          <p className="text-xs text-purple-400">{inputs.kgToros} kg × ${fmt(precioNovilloInmag)}/kg × {inputs.anosVidaUtil} años × {inputs.cantidad} cab</p>
        </div>
        <span className="font-mono font-bold text-purple-800 text-xl">{fmtMoney(calc.costoTorosTotal)}</span>

        {/* KPI Suplemento */}
        {tipoCompra === "terneras" && calc.costoSuplTerneras > 0 && (
          <KpiCard label="Suplemento Terneras" value={fmtMoney(calc.costoSuplTerneras)}
            sub={`${inputs.mesesSuplTerneras.length} meses × $${fmt(inputs.costoSuplTernerasMes)}/mes × ${inputs.cantidad} cab`} />
        )}
        {tipoCompra === "vacas" && calc.costoSuplVacasTotal > 0 && (
          <KpiCard label="Suplemento Vacas" value={fmtMoney(calc.costoSuplVacasTotal)}
            sub={`${inputs.mesesSuplVacas.length} m × $${fmt(inputs.costoSuplVacasMes)}/mes × ${inputs.cantidad} cab × ${inputs.anosVidaUtil} años`} />
        )}
      </div>

      {/* Costo total */}
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <p className="text-xs tracking-widest uppercase text-slate-400 mb-1">Costo Total del Proyecto</p>
          <p className="text-2xl font-mono font-bold text-slate-800">{fmtMoney(calc.costoTotalProyecto)}</p>
        </div>
        <div className="border-l border-slate-200 pl-4">
          <p className="text-xs tracking-widest uppercase text-slate-400 mb-1">Costo Retención Anual</p>
          <p className="text-2xl font-mono font-bold text-slate-700">{fmtMoney(calc.costoRetencionAnual)}</p>
          <p className="text-xs text-slate-400 mt-0.5">amortizado</p>
        </div>
        <div className="border-l border-slate-200 pl-4">
          <p className="text-xs tracking-widest uppercase text-slate-400 mb-1">Costo Total / Vientre</p>
          <p className="text-2xl font-mono font-bold text-slate-700">{fmtMoney(calc.costoTotalPorVientre)}</p>
          <p className="text-xs text-slate-400 mt-0.5">en {inputs.anosVidaUtil} años</p>
        </div>
      </div>

      {/* Rentabilidad */}
      <SectionTitle icon="💰" color="text-emerald-600">Rentabilidad del Proyecto de Cría</SectionTitle>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-1.5">
        <p className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">Estado de Resultados (vida útil completa)</p>
        {[
          { label: `Ingreso terneros (${inputs.anosVidaUtil} años)`, value: calc.ingresoNetoVidaUtil, plus: true },
          { label: "Recupero venta descarte", value: calc.recuperoDescarte, plus: true },
          ...(tipoCompra === "terneras" && calc.costoSuplTerneras > 0
            ? [{ label: "Suplemento terneras (recría)", value: -calc.costoSuplTerneras, plus: false }]
            : []),
          ...(tipoCompra === "vacas" && calc.costoSuplVacasTotal > 0
            ? [{ label: `Suplemento vacas (${inputs.anosVidaUtil} años)`, value: -calc.costoSuplVacasTotal, plus: false }]
            : []),
          { label: "Costo total del proyecto", value: -calc.costoTotalProyecto, plus: false },
        ].map((row, i, arr) => (
          <div key={i} className={`flex justify-between text-sm ${i === arr.length - 1 ? "border-t border-slate-200 pt-2" : ""}`}>
            <span className={i === 2 ? "text-slate-600 font-semibold" : "text-slate-500"}>
              {row.plus ? "+" : "−"} {row.label}
            </span>
            <span className={`font-mono font-semibold ${row.value >= 0 ? "text-slate-700" : "text-red-500"}`}>
              {fmtMoney(Math.abs(row.value))}
            </span>
          </div>
        ))}
        <div className={`flex justify-between text-base font-black border-t-2 pt-3 mt-2 rounded-xl px-3 py-3 ${margenPositivo ? "border-emerald-300 bg-gradient-to-r from-emerald-50 to-teal-50" : "border-red-300 bg-gradient-to-r from-red-50 to-rose-50"}`}>
          <span className={margenPositivo ? "text-emerald-700" : "text-red-600"}> = Margen Neto Total</span>
          <span className={`font-mono text-2xl ${margenPositivo ? "text-emerald-600" : "text-red-500"}`}>{fmtMoney(calc.margenNeto)}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard label="Margen / vientre / año" value={fmtMoney(calc.margenPorVientrePorAno)}
          sub="promedio anual por animal"
          color={margenPositivo ? "text-emerald-600" : "text-red-500"}
          bg={margenPositivo ? "bg-emerald-50" : "bg-red-50"}
          border={margenPositivo ? "border-emerald-200" : "border-red-200"} />
        <KpiCard label="ROI del proyecto" value={fmtPct(calc.roiPct, 1)}
          sub={`sobre inversión total de ${fmtMoney(calc.costoTotalProyecto)}`}
          color={calc.roiPct >= 0 ? "text-emerald-600" : "text-red-500"} />
        <KpiCard label="Terneros / año" value={`${fmt(calc.ternerosAnuales, 1)} cab`}
          sub={`${inputs.pctDestete}% de ${inputs.cantidad} vientres`} />
      </div>

      {/* ── Punto de equilibrio ─────────────────────────────────────── */}
      <div className={`rounded-2xl border-2 p-5 ${calc.margenSeguridadPct >= 0 ? "bg-emerald-50 border-emerald-200" : "bg-red-50 border-red-200"}`}>
        <p className="text-xs font-black uppercase tracking-widest text-slate-600 mb-1">⚖️ Punto de equilibrio</p>
        <p className="text-xs text-slate-500 mb-3">El precio del ternero al que el proyecto no gana ni pierde.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <p className="text-xs text-slate-500 font-semibold">Precio de equilibrio</p>
            <p className="font-black text-lg font-mono text-slate-800">${fmt(calc.precioEquilibrioTernero, 0)}/kg</p>
            <p className="text-xs text-slate-400">hoy vendés a ${fmt(inputs.precioTerneroKg, 0)}/kg</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 font-semibold">Costo por kg producido</p>
            <p className="font-black text-lg font-mono text-slate-800">${fmt(calc.costoPorKgTernero, 0)}/kg</p>
            <p className="text-xs text-slate-400">neto de descarte</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 font-semibold">Margen de seguridad</p>
            <p className={`font-black text-lg font-mono ${calc.margenSeguridadPct >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmt(calc.margenSeguridadPct, 1)}%</p>
            <p className="text-xs text-slate-400">{calc.margenSeguridadPct >= 0 ? "puede caer esto antes de perder" : "estás vendiendo bajo el costo"}</p>
          </div>
        </div>
      </div>

      {inflacionMensual > 0 && (
        <InflationIndicator precioCompra={calc.precioCompraRef} precioVenta={inputs.precioTerneroKg}
          inflacionMensual={inflacionMensual} meses={inputs.anosVidaUtil * 12} label="Vientres (vida útil completa)" />
      )}

      {/* ── PILAR 3: VAN + Moneda Constante ────────────────────────── */}
      <div className={`rounded-2xl border-2 p-5 space-y-4 ${calc.van >= 0 ? "bg-emerald-50 border-emerald-300" : "bg-red-50 border-red-300"}`}>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-xs font-black uppercase tracking-widest text-slate-600">
            📊 VAN — Valor Actual Neto (tasa {tasaDescuento}% anual)
          </p>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">Tasa descuento:</span>
            <input type="number" min="0" max="50" step="0.5"
              value={tasaDescuento}
              onChange={e => setGlobal({ tasaDescuento: parseFloat(e.target.value) || 0 })}
              className="w-16 text-center font-mono font-bold text-sm bg-white border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:border-blue-400"/>
            <span className="text-xs text-slate-500">% a.</span>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className={`rounded-xl border-2 p-3 text-center ${calc.van >= 0 ? "bg-emerald-100 border-emerald-300" : "bg-red-100 border-red-300"}`}>
            <p className="text-xs text-slate-500 font-semibold">VAN (pesos)</p>
            <p className={`font-black text-lg ${calc.van >= 0 ? "text-emerald-800" : "text-red-700"}`}>{fmtMoney(calc.van)}</p>
            <p className="text-xs text-slate-400">{calc.van >= 0 ? "✅ Rentable" : "❌ No rentable"}</p>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
            <p className="text-xs text-slate-500 font-semibold">VAN (USD)</p>
            <p className="font-black text-lg text-blue-800">U$S {fmt(Math.round(calc.toUSD(calc.van)))}</p>
            <p className="text-xs text-slate-400">@ ${fmt(dolar)}/USD</p>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
            <p className="text-xs text-slate-500 font-semibold">TIR</p>
            <p className={`font-black text-lg ${calc.tir != null && calc.tir >= tasaDescuento ? "text-emerald-700" : "text-slate-600"}`}>
              {calc.tir != null ? `${calc.tir.toFixed(1)}%` : "n/c"}
            </p>
            <p className="text-xs text-slate-400">tasa interna de retorno</p>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
            <p className="text-xs text-slate-500 font-semibold">Payback</p>
            <p className="font-black text-lg text-slate-700">
              {calc.payback != null ? `${calc.payback} año${calc.payback !== 1 ? "s" : ""}` : `>${inputs.anosVidaUtil}a`}
            </p>
            <p className="text-xs text-slate-400">recupero descontado</p>
          </div>
        </div>
        {/* Flujos anuales en moneda constante */}
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Flujos anuales en moneda constante (USD)</p>
          {calc.flujos.map((f, t) => {
            const usd = calc.toUSD(f);
            const max = Math.max(...calc.flujos.map(x => Math.abs(calc.toUSD(x))));
            const pct = max > 0 ? Math.abs(usd) / max * 100 : 0;
            return (
              <div key={t} className="flex items-center gap-2">
                <span className="text-xs text-slate-400 w-10 shrink-0 font-mono">Año {t}</span>
                <div className="flex-1 h-5 bg-slate-100 rounded-lg overflow-hidden flex items-center">
                  <div className={`h-full rounded-lg ${usd >= 0 ? "bg-emerald-400" : "bg-red-400"}`}
                    style={{width: `${pct}%`, minWidth: 4}} />
                </div>
                <span className={`text-xs font-black w-28 text-right ${usd >= 0 ? "text-emerald-700" : "text-red-600"}`}>
                  {usd >= 0 ? "+" : "−"}U$S {Math.abs(Math.round(usd)).toLocaleString("es-AR")}
                </span>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-slate-400 italic">Los flujos están en moneda constante (sin inflación nominal). Base: precios actuales de novillo INMAG y ternero.</p>
      </div>

      {/* ── Gráficos Vientres ───────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <GraficoCostos
          titulo="Distribución de Costos"
          data={[
            { name: "Inversión inicial",   value: calc.inversionInicial },
            { name: "Recría pre-servicio", value: calc.costoRecriaPreServicio },
            { name: "Pastoreo vida útil",  value: calc.costoPastoreoVida },
            { name: "IATF",                value: calc.costoIatfTotal },
            { name: "Toros",               value: calc.costoTorosTotal },
            { name: "Suplemento",          value: tipoCompra === "terneras" ? calc.costoSuplTerneras : calc.costoSuplVacasTotal },
          ]}
        />
        <GraficoBarras
          titulo="Inversión vs Ingreso"
          data={[
            { name: "Costo",   inversion: calc.costoTotalProyecto },
            { name: "Ingreso", ingreso: calc.ingresoTotalProyecto },
            { name: "Margen",  margen: Math.max(0, calc.margenNeto) },
          ]}
        />
      </div>

            {/* Botón descarte */}
      <div className="pt-1">
        <div className="rounded-2xl border-2 border-dashed border-orange-300 p-5 flex flex-col sm:flex-row items-center justify-between gap-4 section-amber">
          <div>
            <p className="font-bold text-orange-800 text-sm">🔄 Simular descarte a engorde</p>
            <p className="text-xs text-orange-600 mt-0.5">Pasá la vaca de descarte ({fmt(inputs.pesoVacaDescarte)} kg, {inputs.cantidad} cab) al Comparador.</p>
          </div>
          <button onClick={() => onDescarte({ pesoIngreso: inputs.pesoVacaDescarte, cantidad: inputs.cantidad })}
            className="shrink-0 bg-orange-500 hover:bg-orange-600 text-white font-black text-sm px-5 py-3 rounded-xl transition-all shadow-md flex items-center gap-2">
            Pasar descarte a Engorde →
          </button>
        </div>
      </div>

      {/* Plan de pago diferido — sobre la inversión inicial (compra de vientres) */}
      <PlanPago montoTotal={calc.inversionInicial} inflacionMensual={inflacionMensual} color="violet" />

      {/* Asesor IA — Proyecto Vientres */}
      <AsesorIA
        color="emerald"
        titulo="Análisis del proyecto de vientres"
        placeholder="Ej: ¿Es rentable este proyecto? ¿Cuánto tarda en recuperar la inversión? ¿Qué riesgos hay?"
        contexto={[
          `Proyecto Vientres — ${inputs.cantidad} cab | ${inputs.anosVidaUtil} años`,
          `Inversión inicial: ${fmtMoney(calc.inversionInicial)}`,
          `Precio compra: $${inputs.precioCompraKg}/kg | Peso entrada: ${inputs.pesoEntradaKg} kg`,
          `Ingreso total proyectado: ${fmtMoney(calc.ingresoTotalProyecto)}`,
          `Costo total: ${fmtMoney(calc.costoTotalProyecto)}`,
          `Margen neto: ${fmtMoney(calc.margenNeto)}`,
          `TIR estimada: ${calc.tir ? calc.tir.toFixed(1) + "%" : "n/d"}`,
          `ROI: ${calc.roiPct ? calc.roiPct.toFixed(1) + "%" : "n/d"}`,
          `Payback: ${calc.payback ? calc.payback + " años" : "n/d"}`,
          `Margen por vientre/año: ${fmtMoney(calc.margenPorVientrePorAno)}`,
        ].join("\n")}
      />

      {/* Guardar simulación */}
      <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
        <BotonExportarPDF color="violet"
          titulo={`Proyecto Vientres — ${fmt(inputs.cantidad)} cab × ${fmt(inputs.anosVidaUtil)} años`}
          subtitulo={`Inversión de ${fmtMoney(calc.inversionInicial)} · ${tipoCompra === "vacas" ? "Vacas preñadas" : "Terneras"}`}
          secciones={[
            { grupo: "Datos del proyecto" },
            { label: "Cantidad de vientres", value: `${fmt(inputs.cantidad)} cab` },
            { label: "Tipo de compra", value: tipoCompra === "vacas" ? "Vacas preñadas" : "Terneras" },
            { label: "Años de vida útil", value: `${fmt(inputs.anosVidaUtil)} años` },
            { label: "Peso entrada", value: `${fmt(inputs.pesoEntradaKg)} kg` },
            { label: "Precio compra", value: `$${fmt(inputs.precioCompraKg)}/kg` },
            { label: "% Preñez", value: `${fmt(inputs.pctPreniez)}%` },
            { label: "% Destete", value: `${fmt(inputs.pctDestete)}%` },

            { grupo: "Inversión y costos" },
            { label: "Inversión inicial (compra)", value: fmtMoney(calc.inversionInicial), destacado: true, color: "#6d28d9" },
            { label: "Costo recría pre-servicio", value: fmtMoney(calc.costoRecriaPreServicio) },
            { label: "Costo pastoreo (vida útil)", value: fmtMoney(calc.costoPastoreoVida) },
            { label: "Costo IATF total", value: fmtMoney(calc.costoIatfTotal) },
            { label: "Costo toros total", value: fmtMoney(calc.costoTorosTotal) },
            { label: "Costo suplementación", value: fmtMoney(calc.costoSuplVacasTotal + calc.costoSuplTerneras) },
            { label: "Costo total proyecto", value: fmtMoney(calc.costoTotalProyecto), destacado: true, color: "#dc2626" },
            { label: "Costo por vientre", value: fmtMoney(calc.costoTotalPorVientre) },

            { grupo: "Ingresos" },
            { label: "Terneros/año", value: `${fmt(calc.ternerosAnuales)} cab` },
            { label: "Ingreso bruto anual", value: fmtMoney(calc.ingresoBrutoAnual) },
            { label: "Ingreso neto anual", value: fmtMoney(calc.ingresoNetoAnual) },
            { label: "Recupero por descarte", value: fmtMoney(calc.recuperoDescarte) },
            { label: "Ingreso total proyecto", value: fmtMoney(calc.ingresoTotalProyecto), destacado: true, color: "#065f46" },

            { grupo: "Rentabilidad" },
            { label: "Margen neto", value: fmtMoney(calc.margenNeto), destacado: true, color: calc.margenNeto >= 0 ? "#065f46" : "#dc2626" },
            { label: "Margen/vientre/año", value: fmtMoney(calc.margenPorVientrePorAno) },
            { label: "ROI", value: `${fmt(calc.roiPct, 1)}%` },
            { label: "TIR", value: calc.tir ? `${fmt(calc.tir, 1)}%` : "n/d" },
            { label: "VAN", value: fmtMoney(calc.van) },
            { label: "Payback", value: calc.payback ? `${calc.payback} años` : "no recupera" },
          ]}
        />
        {onAgregarAlCampo && (
          <div className="rounded-2xl border-2 border-violet-200 bg-violet-50 p-4 space-y-3 mb-2">
            <p className="text-xs font-black uppercase tracking-widest text-violet-700">🚀 Ejecutar Movimiento — Agregar vientres a Mi Campo</p>
            <p className="text-xs text-violet-600">Incorporar <span className="font-black">{inputs.cantidad} vientres</span> — elegí la categoría:</p>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => onAgregarAlCampo({ categoria:"vacas", cantidad: inputs.cantidad })}
                className="bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs px-3 py-2.5 rounded-xl transition-all active:scale-95">
                + Cría — vacas
              </button>
              <button onClick={() => onAgregarAlCampo({ categoria:"vaquillonas", cantidad: inputs.cantidad })}
                className="bg-teal-600 hover:bg-teal-700 text-white font-black text-xs px-3 py-2.5 rounded-xl transition-all active:scale-95">
                + Cría — vaquillonas
              </button>
            </div>
          </div>
        )}
        <BotonGuardarSim color="violet" onToast={onToast} onGuardar={() => onGuardar({
          tab: "vientres",
          nombre: `Vientres: ${fmt(inputs.cantidad)} vientres × ${fmt(inputs.anosVidaUtil)} años`,
          kpiLabel: "ROI",
          kpiValue: `${fmt(calc.roiPct, 1)}%`,
          params: [
            { label: "Tipo de compra", value: tipoCompra === "terneras" ? "Terneras" : "Vacas Preñadas" },
            { label: "Cantidad vientres", value: `${fmt(inputs.cantidad)} cab` },
            { label: "Peso de compra", value: `${fmt(inputs.pesoCompra)} kg` },
            { label: "Precio compra", value: tipoCompra === "terneras" ? `$${fmt(inputs.precioKgCompra)}/kg` : `$${fmt(inputs.precioBulto)}/cab (bulto)` },
            { label: "Recría pre-servicio", value: `${fmt(inputs.mesesRecriaPreServicio)} meses` },
            { label: "Años vida útil", value: `${fmt(inputs.anosVidaUtil)} años` },
            { label: "IATF", value: `${fmt(inputs.kgIatf)} kg INMAG` },
            { label: "Toros", value: `${fmt(inputs.kgToros)} kg INMAG/año` },
            { label: "% Destete", value: `${fmt(inputs.pctDestete)}%` },
            { label: "Peso ternero destetado", value: `${fmt(inputs.pesoTerneroDestetado)} kg` },
            { label: "Precio ternero", value: `$${fmt(inputs.precioTerneroKg)}/kg` },
            { label: "Peso vaca descarte", value: `${fmt(inputs.pesoVacaDescarte)} kg` },
            { label: "Precio descarte", value: `$${fmt(inputs.precioDescarteSalidaKg)}/kg` },
            { label: "INMAG Vientres", value: `${fmt(inmagVientres)} kg/mes` },
            { label: "Precio novillo INMAG", value: `$${fmt(precioNovilloInmag)}/kg` },
            { label: "Flete venta", value: gastos.fleteVentaOn ? `${fmt(gastos.kmVenta)} km × $${fmt(gastos.precioKmVenta)}/km` : "Desactivado" },
            { label: "Com. venta", value: gastos.comisionVentaOn ? `${gastos.comisionVenta}%` : "Desactivado" },
          ],
          detalle: [
            { label: "Inversión inicial", value: fmtMoney(calc.inversionInicial) },
            { label: "Costo pastoreo total", value: fmtMoney(calc.costoPastoreoVida) },
            { label: "Costo IATF total", value: fmtMoney(calc.costoIatfTotal) },
            { label: "Costo toros total", value: fmtMoney(calc.costoTorosTotal) },
            { label: "Costo suplemento", value: tipoCompra === "terneras" ? fmtMoney(calc.costoSuplTerneras) : fmtMoney(calc.costoSuplVacasTotal) },
            { label: "Costo total proyecto", value: fmtMoney(calc.costoTotalProyecto) },
            { label: "Costo / vientre", value: fmtMoney(calc.costoTotalPorVientre) },
            { label: "Terneros anuales", value: `${fmt(calc.ternerosAnuales, 1)} cab/año` },
            { label: "Ingreso neto vida útil", value: fmtMoney(calc.ingresoNetoVidaUtil) },
            { label: "Recupero descarte", value: fmtMoney(calc.recuperoDescarte) },
            { label: "Ingreso total proyecto", value: fmtMoney(calc.ingresoTotalProyecto) },
            { label: "Margen neto", value: fmtMoney(calc.margenNeto) },
            { label: "Margen/vientre/año", value: fmtMoney(calc.margenPorVientrePorAno) },
            { label: "ROI", value: `${fmt(calc.roiPct, 1)}%` },
          ],
        })} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB 2 — COMPARADOR INVERNADA VS FEEDLOT
// ═══════════════════════════════════════════════════════════════════════════
const MESES_NOMBRES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];

function TimelineSuplementacion({ mesesActivos, onChange, costoMensual, cantidad }) {
  const toggle = (idx) => {
    const next = mesesActivos.includes(idx)
      ? mesesActivos.filter((m) => m !== idx)
      : [...mesesActivos, idx];
    onChange(next);
  };
  const costoTotal = mesesActivos.length * costoMensual * cantidad;
  return (
    <div className="bg-teal-50 border border-teal-200 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs font-black uppercase tracking-widest text-teal-700">🌾 Suplementación Estratégica — Marcá los meses de bache</p>
        <span className="text-xs font-bold bg-teal-100 text-teal-700 px-2 py-0.5 rounded-full border border-teal-300">{mesesActivos.length} / 12 meses</span>
      </div>
      <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
        {MESES_NOMBRES.map((nombre, i) => {
          const idx = i + 1;
          const isOn = mesesActivos.includes(idx);
          return (
            <button key={idx} onClick={() => toggle(idx)}
              className={`h-12 rounded-xl text-xs font-black border-2 transition-all select-none touch-manipulation active:scale-95 flex flex-col items-center justify-center gap-0.5
                ${isOn ? "bg-emerald-500 border-emerald-600 text-white shadow-md shadow-emerald-200" : "bg-white border-slate-200 text-slate-400 hover:border-slate-300 hover:text-slate-500"}`}>
              <span>{nombre}</span>
              {isOn && <span className="text-emerald-200 leading-none" style={{fontSize:"8px"}}>✓</span>}
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded-lg bg-white border border-teal-200 px-3 py-2 text-center">
          <p className="text-xs text-teal-600 font-semibold uppercase tracking-wider">Meses activos</p>
          <p className="font-mono font-bold text-teal-800 text-xl">{mesesActivos.length}</p>
          <p className="text-xs text-teal-400">{mesesActivos.sort((a,b)=>a-b).map(m=>MESES_NOMBRES[m-1]).join(", ") || "Ninguno"}</p>
        </div>
        <div className={`rounded-lg border px-3 py-2 text-center ${costoTotal > 0 ? "bg-teal-100 border-teal-300" : "bg-white border-slate-200"}`}>
          <p className="text-xs text-teal-700 font-semibold uppercase tracking-wider">Costo total suplemento</p>
          <p className="font-mono font-bold text-teal-800 text-xl">{fmtMoney(costoTotal)}</p>
          <p className="text-xs text-teal-500">{mesesActivos.length} m × ${fmt(costoMensual)} × {cantidad} cab</p>
        </div>
      </div>
    </div>
  );
}

function ComparadorInvernada({ descarteData, onGuardar, onToast, initialBase, onAgregarAlCampo }) {
  const global    = useGlobal();  // precios sincronizados con Dashboard y Vientres
  const gastos    = useGastos();
  const setGastosStore = vacaStore.getState().setGastos;
  const setGastos = setGastosStore;
  const { inmagInvernada, precioNovilloInmag, inflacionMensual } = global;

  const [base, setBase] = useState(initialBase || {
    cantidad: descarteData?.cantidad ?? 100,
    pesoIngreso: descarteData?.pesoIngreso ?? 200,
    precioCompraKg: 1800,
  });
  const [opA, setOpA] = useState({
    gpvDiaria: 0.6,
    mesesRecria: 8,
    precioVentaKg: 2100,
    mesesSuplementActivos: [],
    costoSuplementoMensual: 15000,
  });
  const [opBPesoOverride, setOpBPesoOverride] = useState(null);
  const [opB, setOpB] = useState({
    gpvDiaria: 1.2,
    diasEncierre: 90,
    costoRacionDiaria: 3000,
    costoHoteleriadiaria: 500,
    precioVentaKg: 2250,
  });

  const setB = (k) => (v) => setBase((p) => ({ ...p, [k]: v }));
  const setA = (k) => (v) => setOpA((p) => ({ ...p, [k]: v }));
  const setO = (k) => (v) => setOpB((p) => ({ ...p, [k]: v }));

  // MEJORA 2: GPV with decimal fix
  const setAGpv = (v) => setOpA((p) => ({ ...p, gpvDiaria: Math.round(v * 10) / 10 }));
  const setOGpv = (v) => setOpB((p) => ({ ...p, gpvDiaria: Math.round(v * 10) / 10 }));

  useEffect(() => {
    if (descarteData) {
      setBase((p) => ({ ...p, cantidad: descarteData.cantidad, pesoIngreso: descarteData.pesoIngreso }));
      setOpBPesoOverride(null);
    }
  }, [descarteData]);

  const calc = useMemo(() => {
    const inversionBruta = base.cantidad * base.pesoIngreso * base.precioCompraKg;
    const comisionCompraPctC = gastos.comisionCompraOn ? gastos.comisionCompra / 100 : 0;
    const fleteCompraC = gastos.fleteCompraOn ? gastos.kmCompra * gastos.precioKmCompra : 0;
    const gastoComisionCompra = inversionBruta * comisionCompraPctC;
    const inversionBase = inversionBruta + fleteCompraC + gastoComisionCompra;
    const gastosCompra = fleteCompraC + gastoComisionCompra;

    const diasPasto = opA.mesesRecria * 30;
    // MEJORA 2: decimal fix en GPV
    const gpvA = Math.round(opA.gpvDiaria * 10) / 10;
    const gpvTotalA = gpvA * diasPasto;
    const pesoSalidaA = base.pesoIngreso + gpvTotalA;
    const costoPastoreoA = inmagInvernada * precioNovilloInmag * opA.mesesRecria * base.cantidad;
    const costoKgPastoCalc = gpvTotalA * base.cantidad > 0 ? costoPastoreoA / (gpvTotalA * base.cantidad) : 0;
    const mesesSuplValidos = opA.mesesSuplementActivos.filter((m) => m <= opA.mesesRecria);
    const costoSuplementacionA = mesesSuplValidos.length * opA.costoSuplementoMensual * base.cantidad;
    const costoOperativoA = costoPastoreoA + costoSuplementacionA;
    const ingresoBrutoA = base.cantidad * pesoSalidaA * opA.precioVentaKg;
    const comisionVentaPctC = gastos.comisionVentaOn ? gastos.comisionVenta / 100 : 0;
    const fleteVentaC = gastos.fleteVentaOn ? gastos.kmVenta * gastos.precioKmVenta : 0;
    const gastoComisionVentaA = ingresoBrutoA * comisionVentaPctC;
    const gastosVentaA = fleteVentaC + gastoComisionVentaA;
    const ingresoNetoA = ingresoBrutoA - gastosVentaA;
    const margenA = ingresoNetoA - inversionBase - costoOperativoA;
    const margenPorCabA = margenA / base.cantidad;

    const pesoIngresoB = opBPesoOverride !== null ? opBPesoOverride : pesoSalidaA;
    // MEJORA 2: decimal fix en GPV feedlot
    const gpvB = Math.round(opB.gpvDiaria * 10) / 10;
    const gpvTotalB = gpvB * opB.diasEncierre;
    const pesoSalidaB = pesoIngresoB + gpvTotalB;
    const costoTotalDiario = opB.costoRacionDiaria + opB.costoHoteleriadiaria;
    const costoRacionPorAnimal = opB.costoRacionDiaria * opB.diasEncierre;
    const costoHoteleriaPorAnimal = opB.costoHoteleriadiaria * opB.diasEncierre;
    const costoOperativoB = costoTotalDiario * opB.diasEncierre * base.cantidad;
    const ingresoBrutoB = base.cantidad * pesoSalidaB * opB.precioVentaKg;
    const gastoComisionVentaB = ingresoBrutoB * comisionVentaPctC;
    const gastosVentaB = fleteVentaC + gastoComisionVentaB;
    const ingresoNetoB = ingresoBrutoB - gastosVentaB;
    const inversionB = ingresoNetoA;
    const margenB = ingresoNetoB - inversionB - costoOperativoB;
    const margenPorCabB = margenB / base.cantidad;
    const costoKgGanadoB = gpvB > 0 ? opB.costoRacionDiaria / gpvB : 0;
    const margenPorKgB = opB.precioVentaKg - costoKgGanadoB;
    const ganadorA = margenA >= margenB;

    // ── MEJORA 4: Relación Compra-Venta — indicador clave de invernada
    // RC/V = precio venta gordo / precio compra ternero
    // Umbral: >1.6 excelente, >1.3 bueno, <1.0 peligroso
    const relacionCV_A = base.precioCompraKg > 0 ? opA.precioVentaKg / base.precioCompraKg : 0;
    const relacionCV_B = base.precioCompraKg > 0 ? opB.precioVentaKg / base.precioCompraKg : 0;

    return {
      inversionBruta, inversionBase, gastosCompra,
      relacionCV_A, relacionCV_B,
      a: { gpvTotal: gpvTotalA, pesoSalida: pesoSalidaA, costoKgPasto: costoKgPastoCalc,
           costoPastoreo: costoPastoreoA, mesesSuplActivos: mesesSuplValidos.length,
           costoSuplementacion: costoSuplementacionA, costoOperativo: costoOperativoA,
           ingresoBruto: ingresoBrutoA, gastosVenta: gastosVentaA, ingresoNeto: ingresoNetoA,
           margen: margenA, margenPorCab: margenPorCabA },
      b: { pesoIngreso: pesoIngresoB, gpvTotal: gpvTotalB, pesoSalida: pesoSalidaB,
           costoRacionPorAnimal, costoHoteleriaPorAnimal, costoOperativo: costoOperativoB,
           inversionB, ingresoBruto: ingresoBrutoB, gastosVenta: gastosVentaB, ingresoNeto: ingresoNetoB,
           margen: margenB, margenPorCab: margenPorCabB, costoKgGanado: costoKgGanadoB, margenPorKg: margenPorKgB,
           margenProduccion: (opB.precioVentaKg - costoKgGanadoB) * gpvTotalB * base.cantidad,
           margenDiferencial: (opB.precioVentaKg - base.precioCompraKg) * pesoIngresoB * base.cantidad,
           precioIndiferencia: pesoSalidaB > 0 ? (inversionB + costoOperativoB + gastosVentaB) / (base.cantidad * pesoSalidaB) : 0,
      },
      ganadorA,
    };
  }, [base, gastos, opA, opB, opBPesoOverride, inmagInvernada, precioNovilloInmag]);

  const mesesFeedlot = opB.diasEncierre / 30;

  return (
    <div className="space-y-5">
      <SectionTitle icon="📋" color="text-slate-600">Datos de Compra — Base Común</SectionTitle>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
        <Field label="Cantidad de terneros" value={base.cantidad} onChange={setB("cantidad")} unit="cab" />
        <Field label="Peso de ingreso" value={base.pesoIngreso} onChange={setB("pesoIngreso")} unit="kg" sliderMax={400} />
        <Field label="Precio de compra" value={base.precioCompraKg} onChange={setB("precioCompraKg")} unit="$/kg" step={50} sliderMax={10000} />
      </div>

      <GastosComerciales gastos={gastos} setGastos={setGastos} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-lg bg-slate-100 border border-slate-200 px-4 py-2.5">
          <p className="text-xs text-slate-500 uppercase tracking-widest font-semibold">Inversión bruta</p>
          <p className="font-mono font-bold text-slate-700 text-lg">{fmtMoney(calc.inversionBruta)}</p>
        </div>
        <div className="rounded-lg bg-slate-100 border border-slate-200 px-4 py-2.5">
          <p className="text-xs text-slate-500 uppercase tracking-widest font-semibold">Gastos de compra</p>
          <p className="font-mono font-bold text-red-500 text-lg">{fmtMoney(calc.gastosCompra)}</p>
          <p className="text-xs text-slate-400">flete + comisión</p>
        </div>
        <div className="rounded-lg bg-slate-800 border border-slate-700 px-4 py-2.5">
          <p className="text-xs text-slate-400 uppercase tracking-widest font-semibold">Inversión real total</p>
          <p className="font-mono font-bold text-white text-lg">{fmtMoney(calc.inversionBase)}</p>
        </div>
      </div>

      {descarteData && (
        <div className="flex items-center gap-2 rounded-lg bg-orange-50 border border-orange-200 px-4 py-2.5">
          <span className="text-orange-500">🔄</span>
          <span className="text-xs text-orange-700 font-semibold">Datos cargados desde Descarte — podés editarlos libremente</span>
        </div>
      )}

      <Divider />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* OPCIÓN A — INVERNADA */}
        <div className="space-y-4">
          <SectionTitle icon="🌿" color="text-green-700">Opción A — Invernada a Campo</SectionTitle>
          <div className="bg-green-600 rounded-xl p-4 text-white">
            <p className="text-xs font-black uppercase tracking-widest text-green-200 mb-2">⏱ Tiempo de recría</p>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <input type="number" min={1} max={36} value={opA.mesesRecria}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '' || v === '0') return; // don't commit empty/zero yet
                    const n = Math.max(1, Math.min(36, Number(v)));
                    setA("mesesRecria")(n);
                  }}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (!v || v < 1) setA("mesesRecria")(1);
                  }}
                  onFocus={(e) => e.target.select()}
                  className="w-full rounded-lg border-2 border-green-400 bg-green-700 text-white font-mono font-black text-3xl px-4 py-2 text-center
                    [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none focus:outline-none focus:ring-2 focus:ring-white/50" />
              </div>
              <div className="text-right">
                <p className="text-green-200 text-sm font-semibold">meses</p>
                <p className="text-white font-mono font-bold text-xl">{fmt(opA.mesesRecria * 30)} días</p>
              </div>
            </div>
          </div>

          <div className="bg-green-50 border border-green-100 rounded-xl p-4 space-y-3">
            <p className="text-xs font-black uppercase tracking-widest text-green-700">Ganancia de Peso Vivo</p>
            {/* MEJORA 2: paso 0.1 con step explícito */}
            <Field label="GPV diaria a pasto" value={opA.gpvDiaria} onChange={setAGpv} unit="kg/día" step={0.1} />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="bg-white rounded-lg border border-green-200 px-3 py-2">
                <p className="text-xs text-green-600 font-semibold uppercase tracking-wider">Kg ganados</p>
                <p className="font-mono font-bold text-green-800">{fmtKg(calc.a.gpvTotal)}</p>
              </div>
              <div className="bg-emerald-100 rounded-lg border border-emerald-300 px-3 py-2 col-span-2">
                <p className="text-xs text-emerald-700 font-semibold uppercase tracking-wider">Peso de salida</p>
                <p className="font-mono font-bold text-emerald-800 text-lg">{fmtKg(calc.a.pesoSalida)}</p>
              </div>
            </div>
          </div>

          <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 space-y-2">
            <p className="text-xs font-black uppercase tracking-widest text-amber-700">🌾 Costo Pastoreo (INMAG Invernada)</p>
            <p className="text-xs text-amber-600">
              {fmt(inmagInvernada)} kg/mes × ${fmt(precioNovilloInmag)}/kg × {opA.mesesRecria} m × {base.cantidad} cab
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="bg-white rounded-lg border border-amber-200 px-3 py-2">
                <p className="text-xs text-amber-600 font-semibold uppercase tracking-wider">Costo pastoreo total</p>
                <p className="font-mono font-bold text-amber-800">{fmtMoney(calc.a.costoPastoreo)}</p>
              </div>
              <div className="bg-amber-100 rounded-lg border border-amber-300 px-3 py-2">
                <p className="text-xs text-amber-700 font-semibold uppercase tracking-wider">Costo / kg producido</p>
                <p className="font-mono font-bold text-amber-800 text-xl">{fmtMoney(calc.a.costoKgPasto, 0)}<span className="text-sm font-normal">/kg</span></p>
              </div>
            </div>
          </div>

          <TimelineSuplementacion
            mesesRecria={opA.mesesRecria}
            mesesActivos={opA.mesesSuplementActivos}
            onChange={(next) => setA("mesesSuplementActivos")(next)}
            costoMensual={opA.costoSuplementoMensual}
            cantidad={base.cantidad}
          />
          <Field label="Costo suplemento / mes / cab" value={opA.costoSuplementoMensual}
            onChange={setA("costoSuplementoMensual")} unit="$/mes" step={500} />

          <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 flex justify-between items-center">
            <span className="text-xs font-black uppercase tracking-widest text-green-700">Costo Operativo Total A</span>
            <span className="font-mono font-bold text-green-800 text-xl">{fmtMoney(calc.a.costoOperativo)}</span>
          </div>
          <Field label="Precio de venta estimado" value={opA.precioVentaKg} onChange={setA("precioVentaKg")} unit="$/kg" step={50} sliderMax={10000} />

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-1.5">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-500">Ingreso Neto Invernada</p>
            <div className="flex justify-between text-xs text-slate-500"><span>Ingreso bruto</span><span className="font-mono">{fmtMoney(calc.a.ingresoBruto)}</span></div>
            <div className="flex justify-between text-xs text-red-400"><span>− Gastos de venta</span><span className="font-mono">−{fmtMoney(calc.a.gastosVenta)}</span></div>
            <div className="flex justify-between text-sm font-bold border-t border-slate-200 pt-1.5 text-slate-800">
              <span>= Ingreso neto</span><span className="font-mono text-emerald-700">{fmtMoney(calc.a.ingresoNeto)}</span>
            </div>
          </div>

          {inflacionMensual > 0 && (
            <InflationIndicator precioCompra={base.precioCompraKg} precioVenta={opA.precioVentaKg}
              inflacionMensual={inflacionMensual} meses={opA.mesesRecria} label="Invernada" />
          )}
        </div>

        {/* OPCIÓN B — FEEDLOT */}
        <div className="space-y-4">
          <SectionTitle icon="🏭" color="text-blue-700">Opción B — Feedlot (continúa desde Invernada)</SectionTitle>
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-3">
            <p className="text-xs font-black uppercase tracking-widest text-blue-700 mb-1">📌 Costo de Oportunidad</p>
            <p className="text-xs text-blue-600 leading-relaxed">
              No hay nueva compra. El costo de oportunidad es el <strong>ingreso neto de Invernada</strong> ({fmtMoney(calc.a.ingresoNeto)}) resignado al seguir engordando.
            </p>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-black uppercase tracking-widest text-blue-700">Peso de Ingreso al Corral</p>
              {opBPesoOverride === null
                ? <span className="text-xs bg-blue-100 text-blue-600 font-bold px-2 py-0.5 rounded-full border border-blue-200">⟵ Auto (salida invernada)</span>
                : <button onClick={() => setOpBPesoOverride(null)} className="text-xs bg-orange-100 text-orange-600 font-bold px-2 py-0.5 rounded-full border border-orange-200 hover:bg-orange-200 transition-all">Restablecer automático</button>
              }
            </div>
            <div className="relative">
              <input type="number" min={0} value={calc.b.pesoIngreso}
                onChange={(e) => setOpBPesoOverride(Number(e.target.value))}
                className="w-full rounded-lg border-2 border-blue-300 bg-white text-blue-800 font-mono font-black text-2xl px-4 py-2.5 text-center
                  [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none focus:outline-none focus:ring-2 focus:ring-blue-400/50" />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-blue-400 font-mono">kg</span>
            </div>
            <p className="text-xs text-blue-500">Salida invernada: {fmtKg(calc.a.pesoSalida)} — editá para sobreescribir</p>
          </div>

          <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 space-y-3">
            <p className="text-xs font-black uppercase tracking-widest text-blue-700">Ganancia de Peso Vivo</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* MEJORA 2: GPV feedlot con paso 0.1 */}
              <Field label="GPV diaria en corral" value={opB.gpvDiaria} onChange={setOGpv} unit="kg/día" step={0.1} sliderMax={3} />
              <Field label="Días de encierre" value={opB.diasEncierre} onChange={setO("diasEncierre")} unit="días" sliderMax={150} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="bg-white rounded-lg border border-blue-200 px-3 py-2">
                <p className="text-xs text-blue-600 font-semibold uppercase tracking-wider">Kg ganados</p>
                <p className="font-mono font-bold text-blue-800">{fmtKg(calc.b.gpvTotal)}</p>
              </div>
              <div className="bg-blue-100 rounded-lg border border-blue-200 px-3 py-2">
                <p className="text-xs text-blue-700 font-semibold uppercase tracking-wider">Peso de salida</p>
                <p className="font-mono font-bold text-blue-800 text-lg">{fmtKg(calc.b.pesoSalida)}</p>
              </div>
            </div>
          </div>

          <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 space-y-3">
            <p className="text-xs font-black uppercase tracking-widest text-indigo-700">💡 Costos Operativos del Corral</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Costo ración / animal / día" value={opB.costoRacionDiaria} onChange={setO("costoRacionDiaria")} unit="$/día" step={100} highlight />
              <Field label="Costo hotelería / animal / día" value={opB.costoHoteleriadiaria} onChange={setO("costoHoteleriadiaria")} unit="$/día" step={100} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="bg-white rounded-lg border border-indigo-200 px-3 py-2.5">
                <p className="text-xs text-indigo-500 font-semibold uppercase tracking-wider leading-tight mb-1">Ración total<br/>/ animal</p>
                <p className="font-mono font-bold text-indigo-700">{fmtMoney(calc.b.costoRacionPorAnimal)}</p>
              </div>
              <div className="bg-white rounded-lg border border-indigo-200 px-3 py-2.5">
                <p className="text-xs text-indigo-500 font-semibold uppercase tracking-wider leading-tight mb-1">Hotelería total<br/>/ animal</p>
                <p className="font-mono font-bold text-indigo-700">{fmtMoney(calc.b.costoHoteleriaPorAnimal)}</p>
              </div>
              <div className="bg-indigo-100 rounded-lg border border-indigo-300 px-3 py-2.5">
                <p className="text-xs text-indigo-600 font-semibold uppercase tracking-wider leading-tight mb-1">Costo op.<br/>total lote</p>
                <p className="font-mono font-bold text-indigo-800">{fmtMoney(calc.b.costoOperativo)}</p>
              </div>
            </div>
            <div className="border-t border-indigo-200 pt-3">
              <p className="text-xs font-bold text-indigo-600 uppercase tracking-wider mb-1">Margen por Kg Ganado</p>
              <p className="text-xs text-indigo-500 mb-2">Precio venta − (Ración/día ÷ GPV/día)</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="bg-white rounded-lg border border-indigo-200 px-3 py-2.5">
                  <p className="text-xs text-indigo-500 font-semibold uppercase tracking-wider leading-tight mb-1">Costo/kg<br/>ganado</p>
                  <p className="font-mono font-bold text-indigo-700">{fmtMoney(calc.b.costoKgGanado, 0)}</p>
                </div>
                <div className="bg-white rounded-lg border border-indigo-200 px-3 py-2.5">
                  <p className="text-xs text-indigo-500 font-semibold uppercase tracking-wider leading-tight mb-1">Precio<br/>venta/kg</p>
                  <p className="font-mono font-bold text-indigo-700">{fmtMoney(opB.precioVentaKg, 0)}</p>
                </div>
                <div className={`rounded-lg border px-3 py-2.5 ${calc.b.margenPorKg >= 0 ? "bg-emerald-100 border-emerald-300" : "bg-red-100 border-red-300"}`}>
                  <p className="text-xs font-semibold uppercase tracking-wider leading-tight mb-1 text-slate-500">Ganancia<br/>por kg</p>
                  <p className={`font-mono font-bold text-xl ${calc.b.margenPorKg >= 0 ? "text-emerald-700" : "text-red-600"}`}>{fmtMoney(calc.b.margenPorKg, 0)}</p>
                </div>
              </div>
            </div>
          </div>

          <Field label="Precio de venta gordo" value={opB.precioVentaKg} onChange={setO("precioVentaKg")} unit="$/kg" step={50} sliderMax={10000} />

          <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 space-y-3">
            <p className="text-xs font-black uppercase tracking-widest text-indigo-700">📐 Desglose Financiero del Encierre</p>
            <div className="bg-white rounded-lg border border-indigo-200 p-3 space-y-1">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-black flex items-center justify-center">1</span>
                <p className="text-xs font-bold text-slate-600 uppercase tracking-wider">Margen de Producción</p>
              </div>
              <p className="text-xs text-slate-400">(Precio venta − Costo kg producido) × kg ganados totales</p>
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-500">({fmtMoney(opB.precioVentaKg, 0)} − {fmtMoney(calc.b.costoKgGanado, 0)}) × {fmtKg(calc.b.gpvTotal * base.cantidad)}</span>
                <span className={`font-mono font-bold text-lg ${calc.b.margenProduccion >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtMoney(calc.b.margenProduccion)}</span>
              </div>
            </div>
            <div className="bg-white rounded-lg border border-indigo-200 p-3 space-y-1">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-xs font-black flex items-center justify-center">2</span>
                <p className="text-xs font-bold text-slate-600 uppercase tracking-wider">Margen Diferencial de Precio</p>
              </div>
              <p className="text-xs text-slate-400">(Precio venta − Precio compra) × peso de entrada</p>
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-500">({fmtMoney(opB.precioVentaKg, 0)} − {fmtMoney(base.precioCompraKg, 0)}) × {fmtKg(calc.b.pesoIngreso * base.cantidad)}</span>
                <span className={`font-mono font-bold text-lg ${calc.b.margenDiferencial >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtMoney(calc.b.margenDiferencial)}</span>
              </div>
            </div>
            <div className="bg-white rounded-lg border border-indigo-200 p-3 space-y-1">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="w-5 h-5 rounded-full bg-red-100 text-red-700 text-xs font-black flex items-center justify-center">3</span>
                <p className="text-xs font-bold text-slate-600 uppercase tracking-wider">Gastos del Encierre</p>
              </div>
              {[
                { label: "Costo operativo (ración + hotelería)", value: -calc.b.costoOperativo },
                { label: "Gastos de venta (flete + comisión)",  value: -calc.b.gastosVenta   },
              ].map((r, i) => (
                <div key={i} className="flex justify-between text-xs text-slate-500">
                  <span>{r.label}</span><span className="font-mono text-red-500">{fmtMoney(r.value)}</span>
                </div>
              ))}
            </div>
            <div className={`rounded-lg border-2 p-3 ${calc.b.margen >= 0 ? "bg-emerald-50 border-emerald-300" : "bg-red-50 border-red-300"}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className={`w-5 h-5 rounded-full text-xs font-black flex items-center justify-center ${calc.b.margen >= 0 ? "bg-emerald-200 text-emerald-800" : "bg-red-200 text-red-800"}`}>Σ</span>
                  <p className={`text-xs font-black uppercase tracking-wider ${calc.b.margen >= 0 ? "text-emerald-700" : "text-red-700"}`}>Margen Neto Total</p>
                </div>
                <span className={`font-mono font-black text-2xl ${calc.b.margen >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtMoney(calc.b.margen)}</span>
              </div>
              <p className={`text-xs mt-1 ${calc.b.margen >= 0 ? "text-emerald-500" : "text-red-400"}`}>{fmtMoney(calc.b.margenPorCab)} por cabeza</p>
            </div>
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 flex items-center justify-between">
              <div>
                <p className="text-xs font-black uppercase tracking-widest text-amber-700">⚖️ Precio de Indiferencia</p>
                <p className="text-xs text-amber-600">Precio mínimo de venta para no perder dinero</p>
              </div>
              <div className="text-right">
                <p className="font-mono font-black text-2xl text-amber-800">{fmtMoney(calc.b.precioIndiferencia, 0)}/kg</p>
                <p className={`text-xs font-semibold ${opB.precioVentaKg >= calc.b.precioIndiferencia ? "text-emerald-600" : "text-red-500"}`}>
                  {opB.precioVentaKg >= calc.b.precioIndiferencia ? `▲ Margen de ${fmtMoney(opB.precioVentaKg - calc.b.precioIndiferencia, 0)}/kg` : `▼ Falta ${fmtMoney(calc.b.precioIndiferencia - opB.precioVentaKg, 0)}/kg`}
                </p>
              </div>
            </div>
          </div>

          {inflacionMensual > 0 && (
            <InflationIndicator precioCompra={base.precioCompraKg} precioVenta={opB.precioVentaKg}
              inflacionMensual={inflacionMensual} meses={mesesFeedlot} label="Feedlot" />
          )}
        </div>
      </div>

      <Divider />

      {/* ── MEJORA 4: Relación Compra-Venta ─────────────────────────────── */}
      {(() => {
        const rcvA = calc.relacionCV_A;
        const rcvB = calc.relacionCV_B;
        const colorRCV = (r) => r >= 1.6 ? "text-emerald-600" : r >= 1.3 ? "text-amber-600" : "text-red-500";
        const badgeRCV = (r) => r >= 1.6 ? "bg-emerald-100 border-emerald-300 text-emerald-700" : r >= 1.3 ? "bg-amber-100 border-amber-300 text-amber-700" : "bg-red-100 border-red-300 text-red-600";
        const labelRCV = (r) => r >= 1.6 ? "Excelente" : r >= 1.3 ? "Favorable" : r >= 1.0 ? "Ajustada" : "Desfavorable";
        return (
          <div className="rounded-2xl border-2 border-teal-200 bg-teal-50 p-5 space-y-3">
            <div className="flex items-center gap-2">
              <span className="w-7 h-7 rounded-lg bg-teal-500 flex items-center justify-center text-white text-xs font-black shrink-0">📐</span>
              <div>
                <p className="text-xs font-black uppercase tracking-widest text-teal-700">Relación Compra-Venta — Indicador Clave de Invernada</p>
                <p className="text-xs text-teal-500">Precio venta gordo ÷ Precio compra ternero · &gt;1.6 excelente · &gt;1.3 bueno · &lt;1.0 peligroso</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-white rounded-xl border border-green-200 p-4 text-center">
                <p className="text-xs font-black uppercase tracking-widest text-green-700 mb-1">🌿 Invernada (A)</p>
                <p className="text-xs text-slate-400 mb-2">${fmt(opA.precioVentaKg)}/kg ÷ ${fmt(base.precioCompraKg)}/kg</p>
                <p className={`font-mono font-black text-4xl ${colorRCV(rcvA)}`}>{fmt(rcvA, 2)}</p>
                <span className={`mt-1 inline-block text-xs font-bold px-2.5 py-1 rounded-full border ${badgeRCV(rcvA)}`}>{labelRCV(rcvA)}</span>
              </div>
              <div className="bg-white rounded-xl border border-blue-200 p-4 text-center">
                <p className="text-xs font-black uppercase tracking-widest text-blue-700 mb-1">🏭 Feedlot (B)</p>
                <p className="text-xs text-slate-400 mb-2">${fmt(opB.precioVentaKg)}/kg ÷ ${fmt(base.precioCompraKg)}/kg</p>
                <p className={`font-mono font-black text-4xl ${colorRCV(rcvB)}`}>{fmt(rcvB, 2)}</p>
                <span className={`mt-1 inline-block text-xs font-bold px-2.5 py-1 rounded-full border ${badgeRCV(rcvB)}`}>{labelRCV(rcvB)}</span>
              </div>
            </div>
            <p className="text-xs text-teal-500 italic">⚠️ Una relación menor a 1.0 implica que el novillo gordo vale menos kg que el ternero comprado — negocio inviable.</p>
          </div>
        );
      })()}

      <Divider />

      {/* TABLA COMPARATIVA */}
      <SectionTitle icon="⚖️" color="text-slate-600">Comparación de Resultados</SectionTitle>
      <div className="table-scroll rounded-2xl border border-slate-200 shadow-sm">
        <div className="grid grid-cols-3 bg-slate-50 border-b border-slate-200">
          <div className="px-4 py-3 text-xs font-bold uppercase tracking-widest text-slate-400">Métrica</div>
          <div className={`px-4 py-3 border-l border-slate-200 ${calc.ganadorA ? "bg-green-50" : ""}`}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-black uppercase tracking-wider text-green-700">🌿 Invernada</span>
              {calc.ganadorA && <span className="bg-emerald-500 text-white text-xs font-black px-2 py-0.5 rounded-full">✓ MEJOR</span>}
            </div>
          </div>
          <div className={`px-4 py-3 border-l border-slate-200 ${!calc.ganadorA ? "bg-blue-50" : ""}`}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-black uppercase tracking-wider text-blue-700">🏭 Feedlot</span>
              {!calc.ganadorA && <span className="bg-emerald-500 text-white text-xs font-black px-2 py-0.5 rounded-full">✓ MEJOR</span>}
            </div>
          </div>
        </div>
        {[
          { label: "Inversión / costo de oportunidad", a: fmtMoney(calc.inversionBase), b: fmtMoney(calc.b.inversionB) },
          { label: "Peso de ingreso", a: fmtKg(base.pesoIngreso), b: fmtKg(calc.b.pesoIngreso) },
          { label: "GPV total / animal", a: fmtKg(calc.a.gpvTotal), b: fmtKg(calc.b.gpvTotal) },
          { label: "Peso de salida", a: fmtKg(calc.a.pesoSalida), b: fmtKg(calc.b.pesoSalida) },
          { label: "Costo operativo total", a: fmtMoney(calc.a.costoOperativo), b: fmtMoney(calc.b.costoOperativo) },
          { label: "Gastos de venta", a: fmtMoney(calc.a.gastosVenta), b: fmtMoney(calc.b.gastosVenta) },
          { label: "Ingreso neto de venta", a: fmtMoney(calc.a.ingresoNeto), b: fmtMoney(calc.b.ingresoNeto) },
        ].map((row, i) => (
          <div key={i} className={`grid grid-cols-3 border-b border-slate-100 ${i % 2 === 0 ? "bg-white" : "bg-slate-50/40"}`}>
            <div className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center">{row.label}</div>
            <div className={`px-4 py-3 border-l border-slate-100 font-mono text-sm text-slate-700 ${calc.ganadorA ? "bg-green-50/40" : ""}`}>{row.a}</div>
            <div className={`px-4 py-3 border-l border-slate-100 font-mono text-sm text-slate-700 ${!calc.ganadorA ? "bg-blue-50/40" : ""}`}>{row.b}</div>
          </div>
        ))}
        <div className="grid grid-cols-3 border-t-2 border-slate-300">
          <div className="px-4 py-5 bg-slate-100 flex flex-col justify-center">
            <span className="text-xs font-black uppercase tracking-widest text-slate-600">Margen Neto Total</span>
            <span className="text-xs text-slate-400 mt-0.5">después de todos los costos</span>
          </div>
          {[
            { margen: calc.a.margen, pCab: calc.a.margenPorCab, win: calc.ganadorA },
            { margen: calc.b.margen, pCab: calc.b.margenPorCab, win: !calc.ganadorA },
          ].map(({ margen, pCab, win }, i) => (
            <div key={i} className={`px-4 py-5 border-l border-slate-300 ${win ? "bg-emerald-50" : "bg-white"}`}>
              <p className={`font-mono font-black text-3xl tabular-nums ${win ? "text-emerald-600" : margen < 0 ? "text-red-500" : "text-slate-700"}`}>{fmtMoney(margen)}</p>
              <p className={`text-xs font-mono mt-1 ${win ? "text-emerald-500" : "text-slate-400"}`}>{fmtMoney(pCab)} por cabeza</p>
            </div>
          ))}
        </div>
      </div>

      {/* Winner banner */}
      {(() => {
        const empate = calc.a.margen === calc.b.margen;
        const diff = Math.abs(calc.a.margen - calc.b.margen);
        const diffCab = Math.abs(calc.a.margenPorCab - calc.b.margenPorCab);
        const ganadorNombre = calc.ganadorA ? "Invernada a Campo" : "Terminación en Feedlot";
        const perdedorNombre = calc.ganadorA ? "Feedlot" : "Invernada";

        // Build a brief "why" explanation
        let why = "";
        if (!empate) {
          const ganCosto = calc.ganadorA ? calc.a.costoOperativo : calc.b.costoOperativo;
          const perCosto = calc.ganadorA ? calc.b.costoOperativo : calc.a.costoOperativo;
          const ganIngreso = calc.ganadorA ? calc.a.ingresoNeto : calc.b.ingresoNeto;
          const perIngreso = calc.ganadorA ? calc.b.ingresoNeto : calc.a.ingresoNeto;
          const razones = [];
          if (ganIngreso > perIngreso) razones.push(`mayor ingreso neto (${fmtMoney(ganIngreso)} vs ${fmtMoney(perIngreso)})`);
          if (ganCosto < perCosto) razones.push(`menor costo operativo (${fmtMoney(ganCosto)} vs ${fmtMoney(perCosto)})`);
          if (razones.length === 0) razones.push(`mejor combinación de precio de venta y costos`);
          why = razones.join(" y ");
        }

        return (
          <div className={`rounded-2xl border-2 px-5 py-5 flex items-start gap-4 shadow-lg card-hover ${empate ? "border-slate-300 bg-gradient-to-r from-slate-50 to-white" : calc.ganadorA ? "border-emerald-300 bg-gradient-to-r from-emerald-50 to-teal-50 glow-green" : "border-blue-300 bg-gradient-to-r from-blue-50 to-indigo-50"}`}>
            <span className="text-3xl shrink-0 mt-0.5">{empate ? "⚖️" : "🏆"}</span>
            <div>
              <p className="font-bold text-slate-800">
                {empate
                  ? "Ambas opciones arrojan el mismo resultado"
                  : `${ganadorNombre} es la opción más rentable`}
              </p>
              {!empate && (
                <>
                  <p className="text-sm text-slate-500 mt-0.5">
                    Diferencia de <span className="font-mono font-bold text-emerald-700">{fmtMoney(diff)}</span> en el margen total &nbsp;·&nbsp; <span className="font-mono font-bold text-emerald-700">{fmtMoney(diffCab)}</span> por cabeza
                  </p>
                  <p className="text-xs text-slate-500 mt-1.5 border-t border-slate-200/60 pt-1.5">
                    <span className="font-semibold">¿Por qué?</span> {ganadorNombre} genera {why}. El {perdedorNombre} queda {calc.ganadorA ? calc.b.margen < 0 ? "en pérdida" : "por debajo" : calc.a.margen < 0 ? "en pérdida" : "por debajo"} con un margen de <span className="font-mono font-semibold">{fmtMoney(calc.ganadorA ? calc.b.margen : calc.a.margen)}</span>.
                  </p>
                </>
              )}
            </div>
          </div>
        );
      })()}
      {/* ── Gráficos Comparador ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <GraficoCostos
          titulo="Distribución Costos Invernada"
          data={[
            { name: "Inversión base",    value: calc.inversionBase },
            { name: "Pastoreo (A)",      value: calc.a.costoPastoreo },
            { name: "Suplemento (A)",    value: calc.a.costoSuplementacion },
            { name: "Gastos venta (A)",  value: calc.a.gastosVenta },
          ]}
        />
        <GraficoBarras
          titulo="Invernada vs Feedlot"
          data={[
            { name: "Invernada", ingreso: Math.max(0, calc.a.margen), inversion: Math.max(0, -calc.a.margen) },
            { name: "Feedlot",   ingreso: Math.max(0, calc.b.margen), inversion: Math.max(0, -calc.b.margen) },
          ]}
        />
      </div>

      {/* Plan de pago diferido — sobre la inversión de compra */}
      <PlanPago montoTotal={calc.inversionBase} inflacionMensual={inflacionMensual} color="emerald" />

      {/* Asesor IA — Comparador Invernada */}
      <AsesorIA
        color="violet"
        titulo="Análisis del comparador de invernada"
        placeholder="Ej: ¿Qué opción conviene? ¿Cuál es el riesgo de cada escenario? ¿A qué precio se empatan?"
        contexto={calc ? [
          `Comparador Invernada — ${base.cantidad} cab`,
          `Compra: ${base.pesoIngreso} kg/cab a $${base.precioCompraKg}/kg`,
          `Inversión base: ${fmtMoney(calc.inversionBase)}`,
          `Opción A (pasto): Margen ${fmtMoney(calc.a.margen)} | Venta $${opA.precioVentaKg}/kg | ${opA.mesesRecria} meses`,
          `Opción B (feedlot): Margen ${fmtMoney(calc.b.margen)} | Venta $${opB.precioVentaKg}/kg | ${opB.diasEncierre} días`,
          `Ganador: ${calc.ganadorA ? "Opción A — pasto" : "Opción B — feedlot"}`,
          `Relación compra/venta A: ${calc.relacionCV_A.toFixed(2)} | B: ${calc.relacionCV_B.toFixed(2)}`,
          `Inflación: ${inflacionMensual}%/mes`,
        ].join("\n") : "Sin datos"}
      />


      {/* Guardar simulación */}
      <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
        <BotonExportarPDF color="emerald"
          titulo={`Comparador Invernada — ${fmt(base.cantidad)} cab`}
          subtitulo={`Pasto vs Feedlot · Ganador: ${calc.ganadorA ? "Invernada a Campo" : "Terminación en Feedlot"}`}
          secciones={[
            { grupo: "Compra inicial" },
            { label: "Cantidad", value: `${fmt(base.cantidad)} cab` },
            { label: "Peso ingreso", value: `${fmt(base.pesoIngreso)} kg` },
            { label: "Precio compra", value: `$${fmt(base.precioCompraKg)}/kg` },
            { label: "Inversión base", value: fmtMoney(calc.inversionBase), destacado: true, color: "#065f46" },

            { grupo: "Opción A — Invernada a campo (pasto)" },
            { label: "Meses recría", value: `${fmt(opA.mesesRecria)} meses` },
            { label: "GPV total", value: `${fmt(calc.a.gpvTotal, 0)} kg` },
            { label: "Peso salida", value: `${fmt(calc.a.pesoSalida, 0)} kg` },
            { label: "Precio venta", value: `$${fmt(opA.precioVentaKg)}/kg` },
            { label: "Costo pastoreo", value: fmtMoney(calc.a.costoPastoreo) },
            { label: "Costo suplementación", value: fmtMoney(calc.a.costoSuplementacion) },
            { label: "Ingreso neto", value: fmtMoney(calc.a.ingresoNeto) },
            { label: "Margen A", value: fmtMoney(calc.a.margen), destacado: true, color: calc.ganadorA ? "#065f46" : "#64748b" },
            { label: "Margen/cabeza A", value: fmtMoney(calc.a.margenPorCab) },

            { grupo: "Opción B — Terminación en feedlot" },
            { label: "Días encierre", value: `${fmt(opB.diasEncierre)} días` },
            { label: "GPV total", value: `${fmt(calc.b.gpvTotal, 0)} kg` },
            { label: "Peso salida", value: `${fmt(calc.b.pesoSalida, 0)} kg` },
            { label: "Precio venta", value: `$${fmt(opB.precioVentaKg)}/kg` },
            { label: "Costo ración/animal", value: fmtMoney(calc.b.costoRacionPorAnimal) },
            { label: "Costo hotelería/animal", value: fmtMoney(calc.b.costoHoteleriaPorAnimal) },
            { label: "Costo kg ganado", value: `$${fmt(calc.b.costoKgGanado, 0)}/kg` },
            { label: "Ingreso neto", value: fmtMoney(calc.b.ingresoNeto) },
            { label: "Margen B", value: fmtMoney(calc.b.margen), destacado: true, color: !calc.ganadorA ? "#065f46" : "#64748b" },
            { label: "Margen/cabeza B", value: fmtMoney(calc.b.margenPorCab) },

            { grupo: "Veredicto" },
            { label: "Ganador", value: calc.ganadorA ? "Invernada a Campo" : "Terminación en Feedlot", destacado: true, color: "#065f46" },
            { label: "Diferencia de margen", value: fmtMoney(Math.abs(calc.a.margen - calc.b.margen)) },
            { label: "Inflación aplicada", value: `${inflacionMensual}%/mes` },
          ]}
        />
        {onAgregarAlCampo && (
          <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-4 space-y-3 mb-2">
            <p className="text-xs font-black uppercase tracking-widest text-emerald-700">🚀 Ejecutar Movimiento — Agregar novillos a Mi Campo</p>
            <p className="text-xs text-emerald-600">Incorporar <span className="font-black">{base.cantidad} novillos</span> — elegí dónde:</p>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => onAgregarAlCampo({ categoria:"novillos-campo", cantidad: base.cantidad })}
                className="bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs px-3 py-2.5 rounded-xl transition-all active:scale-95">
                + Terminación campo
              </button>
              <button onClick={() => onAgregarAlCampo({ categoria:"novillos-feedlot", cantidad: base.cantidad })}
                className="bg-purple-600 hover:bg-purple-700 text-white font-black text-xs px-3 py-2.5 rounded-xl transition-all active:scale-95">
                + Terminación feedlot
              </button>
            </div>
          </div>
        )}
        <BotonGuardarSim color="emerald" onToast={onToast} onGuardar={() => {
          const winner = calc.ganadorA ? "Invernada" : "Feedlot";
          onGuardar({
            tab: "invernada",
            nombre: `Comparador: ${fmt(base.cantidad)} cab ${fmt(base.pesoIngreso)}kg → ${winner} gana`,
            kpiLabel: "Ganador",
            kpiValue: winner,
            params: [
              { label: "Cantidad", value: `${fmt(base.cantidad)} cab` },
              { label: "Peso ingreso", value: `${fmt(base.pesoIngreso)} kg` },
              { label: "Precio compra", value: `$${fmt(base.precioCompraKg)}/kg` },
              { label: "GPV pasto (A)", value: `${fmt(opA.gpvDiaria, 1)} kg/día` },
              { label: "Meses recría (A)", value: `${fmt(opA.mesesRecria)} meses` },
              { label: "Precio venta (A)", value: `$${fmt(opA.precioVentaKg)}/kg` },
              { label: "Supl. pasto (A)", value: `${opA.mesesSuplementActivos.length} meses × $${fmt(opA.costoSuplementoMensual)}/mes` },
              { label: "GPV feedlot (B)", value: `${fmt(opB.gpvDiaria, 1)} kg/día` },
              { label: "Días encierre (B)", value: `${fmt(opB.diasEncierre)} días` },
              { label: "Costo ración (B)", value: `$${fmt(opB.costoRacionDiaria)}/día` },
              { label: "Hotelería (B)", value: `$${fmt(opB.costoHoteleriadiaria)}/día` },
              { label: "Precio venta (B)", value: `$${fmt(opB.precioVentaKg)}/kg` },
              { label: "INMAG Invernada", value: `${fmt(inmagInvernada)} kg/mes` },
              { label: "Precio novillo INMAG", value: `$${fmt(precioNovilloInmag)}/kg` },
              { label: "Flete compra", value: gastos.fleteCompraOn ? `${fmt(gastos.kmCompra)} km × $${fmt(gastos.precioKmCompra)}/km` : "Desactivado" },
              { label: "Flete venta", value: gastos.fleteVentaOn ? `${fmt(gastos.kmVenta)} km × $${fmt(gastos.precioKmVenta)}/km` : "Desactivado" },
              { label: "Com. compra", value: gastos.comisionCompraOn ? `${gastos.comisionCompra}%` : "Desactivado" },
              { label: "Com. venta", value: gastos.comisionVentaOn ? `${gastos.comisionVenta}%` : "Desactivado" },
            ],
            detalle: [
              { label: "Inversión real total", value: fmtMoney(calc.inversionBase) },
              { label: "Peso salida (A)", value: `${fmt(calc.a.pesoSalida)} kg` },
              { label: "Costo operativo (A)", value: fmtMoney(calc.a.costoOperativo) },
              { label: "Ingreso neto (A)", value: fmtMoney(calc.a.ingresoNeto) },
              { label: "Margen (A)", value: fmtMoney(calc.a.margen) },
              { label: "Margen/cab (A)", value: fmtMoney(calc.a.margenPorCab) },
              { label: "Peso salida (B)", value: `${fmt(calc.b.pesoSalida)} kg` },
              { label: "Costo operativo (B)", value: fmtMoney(calc.b.costoOperativo) },
              { label: "Ingreso neto (B)", value: fmtMoney(calc.b.ingresoNeto) },
              { label: "Margen (B)", value: fmtMoney(calc.b.margen) },
              { label: "Margen/cab (B)", value: fmtMoney(calc.b.margenPorCab) },
              { label: "Diferencia", value: fmtMoney(Math.abs(calc.a.margen - calc.b.margen)) },
            ],
          });
        }} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL PANEL
// ═══════════════════════════════════════════════════════════════════════════
function GInput({ label, value, onChange, unit, borderColor = "border-emerald-300", textColor = "text-emerald-800", step = 1 }) {
  const labelColor = textColor.replace("-800", "-700");
  const numVal = Number(value) || 0;
  const [inputStr, setInputStr] = useState(null);

  // MEJORA 3: Long-press for GInput too
  const incFn = useCallback(() => onChange(Math.round((numVal + step) * 10) / 10), [numVal, step, onChange]);
  const decFn = useCallback(() => onChange(Math.max(0, Math.round((numVal - step) * 10) / 10)), [numVal, step, onChange]);
  const incPress = useLongPress(incFn);
  const decPress = useLongPress(decFn);

  const handleGInputChange = (e) => {
    const raw = e.target.value;
    setInputStr(raw);
    if (raw === '' || raw === '-') return;
    let v = Math.max(0, Number(raw));
    if (step < 1) v = Math.round(v * 10) / 10;
    onChange(v);
  };

  const handleGInputBlur = () => {
    if (inputStr === '' || inputStr === null) onChange(0);
    setInputStr(null);
  };

  return (
    <div className="flex flex-col gap-1">
      <label className={`text-xs font-semibold tracking-wider uppercase ${labelColor}`}>{label}</label>
      <div className={`flex items-stretch rounded-xl border-2 ${borderColor} overflow-hidden`} style={{minHeight:"48px"}}>
        <button {...decPress}
          className={`w-11 shrink-0 bg-white/60 hover:bg-white active:bg-white/40 ${textColor} font-black text-xl flex items-center justify-center transition-all touch-manipulation select-none`}
          style={{minWidth:"2.75rem"}}>−</button>
        <div className="flex-1 flex flex-col items-center justify-center min-w-0">
          <input type="number" min={0} step={step}
            value={inputStr !== null ? inputStr : value}
            onChange={handleGInputChange}
            onBlur={handleGInputBlur}
            onFocus={(e) => { setInputStr(String(value)); e.target.select(); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
            className={`w-full bg-transparent text-center text-sm font-mono font-bold ${textColor} py-1
              [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none focus:outline-none`} />
          <span className={`text-xs font-mono ${labelColor} opacity-60 leading-none pb-1`}>{unit}</span>
        </div>
        <button {...incPress}
          className={`w-11 shrink-0 bg-white/60 hover:bg-white active:bg-white/40 ${textColor} font-black text-xl flex items-center justify-center transition-all touch-manipulation select-none border-l-2 ${borderColor}`}
          style={{minWidth:"2.75rem"}}>+</button>
      </div>
    </div>
  );
}

function GlobalPanel({ global: _global, setGlobal: _sg, gastos: _gastos, setGastos: _sgs }) {
  // Lee directamente del store — cambios aquí se propagan a todos los simuladores
  const global    = useGlobal();
  const gastos    = useGastos();
  const setGlobal = (p) => vacaStore.getState().setGlobal(p);
  const setGastos = (p) => vacaStore.getState().setGastos(p);
  const set = (k) => (v) => setGlobal((p) => ({ ...p, [k]: v }));
  const [open, setOpen] = useState(false);

  // MEJORA 1: Fijar / Guardar state
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await new Promise((r) => setTimeout(r, 600)); // simulated delay
      // Para persistir: integrá tu backend/API acá con fetch()
    } catch(e) { console.warn("Save error:", e); }
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const chips = [
    { label: `INMAG V ${global.inmagVientres} kg`, color: "bg-violet-100 text-violet-700 border-violet-300 shadow-violet-100" },
    { label: `INMAG I ${global.inmagInvernada} kg`, color: "bg-emerald-100 text-emerald-700 border-emerald-300 shadow-emerald-100" },
    { label: `Novillo $${fmt(global.precioNovilloInmag)}/kg`, color: "bg-sky-100 text-sky-700 border-sky-300 shadow-sky-100" },
    { label: `Inflación ${global.inflacionMensual}%/m`, color: "bg-orange-100 text-orange-700 border-orange-300 shadow-orange-100" },
    { label: `USD $${fmt(global.dolar || 1420)}`, color: "bg-blue-100 text-blue-700 border-blue-300 shadow-blue-100" },
  ];

  return (
    <div className="rounded-2xl border-2 border-emerald-200 shadow-md mb-6" style={{background:"linear-gradient(135deg,#ecfdf5,#f0fdff,#f5f3ff)"}}>
      <button onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left">
        <div className="flex items-center gap-3">
          <span className="w-7 h-7 rounded-lg bg-emerald-500 flex items-center justify-center text-white text-xs font-black shrink-0">⚙</span>
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-emerald-700">Configuración Global · Gastos Comerciales</p>
            <p className="text-xs text-emerald-600">INMAG · Precio novillo · Inflación · Fletes · Comisiones</p>
          </div>
        </div>
        <span className={`text-emerald-500 font-black text-lg transition-transform duration-200 ${open ? "rotate-180" : ""}`}>⌄</span>
      </button>

      {!open && (
        <div className="flex flex-wrap gap-2 px-5 pb-4">
          {chips.map((c) => (
            <span key={c.label} className={`text-xs px-2.5 py-1 rounded-full font-semibold border ${c.color}`}>{c.label}</span>
          ))}
          {gastos.fleteCompraOn && (
            <span className="text-xs px-2.5 py-1 rounded-full font-semibold border bg-red-50 text-red-600 border-red-200">
              Flete C {fmtMoney(gastos.kmCompra * gastos.precioKmCompra)}
            </span>
          )}
          {gastos.comisionCompraOn && (
            <span className="text-xs px-2.5 py-1 rounded-full font-semibold border bg-red-50 text-red-600 border-red-200">
              Com. C {gastos.comisionCompra}%
            </span>
          )}
          {gastos.fleteVentaOn && (
            <span className="text-xs px-2.5 py-1 rounded-full font-semibold border bg-red-50 text-red-600 border-red-200">
              Flete V {fmtMoney(gastos.kmVenta * gastos.precioKmVenta)}
            </span>
          )}
          {gastos.comisionVentaOn && (
            <span className="text-xs px-2.5 py-1 rounded-full font-semibold border bg-red-50 text-red-600 border-red-200">
              Com. V {gastos.comisionVenta}%
            </span>
          )}
        </div>
      )}

      {open && (
        <div className="px-5 pb-5 space-y-5 border-t border-emerald-200/60 pt-4">
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-emerald-700 mb-3">📐 Variables INMAG e Inflación</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-white/80 rounded-xl border border-violet-200 p-3 space-y-2">
                <div className="flex items-center gap-1.5">
                  <span>🐄</span>
                  <span className="text-xs font-black uppercase tracking-widest text-violet-700">INMAG Vientres</span>
                </div>
                <GInput label="kg / mes / animal" value={global.inmagVientres} onChange={set("inmagVientres")} unit="kg/mes" borderColor="border-violet-300" textColor="text-violet-800" />
                <div className="bg-violet-50 rounded-lg px-3 py-1.5">
                  <p className="text-xs text-violet-500">Costo / mes / cab</p>
                  <p className="font-mono font-bold text-violet-700">{fmtMoney(global.inmagVientres * global.precioNovilloInmag)}</p>
                </div>
                <p className="text-xs text-violet-400 italic">Solo aplica en Proyecto Vientres</p>
              </div>
              <div className="bg-white/80 rounded-xl border border-green-200 p-3 space-y-2">
                <div className="flex items-center gap-1.5">
                  <span>🌿</span>
                  <span className="text-xs font-black uppercase tracking-widest text-green-700">INMAG Invernada</span>
                </div>
                <GInput label="kg / mes / animal" value={global.inmagInvernada} onChange={set("inmagInvernada")} unit="kg/mes" borderColor="border-green-300" textColor="text-green-800" />
                <div className="bg-green-50 rounded-lg px-3 py-1.5">
                  <p className="text-xs text-green-500">Costo / mes / cab</p>
                  <p className="font-mono font-bold text-green-700">{fmtMoney(global.inmagInvernada * global.precioNovilloInmag)}</p>
                </div>
                <p className="text-xs text-green-400 italic">Solo aplica en Comparador</p>
              </div>
              <div className="bg-white/80 rounded-xl border border-emerald-200 p-3 space-y-2">
                <div className="flex items-center gap-1.5">
                  <span>💲</span>
                  <span className="text-xs font-black uppercase tracking-widest text-emerald-700">Precio Novillo INMAG</span>
                </div>
                <GInput label="Precio de referencia" value={global.precioNovilloInmag} onChange={set("precioNovilloInmag")} unit="$/kg" step={50} />
              </div>
              <div className="bg-white/80 rounded-xl border border-orange-200 p-3 space-y-2">
                <div className="flex items-center gap-1.5">
                  <span>📈</span>
                  <span className="text-xs font-black uppercase tracking-widest text-orange-700">Inflación mensual</span>
                </div>
                <GInput label="Estimación mensual" value={global.inflacionMensual} onChange={set("inflacionMensual")} unit="%" borderColor="border-orange-200" textColor="text-orange-700" step={0.1} />
                <GInput label="Dólar ($/USD)" value={global.dolar || 1420} onChange={set("dolar")} unit="$/USD" borderColor="border-blue-200" textColor="text-blue-700" step={10} />
              </div>
            </div>
          </div>
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-slate-600 mb-3">🧾 Gastos Comerciales</p>
            <GastosComerciales gastos={gastos} setGastos={setGastos} />
          </div>

          {/* MEJORA 1: Botón Fijar */}
          <div className="flex items-center justify-between border-t border-emerald-200 pt-4">
            <div>
              <p className="text-xs font-black uppercase tracking-widest text-emerald-700">💾 Guardar configuración</p>
              <p className="text-xs text-emerald-500 mt-0.5">Presioná "Fijar" para guardar la configuración actual</p>
            </div>
            <SaveButton onSave={handleSave} saving={saving} saved={saved} />
          </div>
        </div>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// HISTORIAL DE SIMULACIONES
// ═══════════════════════════════════════════════════════════════════════════
const TAB_COLORS = {
  poder:     { bg: "bg-sky-50",    border: "border-sky-200",    badge: "bg-sky-500",    text: "text-sky-700",    icon: "⇄" },
  vientres:  { bg: "bg-violet-50", border: "border-violet-200", badge: "bg-violet-500", text: "text-violet-700", icon: "🐄" },
  invernada: { bg: "bg-emerald-50",border: "border-emerald-200",badge: "bg-emerald-600",text: "text-emerald-700",icon: "⚖️" },
};

function SimulacionesPanel({ simulaciones, onBorrar, onBorrarTodas }) {
  const [expandida, setExpandida] = useState(null);
  const [seccion, setSeccion] = useState({}); // { [id]: "resultados" | "params" }

  const getSec = (id) => seccion[id] || "resultados";
  const setSec = (id, v) => setSeccion((p) => ({ ...p, [id]: v }));

  if (simulaciones.length === 0) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white p-8 text-center mt-6">
        <p className="text-3xl mb-2">📋</p>
        <p className="font-black text-slate-400 text-sm uppercase tracking-widest">Sin simulaciones guardadas</p>
        <p className="text-xs text-slate-300 mt-1">Usá el botón "Guardar simulación" en cada módulo para registrar tus escenarios.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border-2 border-slate-100 bg-white shadow-xl mt-6 overflow-hidden card-hover">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b-2 border-slate-100" style={{background:"linear-gradient(135deg,#f8fafc,#f0fdf4)"}}>
        <div className="flex items-center gap-3">
          <span className="w-7 h-7 rounded-lg bg-slate-700 flex items-center justify-center text-white text-xs font-black shrink-0">📋</span>
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-slate-700">Simulaciones Guardadas</p>
            <p className="text-xs text-slate-400">{simulaciones.length} registro{simulaciones.length !== 1 ? "s" : ""}</p>
          </div>
        </div>
        <button onClick={onBorrarTodas}
          className="text-xs font-bold text-red-400 hover:text-red-600 border border-red-200 hover:border-red-400 px-3 py-1.5 rounded-lg transition-all">
          🗑 Borrar todas
        </button>
      </div>

      {/* List */}
      <div className="divide-y divide-slate-100">
        {simulaciones.map((sim) => {
          const c = TAB_COLORS[sim.tab] || TAB_COLORS.poder;
          const isOpen = expandida === sim.id;
          const activeTab = getSec(sim.id);
          const hasParams = sim.params && sim.params.length > 0;
          return (
            <div key={sim.id} className={`${c.bg} transition-all`}>
              {/* Row header */}
              <div className="flex items-center gap-3 px-4 py-3">
                {/* Category badge */}
                <div className="flex flex-col items-center gap-0.5 shrink-0">
                  <span className={`w-7 h-7 rounded-lg ${c.badge} text-white text-sm flex items-center justify-center`}>
                    {c.icon}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-xs font-black px-2 py-0.5 rounded-full border ${c.badge} text-white`}>
                      {sim.categoriaLabel || sim.tab}
                    </span>
                    <p className={`font-black text-sm ${c.text} truncate`}>{sim.nombre}</p>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">{sim.fecha}</p>
                </div>
                {/* KPI pill */}
                <span className={`shrink-0 text-xs font-black px-2.5 py-1 rounded-full ${c.badge} text-white`}>
                  {sim.kpiLabel}: {sim.kpiValue}
                </span>
                {/* Exportar PDF del resumen guardado */}
                <button
                  onClick={() => exportarPDF(
                    sim.nombre || "Simulación",
                    [
                      { grupo: "Resultados" },
                      ...(sim.detalle || []),
                      ...(hasParams ? [{ grupo: "Parámetros técnicos" }, ...sim.params] : []),
                    ],
                    `${sim.categoriaLabel || sim.tab || ""}${sim.fecha ? " · " + sim.fecha : ""}`
                  )}
                  title="Exportar este resumen a PDF"
                  className={`shrink-0 text-xs font-black px-2.5 py-1.5 rounded-lg border bg-white ${c.text} border-current opacity-70 hover:opacity-100 transition-all select-none`}>
                  🖨️ PDF
                </button>
                {/* Expand */}
                <button
                  onClick={() => setExpandida(isOpen ? null : sim.id)}
                  title={isOpen ? "Colapsar" : "Ver detalle completo"}
                  className={`shrink-0 text-xs font-black px-2.5 py-1.5 rounded-lg border transition-all select-none
                    ${isOpen
                      ? `${c.badge} text-white border-transparent`
                      : `bg-white ${c.text} border-current opacity-70 hover:opacity-100`}`}>
                  {isOpen ? "⌃ Cerrar" : "⌄ Detalle"}
                </button>
                {/* Delete */}
                <button onClick={() => onBorrar(sim.id)}
                  className="text-slate-300 hover:text-red-500 text-lg font-black px-1 transition-all select-none shrink-0">
                  ×
                </button>
              </div>

              {/* Expanded detail */}
              {isOpen && (
                <div className="px-4 pb-4 space-y-3">
                  {/* Section tabs */}
                  {hasParams && (
                    <div className="flex gap-1 border-b border-white/60 pb-2">
                      {[
                        { id: "resultados", label: "📊 Resultados" },
                        { id: "params",     label: "⚙️ Parámetros técnicos" },
                      ].map((t) => (
                        <button key={t.id} onClick={() => setSec(sim.id, t.id)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-black transition-all
                            ${activeTab === t.id
                              ? `${c.badge} text-white shadow-sm`
                              : `bg-white/60 ${c.text} hover:bg-white`}`}>
                          {t.label}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Content grid */}
                  <div className="bg-white/70 rounded-xl border border-white p-3 grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-3">
                    {(activeTab === "params" && hasParams ? sim.params : sim.detalle).map((d, i) => (
                      <div key={i} className="flex flex-col">
                        <span className="text-xs text-slate-400 uppercase tracking-wide leading-tight">{d.label}</span>
                        <span className={`text-sm font-bold font-mono ${c.text} leading-snug`}>{d.value}</span>
                      </div>
                    ))}
                  </div>

                  {sim.nota && (
                    <p className="text-xs text-slate-400 italic mt-2 px-1">📝 {sim.nota}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TOAST SYSTEM
// ═══════════════════════════════════════════════════════════════════════════
const ToastContext = React.createContext ? null : null; // placeholder; we'll use a simple global

function ToastContainer({ toasts }) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id}
          style={{ animation: "toastIn 0.3s cubic-bezier(.34,1.56,.64,1) forwards" }}
          className={`pointer-events-auto flex items-center gap-3 px-5 py-3 rounded-2xl shadow-xl text-white text-sm font-semibold min-w-[220px] max-w-xs
            ${t.type === "error" ? "bg-red-500" : t.type === "warn" ? "bg-amber-500" : "bg-emerald-500"}`}>
          <span className="text-lg shrink-0">
            {t.type === "error" ? "❌" : t.type === "warn" ? "⚠️" : "✅"}
          </span>
          <span>{t.msg}</span>
        </div>
      ))}
    </div>
  );
}

function useToast() {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((msg, type = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((p) => [...p, { id, msg, type }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 3000);
  }, []);
  return { toasts, push };
}

// ═══════════════════════════════════════════════════════════════════════════
// PDF / PRINT EXPORT
// ═══════════════════════════════════════════════════════════════════════════
function exportarPDF(titulo, secciones, subtitulo = "") {
  const fecha = new Date().toLocaleDateString("es-AR", { dateStyle: "long" });
  const hora = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

  const rows = secciones.map((item) => {
    // Encabezado de grupo
    if (item.grupo) {
      return `<tr><td colspan="2" style="padding:14px 12px 6px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#10b981;border-bottom:2px solid #d1fae5">${item.grupo}</td></tr>`;
    }
    // Fila destacada (total, resultado)
    if (item.destacado) {
      return `<tr><td style="padding:10px 12px;color:#0f172a;font-size:14px;font-weight:800;border-bottom:1px solid #e2e8f0;background:#f0fdf4">${item.label}</td>
              <td style="padding:10px 12px;font-weight:800;font-family:monospace;text-align:right;font-size:15px;border-bottom:1px solid #e2e8f0;background:#f0fdf4;color:${item.color || '#065f46'}">${item.value}</td></tr>`;
    }
    // Fila normal
    return `<tr><td style="padding:6px 12px;color:#64748b;font-size:13px;border-bottom:1px solid #f1f5f9">${item.label}</td>
            <td style="padding:6px 12px;font-weight:700;font-family:monospace;text-align:right;border-bottom:1px solid #f1f5f9;color:${item.color || '#1e293b'}">${item.value}</td></tr>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<title>${titulo} — SoyPekun</title>
<style>
  body { font-family: 'Segoe UI', sans-serif; color: #1e293b; max-width: 720px; margin: 0 auto; padding: 40px 32px; }
  .header { display:flex; align-items:center; justify-content:space-between; border-bottom:3px solid #10b981; padding-bottom:16px; margin-bottom:20px; }
  .titulo { font-size: 22px; font-weight: 800; margin: 0 0 4px; }
  .subtitulo { color:#64748b; font-size:14px; margin:0 0 4px; }
  .fecha { color: #94a3b8; font-size: 13px; }
  .badge { background:#ecfdf5; color:#065f46; font-size:10px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; padding:4px 10px; border-radius:20px; border:1px solid #6ee7b7; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th { background: #f8fafc; padding: 10px 12px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #94a3b8; }
  .footer { margin-top: 24px; border-top: 2px solid #e2e8f0; padding-top: 12px; font-size: 11px; color: #94a3b8; display:flex; justify-content:space-between; }
  @media print { body { padding: 20px; } @page { margin: 1.5cm; } }
</style></head>
<body>
  <div class="header">
    <img src="data:image/png;base64,${LOGO_B64}" style="height:72px;object-fit:contain" alt="SoyPekun"/>
    <span class="badge">Simulador Económico Ganadero</span>
  </div>
  <div class="titulo">${titulo}</div>
  ${subtitulo ? `<div class="subtitulo">${subtitulo}</div>` : ""}
  <div class="fecha">Generado el ${fecha} · ${hora} hs</div>
  <br/>
  <table>
    <thead><tr><th>Concepto</th><th style="text-align:right">Valor</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="footer">
    <span>Los cálculos son estimativos. Consultá con tu asesor antes de invertir.</span>
    <span>SoyPekun — Gestión Ganadera</span>
  </div>
  <script>window.onload=()=>{ window.print(); }<\/script>
</body></html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank");
  if (w) { setTimeout(() => URL.revokeObjectURL(url), 60000); }
}

function BotonExportarPDF({ titulo, secciones, color = "slate", subtitulo = "" }) {
  // La exportacion a PDF se hace ahora desde cada simulacion GUARDADA
  // (ver SimulacionesPanel). Este boton "en vivo" queda desactivado a proposito.
  return null;
  // eslint-disable-next-line no-unreachable
  const colores = {
    slate:   "bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-200",
    violet:  "bg-violet-50 hover:bg-violet-100 text-violet-700 border border-violet-200",
    emerald: "bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200",
    sky:     "bg-sky-50 hover:bg-sky-100 text-sky-700 border border-sky-200",
    amber:   "bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200",
  };
  return (
    <button onClick={() => exportarPDF(titulo, secciones, subtitulo)}
      title="Exportar / Imprimir reporte"
      className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl font-bold text-xs transition-all shadow-sm select-none card-hover ${colores[color]}`}>
      🖨️ Exportar PDF
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// GRÁFICOS — PIE + BAR
// ═══════════════════════════════════════════════════════════════════════════
const PIE_COLORS = ["#10b981","#6366f1","#f59e0b","#ef4444","#8b5cf6","#06b6d4","#f97316"];

function GraficoCostos({ data, titulo }) {
  const filtrado = data.filter((d) => d.value > 0);
  if (filtrado.length === 0) return null;
  const total = filtrado.reduce((s, d) => s + d.value, 0);
  return (
    <div className="rounded-2xl border border-slate-100 bg-white shadow-sm p-4">
      <p className="text-xs font-black uppercase tracking-widest text-slate-400 mb-3">{titulo}</p>
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie data={filtrado} dataKey="value" nameKey="name" cx="50%" cy="50%"
            innerRadius={52} outerRadius={82} paddingAngle={3} strokeWidth={0}>
            {filtrado.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
          </Pie>
          <RTooltip formatter={(v, n) => [`${((v/total)*100).toFixed(1)}% — ${fmtMoney(v)}`, n]}
            contentStyle={{ borderRadius: "12px", border: "1px solid #e2e8f0", fontSize: "12px" }} />
        </PieChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
        {filtrado.map((d, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
            <span className="text-xs text-slate-500">{d.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GraficoBarras({ data, titulo, colorA = "#10b981", colorB = "#6366f1" }) {
  if (!data || data.length === 0) return null;
  return (
    <div className="rounded-2xl border border-slate-100 bg-white shadow-sm p-4">
      <p className="text-xs font-black uppercase tracking-widest text-slate-400 mb-3">{titulo}</p>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false}
            tickFormatter={(v) => v >= 1e6 ? `$${(v/1e6).toFixed(1)}M` : v >= 1000 ? `$${(v/1000).toFixed(0)}k` : `$${v}`} />
          <RTooltip formatter={(v) => fmtMoney(v)}
            contentStyle={{ borderRadius: "12px", border: "1px solid #e2e8f0", fontSize: "12px" }} />
          <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }} />
          {data[0]?.inversion !== undefined && <Bar dataKey="inversion" name="Inversión / Costo" fill={colorB} radius={[6,6,0,0]} />}
          {data[0]?.ingreso !== undefined && <Bar dataKey="ingreso" name="Ingreso / Ganancia" fill={colorA} radius={[6,6,0,0]} />}
          {data[0]?.margen !== undefined && <Bar dataKey="margen" name="Margen Neto" fill="#f59e0b" radius={[6,6,0,0]} />}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function BotonGuardarSim({ onGuardar, color = "sky", onToast }) {
  const [guardado, setGuardado] = useState(false);
  const handle = () => {
    onGuardar();
    setGuardado(true);
    onToast && onToast("✅ Simulación guardada con éxito");
    setTimeout(() => setGuardado(false), 2000);
  };
  const colores = {
    sky:     "bg-sky-500 hover:bg-sky-600 active:bg-sky-700",
    violet:  "bg-violet-500 hover:bg-violet-600 active:bg-violet-700",
    emerald: "bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800",
  };
  return (
    <button onClick={handle}
      className={`flex items-center gap-2 px-6 py-3 rounded-2xl text-white font-black text-sm transition-all select-none relative overflow-hidden
        ${guardado
          ? "bg-gradient-to-r from-emerald-400 to-teal-500 scale-95 shadow-lg shadow-emerald-200"
          : `${colores[color]} shadow-lg hover:shadow-xl hover:scale-105 active:scale-95`}`}
      style={{transition:"all 0.2s cubic-bezier(0.34,1.56,0.64,1)"}}>
      <span className={`transition-transform ${guardado ? "rotate-12" : ""}`}>
        {guardado ? "✅" : "💾"}
      </span>
      {guardado ? "¡Guardado!" : "Guardar simulación"}
    </button>
  );
}



// ═══════════════════════════════════════════════════════════════════════════
// LOGIN SCREEN — Magic Link passwordless
// ═══════════════════════════════════════════════════════════════════════════
const ACTION_URL = window.location.origin;

// ═══════════════════════════════════════════════════════════════════════════
// MENU CARD
// ═══════════════════════════════════════════════════════════════════════════
function MenuCard({ title, desc, icon, iconAnim, color, onClick, stats }) {
  const themes = {
    green: {
      card: "card-green", strip: "card-strip-green",
      textTitle: "text-white", textDesc: "text-emerald-100", textStat: "text-emerald-200",
      iconWrap: "bg-white/20 backdrop-blur-sm border border-white/30 group-hover:bg-white/30",
      cta: "bg-white/20 hover:bg-white/30 text-white border border-white/40",
      shadow: "hover:shadow-emerald-900/50",
    },
    multi: {
      card: "card-multi", strip: "card-strip-multi",
      textTitle: "text-white", textDesc: "text-purple-100", textStat: "text-purple-200",
      iconWrap: "bg-white/20 backdrop-blur-sm border border-white/30 group-hover:bg-white/30",
      cta: "bg-white/20 hover:bg-white/30 text-white border border-white/40",
      shadow: "hover:shadow-purple-900/50",
    },
    amber: {
      card: "card-amber", strip: "card-strip-amber",
      textTitle: "text-white", textDesc: "text-amber-100", textStat: "text-amber-200",
      iconWrap: "bg-white/20 backdrop-blur-sm border border-white/30 group-hover:bg-white/30",
      cta: "bg-white/20 hover:bg-white/30 text-white border border-white/40",
      shadow: "hover:shadow-amber-900/50",
    },
  };
  const t = themes[color] || themes.green;
  const animClass = iconAnim === "float" ? "card-icon-float" : iconAnim === "spin" ? "card-icon-spin" : "card-icon-bounce";
  return (
    <button onClick={onClick}
      className={`${t.card} rounded-[2rem] overflow-hidden hover:shadow-2xl ${t.shadow} hover:-translate-y-4 hover:scale-[1.02] transition-all duration-300 text-left group w-full relative`}>
      <div className={`h-1.5 w-full ${t.strip}`} />
      <div className="absolute inset-0 pointer-events-none" style={{background:"linear-gradient(135deg,rgba(255,255,255,0.05),transparent)"}} />
      <div className="absolute top-0 right-0 w-40 h-40 rounded-full bg-white/5 -translate-y-16 translate-x-16 pointer-events-none" />
      <div className="relative p-5 md:p-7">
        <div className={`${t.iconWrap} w-12 h-12 md:w-14 md:h-14 rounded-xl flex items-center justify-center mb-3 md:mb-4 transition-all duration-300 shadow-lg ${animClass}`}>
          {icon}
        </div>
        <h3 className={`text-xl md:text-2xl font-black ${t.textTitle} mb-2 tracking-tight leading-tight`}>{title}</h3>
        <p className={`${t.textDesc} font-medium leading-relaxed text-sm mb-3`}>{desc}</p>
        {stats && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {stats.map((s, i) => (
              <span key={i} className={`text-xs font-bold ${t.textStat} bg-white/10 border border-white/20 px-2.5 py-1 rounded-full`}>{s}</span>
            ))}
          </div>
        )}
        <div className={`${t.cta} inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all duration-200`}>
          <span>Abrir simulador</span>
          <span className="transition-transform group-hover:translate-x-1">→</span>
        </div>
      </div>
    </button>
  );
}

// LOGIN SCREEN — Email + Contraseña
// ═══════════════════════════════════════════════════════════════════════════
function LoginScreen() {
  const [modo,     setModo]     = useState("login"); // "login" | "register" | "reset"
  const [email,    setEmail]    = useState("");
  const [pass,     setPass]     = useState("");
  const [pass2,    setPass2]    = useState("");
  const [showPass, setShowPass] = useState(false);
  const [estado,   setEstado]   = useState("idle"); // idle | loading | ok | error
  const [errorMsg, setErrorMsg] = useState("");
  const [resetOk,  setResetOk]  = useState(false);

  const resetForm = () => { setErrorMsg(""); setEstado("idle"); setPass(""); setPass2(""); setResetOk(false); };
  const cambiarModo = (m) => { setModo(m); resetForm(); };

  const handleLogin = async () => {
    const em = email.trim().toLowerCase();
    if (!em || !pass) { setErrorMsg("Completá email y contraseña."); setEstado("error"); return; }
    setEstado("loading");
    try {
      await signInWithEmailAndPassword(auth, em, pass);
    } catch(err) {
      const msgs = {
        "auth/user-not-found":    "No existe una cuenta con ese email. Registrate primero.",
        "auth/wrong-password":    "Contraseña incorrecta.",
        "auth/invalid-credential":"Email o contraseña incorrectos.",
        "auth/too-many-requests": "Demasiados intentos. Esperá unos minutos.",
        "auth/invalid-email":     "Email inválido.",
      };
      setErrorMsg(msgs[err?.code] || `Error: ${err?.code || "desconocido"}`);
      setEstado("error");
    }
  };

  const handleRegistrar = async () => {
    const em = email.trim().toLowerCase();
    if (!em || !pass || !pass2) { setErrorMsg("Completá todos los campos."); setEstado("error"); return; }
    if (pass.length < 6) { setErrorMsg("La contraseña debe tener al menos 6 caracteres."); setEstado("error"); return; }
    if (pass !== pass2) { setErrorMsg("Las contraseñas no coinciden."); setEstado("error"); return; }
    setEstado("loading");
    try {
      await createUserWithEmailAndPassword(auth, em, pass);
    } catch(err) {
      const msgs = {
        "auth/email-already-in-use": "Ya existe una cuenta con ese email. Iniciá sesión.",
        "auth/weak-password":        "Contraseña muy débil. Usá al menos 6 caracteres.",
        "auth/invalid-email":        "Email inválido.",
      };
      setErrorMsg(msgs[err?.code] || `Error: ${err?.code || "desconocido"}`);
      setEstado("error");
    }
  };

  const handleReset = async () => {
    const em = email.trim().toLowerCase();
    if (!em) { setErrorMsg("Ingresá tu email."); setEstado("error"); return; }
    setEstado("loading");
    try {
      await sendPasswordResetEmail(auth, em);
      setResetOk(true);
      setEstado("ok");
    } catch(err) {
      setErrorMsg("Error al enviar el email. Revisá que el email sea correcto.");
      setEstado("error");
    }
  };

  const handleSubmit = () => {
    if (modo === "login")    handleLogin();
    else if (modo === "register") handleRegistrar();
    else handleReset();
  };

  const STYLE = `
    .lb{min-height:100vh;background:linear-gradient(160deg,#F4EEE1 0%,#EAE1D0 55%,#E3D2B0 100%);display:flex;align-items:center;justify-content:center;padding:1.5rem 1rem;position:relative;overflow:hidden;font-family:sans-serif;}
    .lblob{position:absolute;border-radius:50%;pointer-events:none;}
    .lb1{width:560px;height:560px;background:#2F7D4F;opacity:.07;top:-190px;right:-150px;animation:lbf1 9s ease-in-out infinite;}
    .lb2{width:360px;height:360px;background:#C2683C;opacity:.06;bottom:-110px;left:-90px;animation:lbf2 11s ease-in-out infinite;}
    .lb3{width:200px;height:200px;background:#D9A441;opacity:.07;top:38%;left:6%;animation:lbf1 7s ease-in-out infinite;}
    .lb4{width:110px;height:110px;background:#2F7D4F;opacity:.06;bottom:18%;right:8%;animation:lbf2 8s ease-in-out 1.5s infinite;}
    @keyframes lbf1{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(24px,-36px) scale(1.06)}}
    @keyframes lbf2{0%,100%{transform:translate(0,0)}50%{transform:translate(-18px,24px) scale(1.09)}}
    .ldollar{position:absolute;color:#C9A24B;font-weight:900;pointer-events:none;user-select:none;line-height:1;}
    .ld1{font-size:72px;opacity:.09;top:8%;left:4%;animation:fd1 7s ease-in-out infinite;}
    .ld2{font-size:48px;opacity:.07;top:15%;right:6%;animation:fd2 9s ease-in-out 1s infinite;}
    .ld3{font-size:96px;opacity:.06;bottom:12%;left:2%;animation:fd1 8s ease-in-out 2s infinite;}
    .ld4{font-size:36px;opacity:.09;bottom:25%;right:4%;animation:fd2 6s ease-in-out .5s infinite;}
    .ld5{font-size:60px;opacity:.07;top:55%;right:12%;animation:fd1 10s ease-in-out 1.5s infinite;}
    .ld6{font-size:44px;opacity:.08;top:42%;left:15%;animation:fd2 7.5s ease-in-out 3s infinite;}
    @keyframes fd1{0%,100%{transform:translateY(0) rotate(-15deg)}50%{transform:translateY(-40px) rotate(-8deg)}}
    @keyframes fd2{0%,100%{transform:translateY(0) rotate(20deg)}50%{transform:translateY(-50px) rotate(28deg)}}
    .lcard{background:#fff;border-radius:32px;padding:2.5rem 2rem 2rem;width:100%;max-width:420px;position:relative;z-index:2;box-shadow:0 30px 80px -12px rgba(90,70,40,.30);animation:lcardIn .65s cubic-bezier(.16,1,.3,1) both;}
    @keyframes lcardIn{from{opacity:0;transform:translateY(40px) scale(0.93)}to{opacity:1;transform:translateY(0) scale(1)}}
    .lwrap{display:flex;flex-direction:column;align-items:center;margin-bottom:1.25rem;}
    .lline{height:2px;width:56px;background:linear-gradient(90deg,#10b981,#34d399,transparent);border-radius:2px;margin:8px 0;}
    .lbadge{background:linear-gradient(135deg,#2F7D4F,#256B43);color:#a7f3d0;font-size:9px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;padding:3px 9px;border-radius:20px;}
    .lslogan{font-size:10px;font-weight:700;letter-spacing:.18em;color:#6b7280;text-transform:uppercase;margin:0;}
    .lh2{font-size:21px;font-weight:900;color:#111827;text-align:center;margin:1rem 0 .25rem;letter-spacing:-.4px;}
    .lsub{font-size:13px;color:#6b7280;text-align:center;margin:0 0 1.2rem;line-height:1.55;}
    .ltabs{display:flex;gap:6px;margin-bottom:1.25rem;background:#f3f4f6;border-radius:14px;padding:4px;}
    .ltab{flex:1;padding:8px;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;transition:all .2s;background:transparent;color:#6b7280;}
    .ltab.active{background:#fff;color:#2F7D4F;box-shadow:0 2px 8px rgba(0,0,0,.1);}
    .linpwrap{position:relative;margin-bottom:.7rem;}
    .linpicon{position:absolute;left:14px;top:50%;transform:translateY(-50%);opacity:.35;pointer-events:none;}
    .linptoggle{position:absolute;right:14px;top:50%;transform:translateY(-50%);opacity:.45;cursor:pointer;background:none;border:none;padding:0;display:flex;}
    .linp{width:100%;box-sizing:border-box;padding:13px 14px 13px 44px;font-size:15px;border:2px solid #e5e7eb;border-radius:14px;outline:none;color:#111827;background:#f9fafb;transition:border-color .2s,box-shadow .2s;font-family:inherit;}
    .linp:focus{border-color:#10b981;background:#fff;box-shadow:0 0 0 4px rgba(16,185,129,.14);}
    .linp.lerr{border-color:#ef4444;box-shadow:0 0 0 4px rgba(239,68,68,.12);}
    .linp::placeholder{color:#9ca3af;}
    .lbtn{width:100%;padding:14px;background:linear-gradient(135deg,#2F7D4F,#256B43);color:#fff;border:none;border-radius:14px;font-size:15px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:transform .2s,box-shadow .2s;margin-top:.25rem;}
    .lbtn:hover{transform:translateY(-2px);box-shadow:0 10px 28px rgba(6,78,59,.4);}
    .lbtn:active{transform:scale(.97);}
    .lbtn:disabled{opacity:.7;cursor:not-allowed;transform:none!important;}
    .lerrmsg{margin-top:.6rem;background:#fef2f2;border:1.5px solid #fca5a5;border-radius:12px;padding:10px 13px;font-size:13px;color:#dc2626;font-weight:600;display:flex;align-items:center;gap:8px;}
    .lokmsg{margin-top:.6rem;background:#ecfdf5;border:1.5px solid #6ee7b7;border-radius:12px;padding:10px 13px;font-size:13px;color:#065f46;font-weight:600;display:flex;align-items:center;gap:8px;}
    .lforgot{font-size:12px;color:#6b7280;text-align:center;margin-top:.9rem;cursor:pointer;text-decoration:underline;}
    .lspinner{width:18px;height:18px;border:2.5px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:lspin .7s linear infinite;display:inline-block;}
    @keyframes lspin{to{transform:rotate(360deg)}}
    .lnote{font-size:11px;color:#9ca3af;text-align:center;margin:1rem 0 0;line-height:1.55;}
  `;

  const isErr = estado === "error";
  const isLoading = estado === "loading";

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      <div className="lb">
        <div className="lblob lb1" /><div className="lblob lb2" />
        <div className="lblob lb3" /><div className="lblob lb4" />
        <div className="ldollar ld1">$</div><div className="ldollar ld2">$</div>
        <div className="ldollar ld3">$</div><div className="ldollar ld4">$</div>
        <div className="ldollar ld5">$</div><div className="ldollar ld6">$</div>

        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:"24px", width:"100%", maxWidth:"420px", position:"relative", zIndex:2 }}>
          {/* Logo sobre el fondo verde — mismo color que el fondo del PNG */}
          <img src={`data:image/png;base64,${LOGO_B64}`} alt="SoyPekun"
            style={{ height:"110px", objectFit:"contain" }} />

        <div className="lcard">
          <div className="lwrap">
            <div className="lline" />
            <div style={{ display:"flex", alignItems:"center", gap:"6px" }}>
              <span className="lbadge">Simulador</span>
              <span className="lslogan">Económico Ganadero</span>
            </div>
          </div>

          {/* Tabs login / registrar / recuperar */}
          <div className="ltabs">
            <button className={`ltab${modo==="login" ? " active" : ""}`} onClick={() => cambiarModo("login")}>Ingresar</button>
            <button className={`ltab${modo==="register" ? " active" : ""}`} onClick={() => cambiarModo("register")}>Registrarse</button>
            <button className={`ltab${modo==="reset" ? " active" : ""}`} onClick={() => cambiarModo("reset")}>Recuperar</button>
          </div>

          <h2 className="lh2">
            {modo === "login"    ? "Bienvenido de vuelta" :
             modo === "register" ? "Crear cuenta" :
                                   "Recuperar contraseña"}
          </h2>
          <p className="lsub">
            {modo === "login"    ? "Ingresá tus credenciales para acceder." :
             modo === "register" ? "Creá tu cuenta para empezar a gestionar tu campo." :
                                   "Te mandamos un email para restablecer tu contraseña."}
          </p>

          {/* Email */}
          <div className="linpwrap">
            <div className="linpicon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="m2 7 10 6 10-6"/></svg>
            </div>
            <input className={`linp${isErr ? " lerr" : ""}`} type="email"
              placeholder="tu@email.com" value={email}
              onChange={e => { setEmail(e.target.value); if(isErr){ setEstado("idle"); setErrorMsg(""); } }}
              onKeyDown={e => e.key === "Enter" && handleSubmit()}
              disabled={isLoading}
            />
          </div>

          {/* Contraseña */}
          {modo !== "reset" && (
            <div className="linpwrap">
              <div className="linpicon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              </div>
              <input className={`linp${isErr ? " lerr" : ""}`}
                type={showPass ? "text" : "password"}
                placeholder="Contraseña (mín. 6 caracteres)" value={pass}
                onChange={e => { setPass(e.target.value); if(isErr){ setEstado("idle"); setErrorMsg(""); } }}
                onKeyDown={e => e.key === "Enter" && handleSubmit()}
                disabled={isLoading}
                style={{ paddingRight: "44px" }}
              />
              <button className="linptoggle" onClick={() => setShowPass(p => !p)} tabIndex={-1}>
                {showPass
                  ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                }
              </button>
            </div>
          )}

          {/* Confirmar contraseña (solo registro) */}
          {modo === "register" && (
            <div className="linpwrap">
              <div className="linpicon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              </div>
              <input className={`linp${isErr ? " lerr" : ""}`}
                type={showPass ? "text" : "password"}
                placeholder="Repetí la contraseña" value={pass2}
                onChange={e => { setPass2(e.target.value); if(isErr){ setEstado("idle"); setErrorMsg(""); } }}
                onKeyDown={e => e.key === "Enter" && handleSubmit()}
                disabled={isLoading}
                style={{ paddingRight: "44px" }}
              />
            </div>
          )}

          {/* Botón principal */}
          <button className="lbtn" onClick={handleSubmit} disabled={isLoading}>
            {isLoading ? (
              <><span className="lspinner" /> {modo === "login" ? "Ingresando..." : modo === "register" ? "Registrando..." : "Enviando..."}</>
            ) : (
              modo === "login"    ? "Ingresar →" :
              modo === "register" ? "Crear cuenta →" :
                                    "Enviar email de recuperación →"
            )}
          </button>

          {/* Mensajes */}
          {isErr && (
            <div className="lerrmsg">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>
              {errorMsg}
            </div>
          )}
          {resetOk && (
            <div className="lokmsg">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#065f46" strokeWidth="2.5" strokeLinecap="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              Email enviado a {email}. Revisá tu casilla.
            </div>
          )}

          <p className="lnote">SoyPekun · Gestión Ganadera Profesional</p>
        </div>
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD — Panel de Inicio
// ═══════════════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════════════
// SIMULADOR MENU — Submenú con los 3 simuladores
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// TAB — CHACRA: ALIMENTO PROPIO vs COMPRAR vs RENTA  (sistema mixto · engorde)
// Con estructura de costos de producción COMPLETA y editable por cultivo
// (semilla, fertilizantes, agroquímicos, labores, cosecha/picado, etc.).
// Modelado en toneladas de materia seca (MS). Sincronizado con la config global.
// ═══════════════════════════════════════════════════════════════════════════
const CULTIVOS_FORRAJE = {
  maiz_grano:   { label: "Maíz grano",        rinde: 8,  unidad: "t/ha"    },
  maiz_silaje:  { label: "Maíz picado fino",  rinde: 13, unidad: "t MS/ha" },
  sorgo_silaje: { label: "Sorgo picado fino", rinde: 14, unidad: "t MS/ha" },
};
const CULTIVOS_RENTA = {
  soja:       { label: "Soja",       rinde: 3, precio: 455000 },
  maiz_grano: { label: "Maíz grano", rinde: 8, precio: 255500 },
  sorgo:      { label: "Sorgo",      rinde: 5, precio: 275000 },
};

// Plantillas de costos directos por hectárea (cantidad × precio). Todo editable.
// Valores de referencia jun-2026; ajustá a tu zona y a tus proveedores.
const COSTOS_DEF = {
  maiz_grano: [
    { nombre: "Semilla",                       cant: 1,   unidad: "/ha", precio: 180000 },
    { nombre: "Fosfato diamónico (MAP)",       cant: 90,  unidad: "kg",  precio: 1100 },
    { nombre: "Urea",                          cant: 180, unidad: "kg",  precio: 850 },
    { nombre: "Herbicidas (barbecho+pre+post)",cant: 1,   unidad: "/ha", precio: 95000 },
    { nombre: "Insecticida + curasemilla",     cant: 1,   unidad: "/ha", precio: 28000 },
    { nombre: "Labor de siembra",              cant: 1,   unidad: "/ha", precio: 70000 },
    { nombre: "Pulverizaciones",               cant: 3,   unidad: "aplic", precio: 13000 },
    { nombre: "Cosecha",                       cant: 1,   unidad: "/ha", precio: 115000 },
    { nombre: "Seguro + otros",                cant: 1,   unidad: "/ha", precio: 30000 },
  ],
  maiz_silaje: [
    { nombre: "Semilla",                       cant: 1,   unidad: "/ha", precio: 180000 },
    { nombre: "Fosfato diamónico (MAP)",       cant: 90,  unidad: "kg",  precio: 1100 },
    { nombre: "Urea",                          cant: 180, unidad: "kg",  precio: 850 },
    { nombre: "Herbicidas (barbecho+pre+post)",cant: 1,   unidad: "/ha", precio: 95000 },
    { nombre: "Insecticida + curasemilla",     cant: 1,   unidad: "/ha", precio: 28000 },
    { nombre: "Labor de siembra",              cant: 1,   unidad: "/ha", precio: 70000 },
    { nombre: "Pulverizaciones",               cant: 3,   unidad: "aplic", precio: 13000 },
    { nombre: "Picado + confección",           cant: 1,   unidad: "/ha", precio: 300000 },
    { nombre: "Bolsa/silo + lona",             cant: 1,   unidad: "/ha", precio: 40000 },
  ],
  sorgo_silaje: [
    { nombre: "Semilla",                       cant: 1,   unidad: "/ha", precio: 65000 },
    { nombre: "Fosfato diamónico (MAP)",       cant: 60,  unidad: "kg",  precio: 1100 },
    { nombre: "Urea",                          cant: 120, unidad: "kg",  precio: 850 },
    { nombre: "Herbicidas",                    cant: 1,   unidad: "/ha", precio: 75000 },
    { nombre: "Insecticida",                   cant: 1,   unidad: "/ha", precio: 20000 },
    { nombre: "Labor de siembra",              cant: 1,   unidad: "/ha", precio: 60000 },
    { nombre: "Pulverizaciones",               cant: 2,   unidad: "aplic", precio: 13000 },
    { nombre: "Picado + confección",           cant: 1,   unidad: "/ha", precio: 280000 },
    { nombre: "Bolsa/silo",                    cant: 1,   unidad: "/ha", precio: 35000 },
    { nombre: "Otros",                         cant: 1,   unidad: "/ha", precio: 120000 },
  ],
  soja: [
    { nombre: "Semilla + inoculante",          cant: 1,   unidad: "/ha", precio: 90000 },
    { nombre: "Fertilizante arrancador",       cant: 1,   unidad: "/ha", precio: 55000 },
    { nombre: "Herbicidas (glifo+pre+post)",   cant: 1,   unidad: "/ha", precio: 120000 },
    { nombre: "Insecticida + fungicida",       cant: 1,   unidad: "/ha", precio: 42000 },
    { nombre: "Labor de siembra",              cant: 1,   unidad: "/ha", precio: 55000 },
    { nombre: "Pulverizaciones",               cant: 3,   unidad: "aplic", precio: 13000 },
    { nombre: "Cosecha",                       cant: 1,   unidad: "/ha", precio: 52000 },
  ],
  sorgo: [
    { nombre: "Semilla",                       cant: 1,   unidad: "/ha", precio: 65000 },
    { nombre: "Fertilizante",                  cant: 1,   unidad: "/ha", precio: 120000 },
    { nombre: "Herbicidas",                    cant: 1,   unidad: "/ha", precio: 80000 },
    { nombre: "Insecticida",                   cant: 1,   unidad: "/ha", precio: 20000 },
    { nombre: "Labor de siembra",              cant: 1,   unidad: "/ha", precio: 60000 },
    { nombre: "Pulverizaciones",               cant: 2,   unidad: "aplic", precio: 13000 },
    { nombre: "Cosecha",                       cant: 1,   unidad: "/ha", precio: 80000 },
    { nombre: "Otros",                         cant: 1,   unidad: "/ha", precio: 49000 },
  ],
};
const tmplCostos = (id) => (COSTOS_DEF[id] || []).map((l, i) => ({ ...l, id: id + "_" + i + "_" + Math.random().toString(36).slice(2, 7) }));
const sumCostos  = (ls) => ls.reduce((s, l) => s + (Number(l.cant) || 0) * (Number(l.precio) || 0), 0);

// Editor de costos por línea — colapsable, suma sola
function CostEditor({ titulo, lineas, onChange, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  const total = sumCostos(lineas);
  const upd = (i, k, v) => onChange(lineas.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const del = (i) => onChange(lineas.filter((_, j) => j !== i));
  const add = () => onChange([...lineas, { id: "c_" + Math.random().toString(36).slice(2, 8), nombre: "Nuevo costo", cant: 1, unidad: "/ha", precio: 0 }]);
  const numCls = "w-full px-2 py-1.5 rounded-lg border-2 border-slate-200 text-right font-mono text-slate-700 outline-none bg-white";
  return (
    <div className="rounded-2xl border-2 border-slate-100 bg-white">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between p-3 active:scale-[0.99] transition-transform">
        <span className="text-sm font-black text-slate-700">{titulo}</span>
        <span className="flex items-center gap-2">
          <span className="text-sm font-black text-emerald-700">{fmtMoney(total)}/ha</span>
          <span className="text-slate-400 text-xs">{open ? "▲" : "▼"}</span>
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          {lineas.map((l, i) => (
            <div key={l.id} className="rounded-xl border border-slate-100 bg-slate-50 p-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <input value={l.nombre} onChange={(e) => upd(i, "nombre", e.target.value)}
                  className="flex-1 min-w-0 bg-transparent font-bold text-sm text-slate-700 outline-none border-b border-slate-200 focus:border-emerald-400 pb-0.5" />
                <button onClick={() => del(i)} className="text-slate-300 hover:text-red-500 font-black px-1 shrink-0">✕</button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] text-slate-400 font-bold block mb-0.5">Cantidad ({l.unidad})</label>
                  <input type="number" inputMode="decimal" value={l.cant}
                    onChange={(e) => upd(i, "cant", e.target.value === "" ? "" : parseFloat(e.target.value))}
                    className={numCls} />
                </div>
                <div>
                  <label className="text-[11px] text-slate-400 font-bold block mb-0.5">Precio $/{l.unidad === "/ha" ? "ha" : l.unidad}</label>
                  <input type="number" inputMode="decimal" value={l.precio}
                    onChange={(e) => upd(i, "precio", e.target.value === "" ? "" : parseFloat(e.target.value))}
                    className={numCls} />
                </div>
              </div>
              <p className="text-right text-xs text-slate-500">= <b className="text-slate-700">{fmtMoney((Number(l.cant) || 0) * (Number(l.precio) || 0))}</b>/ha</p>
            </div>
          ))}
          <div className="flex items-center justify-between pt-1">
            <button onClick={add} className="text-xs font-black text-emerald-600 hover:text-emerald-700 px-2 py-2 rounded-lg border-2 border-dashed border-emerald-200">+ Agregar costo</button>
            <p className="text-sm font-black text-slate-700">Total: <span className="font-mono text-emerald-700">{fmtMoney(total)}</span>/ha</p>
          </div>
        </div>
      )}
    </div>
  );
}

function ChacraAlimento({ onGuardar, onToast, onAgregarAlCampo }) {
  const global = useGlobal();
  const gastos = useGastos();

  const [inp, setInp] = useState({
    cabezas: 100,
    mesesCiclo: 6,
    consumoKgMSdia: 9,
    precioAlimentoComprado: 250000,
    cultivoForraje: "maiz_silaje",
    rindeForraje: CULTIVOS_FORRAJE.maiz_silaje.rinde,
    perdidasPct: 12,
    costosForraje: tmplCostos("maiz_silaje"),
    cultivoRenta: "soja",
    rindeRenta: CULTIVOS_RENTA.soja.rinde,
    precioRenta: CULTIVOS_RENTA.soja.precio,
    gastosComercPct: 12,
    costosRenta: tmplCostos("soja"),
    precioNovilloGordo: 4350,
  });
  const set = (k) => (v) => setInp((p) => ({ ...p, [k]: v }));
  const elegirForraje = (id) => setInp((p) => ({ ...p, cultivoForraje: id, rindeForraje: CULTIVOS_FORRAJE[id].rinde, costosForraje: tmplCostos(id) }));
  const elegirRenta = (id) => setInp((p) => ({ ...p, cultivoRenta: id, rindeRenta: CULTIVOS_RENTA[id].rinde, precioRenta: CULTIVOS_RENTA[id].precio, costosRenta: tmplCostos(id) }));

  const calc = useMemo(() => {
    const dias = inp.mesesCiclo * 30;
    const tonMS = inp.cabezas * inp.consumoKgMSdia * dias / 1000;
    const costoComprar = tonMS * inp.precioAlimentoComprado;
    const costoForrajeHa = sumCostos(inp.costosForraje);
    const costoRentaHa = sumCostos(inp.costosRenta);
    const tonACosechar = inp.perdidasPct < 100 ? tonMS / (1 - inp.perdidasPct / 100) : tonMS;
    const haForraje = inp.rindeForraje > 0 ? tonACosechar / inp.rindeForraje : 0;
    const costoProduccion = haForraje * costoForrajeHa;
    const costoPropioPorTon = tonMS > 0 ? costoProduccion / tonMS : 0;
    const precioNetoRenta = inp.precioRenta * (1 - inp.gastosComercPct / 100);
    const ingresoRenta = haForraje * inp.rindeRenta * precioNetoRenta;
    const costoRentaTotal = haForraje * costoRentaHa;
    const margenRenta = ingresoRenta - costoRentaTotal;
    const netoA = -costoProduccion;
    const netoB = -costoComprar;
    const netoC = margenRenta - costoComprar;
    const ahorro = costoComprar - costoProduccion;
    const oportunidadTierra = margenRenta;
    const convieneProducir = ahorro > margenRenta;
    const ahorroPorCab = inp.cabezas > 0 ? ahorro / inp.cabezas : 0;
    const precioMaizKg = CULTIVOS_RENTA.maiz_grano.precio / 1000;
    const relacionMaizNovillo = precioMaizKg > 0 ? inp.precioNovilloGordo / precioMaizKg : 0;
    const rindeForrajeBE = costoComprar > 0 ? (tonACosechar * costoForrajeHa) / costoComprar : 0;
    const precioCompraBE = costoPropioPorTon;
    const costoInmagRef = inp.cabezas * inp.mesesCiclo * (global.inmagInvernada || 0) * (global.precioNovilloInmag || 0);
    const opciones = [
      { id: "A", nombre: "Forraje propio",  neto: netoA, color: "#16a34a" },
      { id: "B", nombre: "Comprar todo",    neto: netoB, color: "#0891b2" },
      { id: "C", nombre: "Renta + comprar", neto: netoC, color: "#9333ea" },
    ].sort((a, b) => b.neto - a.neto);
    const ganador = opciones[0];
    const segundo = opciones[1];
    const ventaja = ganador.neto - segundo.neto;
    const escenario = (dRinde, dPrecio) => {
      const r  = inp.rindeForraje * (1 + dRinde);
      const ha = r > 0 ? tonACosechar / r : 0;
      const cp = ha * costoForrajeHa;
      const pN = inp.precioRenta * (1 + dPrecio) * (1 - inp.gastosComercPct / 100);
      const mr = ha * inp.rindeRenta * pN - ha * costoRentaHa;
      const nA = -cp, nB = -costoComprar, nC = mr - costoComprar;
      const best = [{ id: "A", n: nA }, { id: "B", n: nB }, { id: "C", n: nC }].sort((a, b) => b.n - a.n)[0];
      return { nA, nB, nC, best: best.id };
    };
    return {
      dias, tonMS, costoComprar, costoForrajeHa, costoRentaHa, tonACosechar, haForraje, costoProduccion, costoPropioPorTon,
      precioNetoRenta, ingresoRenta, costoRentaTotal, margenRenta,
      netoA, netoB, netoC, ahorro, oportunidadTierra, convieneProducir, ahorroPorCab,
      relacionMaizNovillo, rindeForrajeBE, precioCompraBE, costoInmagRef,
      opciones, ganador, segundo, ventaja, escenario,
    };
  }, [inp, global.inmagInvernada, global.precioNovilloInmag]);

  const fLabel = CULTIVOS_FORRAJE[inp.cultivoForraje].label;
  const rLabel = CULTIVOS_RENTA[inp.cultivoRenta].label;
  const nombreCamino = (id) => id === "A" ? "Forraje propio" : id === "B" ? "Comprar todo" : "Renta + comprar";

  const Pill = ({ active, onClick, children }) => (
    <button onClick={onClick}
      className={`px-3 py-2 rounded-xl text-xs font-black border-2 transition-all active:scale-95 ${
        active ? "bg-lime-600 text-white border-lime-600 shadow" : "bg-white text-slate-500 border-slate-200 hover:border-lime-300"}`}>
      {children}
    </button>
  );

  return (
    <div className="space-y-5">
      <div className="rounded-3xl p-5 bg-gradient-to-br from-lime-50 to-emerald-50 border-2 border-lime-100">
        <p className="text-lg font-black text-lime-800 tracking-tight">🌽 Chacra — Alimento propio vs. comprar vs. renta</p>
        <p className="text-xs text-lime-600 mt-1">Cargá el costo de producción completo de cada cultivo (semilla, fertilizantes, agroquímicos, labores, cosecha/picado…) y el módulo arma la cuenta sola.</p>
      </div>

      <div className="rounded-3xl p-5 bg-white border-2 border-slate-100 shadow-sm space-y-3">
        <SectionTitle icon="🐂" color="text-emerald-600">Requerimiento de alimento (engorde)</SectionTitle>
        <p className="text-xs text-slate-400 -mt-1">Se estima con el consumo diario; ajustá cabezas, meses y consumo a tu planteo.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Cabezas en engorde" value={inp.cabezas} onChange={set("cabezas")} unit="cab" sliderMax={2000} />
          <Field label="Meses del ciclo" value={inp.mesesCiclo} onChange={set("mesesCiclo")} unit="meses" sliderMax={24} />
          <Field label="Consumo diario" value={inp.consumoKgMSdia} onChange={set("consumoKgMSdia")} unit="kg MS/día/cab" step={0.5} sliderMax={20}
            hint="Ración engorde ≈ 8-11 kg MS/día" />
          <Field label="Precio alimento comprado" value={inp.precioAlimentoComprado} onChange={set("precioAlimentoComprado")} unit="$/t MS" step={10000} sliderMax={800000} highlight
            hint={`Comprar todo ≈ ${fmtMoney(calc.costoComprar)}`} />
        </div>
        <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-3 flex flex-wrap gap-x-6 gap-y-1">
          <span className="text-xs text-emerald-700">Alimento del ciclo: <b>{fmt(calc.tonMS, 1)} t MS</b></span>
          <span className="text-xs text-emerald-700">A cosechar (con mermas): <b>{fmt(calc.tonACosechar, 1)} t</b></span>
        </div>
      </div>

      <div className="rounded-3xl p-5 bg-white border-2 border-slate-100 shadow-sm space-y-3">
        <SectionTitle icon="🌾" color="text-lime-600">Camino A — Producir forraje y darlo</SectionTitle>
        <div className="flex flex-wrap gap-2">
          {Object.keys(CULTIVOS_FORRAJE).map((id) => (
            <Pill key={id} active={inp.cultivoForraje === id} onClick={() => elegirForraje(id)}>{CULTIVOS_FORRAJE[id].label}</Pill>
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Rinde del cultivo" value={inp.rindeForraje} onChange={set("rindeForraje")} unit={CULTIVOS_FORRAJE[inp.cultivoForraje].unidad} step={0.5} sliderMax={50} />
          <Field label="Pérdidas / mermas" value={inp.perdidasPct} onChange={set("perdidasPct")} unit="%" sliderMax={30}
            hint="Confección, almacenaje y suministro" />
        </div>
        <CostEditor titulo={`Costos de producción · ${fLabel}`} lineas={inp.costosForraje} onChange={(a) => setInp((p) => ({ ...p, costosForraje: a }))} />
        <div className="rounded-2xl bg-lime-50 border border-lime-100 p-3 grid grid-cols-2 gap-2">
          <span className="text-xs text-lime-700">Costo: <b>{fmtMoney(calc.costoForrajeHa)}/ha</b></span>
          <span className="text-xs text-lime-700">Hectáreas: <b>{fmt(calc.haForraje, 1)} ha</b></span>
          <span className="text-xs text-lime-700">Costo total producción: <b>{fmtMoney(calc.costoProduccion)}</b></span>
          <span className="text-xs text-lime-700">Costo propio: <b>{fmtMoney(calc.costoPropioPorTon)}/t MS</b></span>
        </div>
      </div>

      <div className="rounded-3xl p-5 bg-white border-2 border-slate-100 shadow-sm space-y-3">
        <SectionTitle icon="💵" color="text-purple-600">Camino C — Cultivo de renta y comprar el alimento</SectionTitle>
        <p className="text-xs text-slate-400 -mt-1">Usás esas mismas {fmt(calc.haForraje, 1)} ha para un cultivo de venta y con esa plata comprás el alimento.</p>
        <div className="flex flex-wrap gap-2">
          {Object.keys(CULTIVOS_RENTA).map((id) => (
            <Pill key={id} active={inp.cultivoRenta === id} onClick={() => elegirRenta(id)}>{CULTIVOS_RENTA[id].label}</Pill>
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Rinde de renta" value={inp.rindeRenta} onChange={set("rindeRenta")} unit="t/ha" step={0.5} sliderMax={15} />
          <Field label="Precio de venta" value={inp.precioRenta} onChange={set("precioRenta")} unit="$/t" step={5000} sliderMax={1000000}
            hint="Pizarra Rosario (bruto)" />
          <Field label="Gastos comercialización" value={inp.gastosComercPct} onChange={set("gastosComercPct")} unit="%" sliderMax={30}
            hint={`Neto puerta tranquera ≈ ${fmtMoney(calc.precioNetoRenta)}/t`} />
        </div>
        <CostEditor titulo={`Costos de producción · ${rLabel}`} lineas={inp.costosRenta} onChange={(a) => setInp((p) => ({ ...p, costosRenta: a }))} defaultOpen={false} />
        <div className="rounded-2xl bg-purple-50 border border-purple-100 p-3 grid grid-cols-2 gap-2">
          <span className="text-xs text-purple-700">Costo: <b>{fmtMoney(calc.costoRentaHa)}/ha</b></span>
          <span className="text-xs text-purple-700">Ingreso venta: <b>{fmtMoney(calc.ingresoRenta)}</b></span>
          <span className="text-xs text-purple-700 col-span-2">Margen agrícola: <b>{fmtMoney(calc.margenRenta)}</b> en {fmt(calc.haForraje, 1)} ha</span>
        </div>
      </div>

      <div className="rounded-3xl p-5 bg-white border-2 border-slate-100 shadow-sm space-y-3">
        <SectionTitle icon="📊" color="text-sky-600">Referencias de mercado</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Precio novillo gordo" value={inp.precioNovilloGordo} onChange={set("precioNovilloGordo")} unit="$/kg" sliderMax={10000}
            hint={`Relación maíz/novillo: ${fmt(calc.relacionMaizNovillo, 1)}`} />
        </div>
        <p className="text-[11px] text-slate-400 leading-snug">
          Precios y costos sembrados con referencias de jun 2026 (Rosario): maíz $255.500/t · sorgo $275.000/t · soja $455.000/t. Todos los costos son editables —
          ajustalos a tus proveedores. Tu config de engorde (INMAG) valúa el pasto/mantenimiento aparte (≈ {fmtMoney(calc.costoInmagRef)}); este módulo modela la ración que les agregás.
        </p>
      </div>

      <div className="rounded-3xl p-5 bg-gradient-to-br from-slate-50 to-white border-2 border-slate-100 shadow space-y-4">
        <SectionTitle icon="🏁" color="text-emerald-700">Resultado — ¿qué conviene?</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {calc.opciones.map((o, i) => (
            <div key={o.id} className={`rounded-2xl p-4 border-2 ${i === 0 ? "border-emerald-400 bg-emerald-50" : "border-slate-100 bg-white"}`}>
              <p className="text-[11px] uppercase tracking-widest font-black" style={{ color: o.color }}>{i === 0 ? "★ Mejor" : `${i + 1}º`}</p>
              <p className="text-sm font-black text-slate-700 mt-0.5">{o.nombre}</p>
              <p className="text-xl font-mono font-black mt-1" style={{ color: o.neto >= 0 ? "#16a34a" : "#dc2626" }}>{fmtMoney(o.neto)}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">resultado de caja del ciclo</p>
            </div>
          ))}
        </div>

        <div className="rounded-2xl bg-emerald-600 text-white p-4">
          <p className="text-xs uppercase tracking-widest font-black opacity-80">Recomendación</p>
          <p className="text-base font-black mt-1">
            Conviene <span className="underline">{calc.ganador.nombre}</span>
            {calc.ganador.id === "A" ? ` (${fLabel.toLowerCase()})` : calc.ganador.id === "C" ? ` con ${rLabel.toLowerCase()}` : ""}.
          </p>
          <p className="text-xs mt-1 opacity-90">
            Le saca <b>{fmtMoney(calc.ventaja)}</b> al segundo ({calc.segundo.nombre}) en el ciclo.
            {" "}Producir forraje {calc.convieneProducir ? "le gana" : "pierde contra"} hacer renta y comprar.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-2xl bg-white border-2 border-slate-100 p-4">
            <p className="text-[11px] uppercase tracking-widest font-black text-emerald-600">Impacto en el margen del engorde</p>
            <p className="text-sm text-slate-600 mt-1">Producir en vez de comprar {calc.ahorro >= 0 ? "ahorra" : "cuesta"}:</p>
            <p className="text-lg font-mono font-black mt-0.5" style={{ color: calc.ahorro >= 0 ? "#16a34a" : "#dc2626" }}>{fmtMoney(calc.ahorro)}</p>
            <p className="text-xs text-slate-400">≈ {fmtMoney(calc.ahorroPorCab)}/cabeza de mejor margen</p>
          </div>
          <div className="rounded-2xl bg-white border-2 border-slate-100 p-4">
            <p className="text-[11px] uppercase tracking-widest font-black text-amber-600">Break-even (punto de equilibrio)</p>
            <p className="text-xs text-slate-600 mt-1">Producir empata con comprar a un rinde de <b>{fmt(calc.rindeForrajeBE, 1)} {CULTIVOS_FORRAJE[inp.cultivoForraje].unidad}</b>.</p>
            <p className="text-xs text-slate-600 mt-1">Si el alimento comprado cuesta más de <b>{fmtMoney(calc.precioCompraBE)}/t</b>, conviene producirlo.</p>
            <p className="text-xs text-slate-600 mt-1">Costo de oportunidad de la tierra (renta resignada): <b>{fmtMoney(calc.oportunidadTierra)}</b>.</p>
          </div>
        </div>

        <div className="rounded-2xl bg-white border-2 border-slate-100 p-4 overflow-x-auto">
          <p className="text-[11px] uppercase tracking-widest font-black text-slate-500 mb-2">Sensibilidad ±15% (rinde forraje · precio renta)</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-400 text-left">
                <th className="py-1 pr-2">Escenario</th>
                <th className="py-1 px-2 text-right">A · Propio</th>
                <th className="py-1 px-2 text-right">C · Renta+compra</th>
                <th className="py-1 pl-2">Gana</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {[
                { l: "Rinde −15%", d: [-0.15, 0] },
                { l: "Base",       d: [0, 0] },
                { l: "Rinde +15%", d: [0.15, 0] },
                { l: "Renta +15%", d: [0, 0.15] },
                { l: "Renta −15%", d: [0, -0.15] },
              ].map((e, i) => {
                const s = calc.escenario(e.d[0], e.d[1]);
                return (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="py-1.5 pr-2 font-sans text-slate-500">{e.l}</td>
                    <td className="py-1.5 px-2 text-right" style={{ color: s.nA >= s.nC ? "#16a34a" : "#64748b" }}>{fmtMoney(s.nA)}</td>
                    <td className="py-1.5 px-2 text-right" style={{ color: s.nC > s.nA ? "#9333ea" : "#64748b" }}>{fmtMoney(s.nC)}</td>
                    <td className="py-1.5 pl-2 font-sans font-black">{nombreCamino(s.best)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {onAgregarAlCampo && (
        <button onClick={() => onAgregarAlCampo({ categoria: "novillos", cantidad: inp.cabezas })}
          className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-black text-sm px-3 py-3 rounded-2xl transition-all active:scale-95">
          + Agregar {fmt(inp.cabezas)} cab de engorde a Mi Campo
        </button>
      )}

      <BotonGuardarSim color="lime" onToast={onToast} onGuardar={() => onGuardar({
        tab: "chacra",
        nombre: `Chacra: ${calc.ganador.nombre} · ${fmt(calc.haForraje, 1)} ha · ${fmt(inp.cabezas)} cab`,
        kpiLabel: "Mejor opción",
        kpiValue: calc.ganador.nombre,
        params: [
          { label: "Cabezas engorde", value: `${fmt(inp.cabezas)} cab` },
          { label: "Meses ciclo", value: `${fmt(inp.mesesCiclo)} meses` },
          { label: "Consumo", value: `${fmt(inp.consumoKgMSdia, 1)} kg MS/día/cab` },
          { label: "Precio alimento comprado", value: `$${fmt(inp.precioAlimentoComprado)}/t MS` },
          { label: "Forraje", value: `${fLabel} · ${fmt(inp.rindeForraje, 1)} ${CULTIVOS_FORRAJE[inp.cultivoForraje].unidad}` },
          { label: "Costo forraje", value: `${fmtMoney(calc.costoForrajeHa)}/ha` },
          { label: "Cultivo de renta", value: `${rLabel} · ${fmt(inp.rindeRenta, 1)} t/ha @ $${fmt(inp.precioRenta)}/t` },
          { label: "Costo renta", value: `${fmtMoney(calc.costoRentaHa)}/ha` },
        ],
        detalle: [
          { label: "Alimento del ciclo", value: `${fmt(calc.tonMS, 1)} t MS` },
          { label: "Hectáreas necesarias", value: `${fmt(calc.haForraje, 1)} ha` },
          { label: "A · Costo producir forraje", value: fmtMoney(calc.costoProduccion) },
          { label: "B · Costo comprar todo", value: fmtMoney(calc.costoComprar) },
          { label: "C · Margen renta − compra", value: fmtMoney(calc.netoC) },
          { label: "Ahorro producir vs comprar", value: fmtMoney(calc.ahorro) },
          { label: "Costo oportunidad tierra", value: fmtMoney(calc.oportunidadTierra) },
          { label: "Mejor camino", value: `${calc.ganador.nombre} (${fmtMoney(calc.ganador.neto)})` },
          { label: "Ventaja sobre el 2º", value: fmtMoney(calc.ventaja) },
          { label: "Costo propio del alimento", value: `${fmtMoney(calc.costoPropioPorTon)}/t MS` },
          { label: "Relación maíz/novillo", value: fmt(calc.relacionMaizNovillo, 1) },
        ],
      })} />
    </div>
  );
}

function SimuladorMenu({ onVolver, onNavigate, simulaciones, syncData }) {
  return (
    <div className="min-h-screen bg-white font-sans">
      <nav className="sticky top-0 z-50 bg-white border-b-2 border-slate-100 shadow-md simulator-enter">
        <div className="h-1 w-full bg-gradient-to-r from-violet-500 via-purple-500 to-blue-500" />
        <div className="max-w-[1100px] mx-auto px-3 sm:px-6 lg:px-8 py-2.5 flex items-center justify-between gap-3">
          <button onClick={onVolver}
            className="flex items-center gap-2.5 bg-gradient-to-r from-slate-800 to-slate-700 hover:from-slate-700 hover:to-slate-600 text-white font-black text-xs sm:text-sm px-4 py-2.5 rounded-2xl shadow-md transition-all active:scale-95 group"
            style={{transition:"all 0.2s cubic-bezier(0.34,1.56,0.64,1)"}}>
            <ArrowLeft size={18} className="transition-transform group-hover:-translate-x-1" />
            Volver al Menú
          </button>
          <div className="flex items-center gap-2.5 flex-1 justify-center min-w-0">
            <img src={`data:image/png;base64,${LOGO_B64}`} alt="SoyPekun"
              className="h-11 sm:h-14 object-contain shrink-0" style={{ maxWidth: "160px" }} />
            <div className="bg-violet-600 text-white font-black text-xs px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-sm shrink-0">
              <span>📊</span><span className="hidden sm:inline">Simulador</span>
            </div>
          </div>
          <div className="shrink-0">
            {syncData
              ? <span className="text-xs font-bold bg-emerald-100 text-emerald-700 border-2 border-emerald-200 px-3 py-1.5 rounded-full badge-pulse">Datos sincronizados ✓</span>
              : simulaciones.length > 0
              ? <span className="text-xs font-bold bg-emerald-100 text-emerald-700 border-2 border-emerald-200 px-3 py-1.5 rounded-full">{simulaciones.length} 💾</span>
              : <span className="w-16 hidden sm:inline-block" />
            }
          </div>
        </div>
      </nav>

      <div className="px-4 md:px-12 pt-8 pb-12 max-w-4xl mx-auto">
        {syncData && (
          <div className="mb-6 rounded-2xl border-2 border-emerald-200 bg-gradient-to-r from-emerald-50 to-teal-50 p-4 flex items-center gap-3 sim-zoom-enter">
            <div className="w-8 h-8 rounded-xl bg-emerald-500 flex items-center justify-center text-white shrink-0">
              <RefreshCw size={16} />
            </div>
            <div>
              <p className="text-xs font-black uppercase tracking-widest text-emerald-700">Datos sincronizados desde Mi Campo</p>
              <p className="text-xs text-emerald-600 mt-0.5">
                {syncData.cantidad} vientres · {syncData.pctDestete}% destete · {syncData.pesoTerneroDestetado} kg ternero
              </p>
            </div>
          </div>
        )}

        <p className="text-center text-slate-400 font-semibold text-xs mb-6 uppercase tracking-widest">
          Elegí el simulador
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="dash-card">
            <MenuCard
              title="Poder de Compra"
              desc="¿Si vendo X, cuántos Y puedo reponer? Triangulación con gastos comerciales incluidos."
              icon={<DollarSign size={38} className="text-white" />}
              iconAnim="float"
              color="green"
              stats={["Triangulación", "Gastos incluidos", "Relación V/C"]}
              onClick={() => onNavigate("poder")}
            />
          </div>
          <div className="dash-card">
            <MenuCard
              title="Proyecto Vientres"
              desc="ROI completo de tu rodeo de cría: costos, destete, pastoreo y rentabilidad por vientre."
              icon={<Calculator size={38} className="text-white" />}
              iconAnim="bounce"
              color="multi"
              stats={["ROI proyectado", "Costo/vientre", "Análisis IATF"]}
              onClick={() => onNavigate("vientres")}
            />
          </div>
          <div className="dash-card">
            <MenuCard
              title="Comp. Invernada"
              desc="Invernada a campo vs feedlot — encontrá la opción más rentable con análisis detallado."
              icon={<TrendingUp size={38} className="text-white" />}
              iconAnim="bounce"
              color="amber"
              stats={["Campo vs Feedlot", "Precio indiferencia", "Margen/cab"]}
              onClick={() => onNavigate("invernada")}
            />
          </div>
          <div className="dash-card">
            <MenuCard
              title="Compra de Recría"
              desc="Simulá la compra de terneros por lote, costos completos y rentabilidad al cierre."
              icon={<Scale size={38} className="text-white" />}
              iconAnim="float"
              color="blue"
              stats={["Por lotes", "Todos los costos", "Margen + ROI"]}
              onClick={() => onNavigate("recria-compra")}
            />
          </div>
          <div className="dash-card">
            <MenuCard
              title="Chacra Alimento"
              desc="¿Producís tu forraje, lo comprás, o hacés renta y comprás? Costos de cultivo completos e impacto en el engorde."
              icon={<Wheat size={38} className="text-white" />}
              iconAnim="float"
              color="green"
              stats={["Costos detallados", "Cultivo de renta", "Break-even"]}
              onClick={() => onNavigate("chacra")}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MI CAMPO — Gestión del establecimiento
// ═══════════════════════════════════════════════════════════════════════════
// ── SaveUndoBar — barra de guardar/deshacer para cada sección ────────────────
function SaveUndoBar({ onGuardar, onDeshacer, modificado }) {
  const [guardando, setGuardando] = useState(false);
  const [ok,        setOk]        = useState(false);

  const handleGuardar = async () => {
    setGuardando(true);
    try { await onGuardar(); setOk(true); setTimeout(() => setOk(false), 2000); }
    catch(e) { console.error(e); }
    finally { setGuardando(false); }
  };

  return (
    <div className={`flex items-center gap-2 p-3 rounded-2xl border-2 transition-all ${modificado ? "bg-amber-50 border-amber-200" : "bg-slate-50 border-slate-200"}`}>
      <span className={`text-xs font-bold flex-1 ${modificado ? "text-amber-700" : "text-slate-400"}`}>
        {modificado ? "⚠ Cambios sin guardar" : "✓ Sin cambios pendientes"}
      </span>
      <button onClick={onDeshacer} disabled={!modificado}
        className={`text-xs font-black px-3 py-1.5 rounded-xl border-2 transition-all active:scale-95 ${modificado ? "border-slate-300 text-slate-600 hover:bg-slate-100 cursor-pointer" : "border-slate-200 text-slate-300 cursor-not-allowed"}`}>
        ↩ Deshacer
      </button>
      <button onClick={handleGuardar} disabled={guardando}
        className={`text-xs font-black px-3 py-1.5 rounded-xl border-2 transition-all active:scale-95 ${ok ? "bg-emerald-500 border-emerald-500 text-white" : "bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700"}`}>
        {guardando ? "⟳" : ok ? "✅ Guardado" : "☁ Guardar"}
      </button>
    </div>
  );
}


function EditField({ label, value, onChange, step = 1, prefix = "", suffix = "", hint = "", usdVal = null, minVal = 0 }) {
  const [inputStr, setInputStr] = useState(null);
  const decFn = useCallback(() => { onChange(Math.max(minVal, Math.round((value - step) * 100) / 100)); setInputStr(null); }, [value, step, minVal, onChange]);
  const incFn = useCallback(() => { onChange(Math.round((value + step) * 100) / 100); setInputStr(null); }, [value, step, onChange]);
  const decLP = useLongPress(decFn, 180);
  const incLP = useLongPress(incFn, 180);
  const handleChange = (e) => {
    const raw = e.target.value;
    setInputStr(raw);
    if (raw === "" || raw === "-") return;
    const n = parseFloat(raw);
    if (!isNaN(n)) onChange(Math.max(minVal, Math.round(n * 100) / 100));
  };
  const handleBlur = () => {
    if (inputStr === "" || inputStr === null) onChange(minVal);
    setInputStr(null);
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-500 font-semibold">{label}</span>
        <div className="flex items-center gap-1.5">
          {usdVal && <span className="text-xs text-emerald-600 font-semibold">{usdVal}</span>}
          {value !== minVal && (
            <button onClick={() => { onChange(minVal); setInputStr(null); }}
              className="text-xs text-slate-400 hover:text-red-500 font-black px-1.5 py-0.5 rounded-md hover:bg-red-50 transition-all"
              title="Poner en 0">×0</button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <button {...decLP}
          className="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-900 text-white font-black text-base flex items-center justify-center shrink-0 active:scale-95 transition-all touch-manipulation select-none">−</button>
        <div className="flex-1 relative">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 pointer-events-none">{prefix}</span>
          <input
            type="number" step={step} min={minVal}
            value={inputStr !== null ? inputStr : value}
            onChange={handleChange}
            onBlur={handleBlur}
            onFocus={e => { setInputStr(String(value)); e.target.select(); }}
            className="w-full bg-slate-50 border-2 border-slate-200 rounded-xl py-1.5 text-center font-mono font-black text-base text-slate-800 focus:outline-none focus:border-emerald-400 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 pointer-events-none">{suffix}</span>
        </div>
        <button {...incLP}
          className="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-900 text-white font-black text-base flex items-center justify-center shrink-0 active:scale-95 transition-all touch-manipulation select-none">+</button>
      </div>
      {hint && <p className="text-xs text-slate-400 italic">{hint}</p>}
    </div>
  );
}

// ── VistaMovimientos — componente de nivel superior para evitar hooks en IIFE ──
function makeActs(p) {
  const { ingresoCria, ingresoRecria, ingresoTerm, sanidadCria, sanidadRec, sanidadTerm, margenCria, margenRec, margenTerm, costoReposicionTotal, costoReposicionExterna, costoReposicionPropia, cabCompradasRecria, pesoEntradaRecria, precioCompraRecria, cabPropiaRecria, cabCria, cabRec, cabTerm, cabDestetados, pesoDestete2, precioInvKg, cabRecriaSale, pesoRecria, precioNovKg, cabTermSale, pesoTerm, sanidadPorCabAnio, ingresoPastaje, kgPastaje, cabPastaje, ingresoExport, costoExport, margenExport, hiltonIngresoPesos, hiltonCostoTotal, hiltonIngresoUSD, cabHilton, ue481IngresoPesos, ue481CostoTotal, ue481IngresoUSD, cabUE481, dolarExp, terminacionDatos, fmt, fmtMoney } = p;
  const loc = (n) => (n||0).toLocaleString("es-AR");
  const feedlotCosto = (terminacionDatos?.novillosFeedlot||0)*((terminacionDatos?.costoComidaDia||0)+(terminacionDatos?.costoHoteleriaDia||0))*(terminacionDatos?.diasFeedlot||100);
  const base = [
    { id: "cria", label: "\uD83D\uDC04 Cría", cab: cabCria, color: "emerald", ingreso: ingresoCria, costo: sanidadCria, margen: margenCria,
      desglose: [
        { label: "Ingresos", tipo: "header" },
        { label: "Terneros destetados", valor: cabDestetados+" cab x "+pesoDestete2+" kg x $"+loc(precioInvKg)+"/kg", total: ingresoCria, positivo: true },
        { label: "Costos directos", tipo: "header" },
        { label: "Sanidad y nutricion", valor: cabCria+" cab x $"+loc(sanidadPorCabAnio||40000)+"/ano", total: -sanidadCria, positivo: false },
      ],
    },
    { id: "recria", label: "\uD83D\uDC02 Recría", cab: cabRec, color: "blue", ingreso: ingresoRecria, costo: costoReposicionTotal + sanidadRec, margen: margenRec,
      desglose: [
        { label: "Ingresos", tipo: "header" },
        { label: "Novillos invernada vendidos", valor: cabRecriaSale+" cab x "+pesoRecria+" kg x $"+loc(precioNovKg)+"/kg", total: ingresoRecria, positivo: true },
        { label: "Costos directos", tipo: "header" },
        ...(cabCompradasRecria ? [{ label: "Compra terneros externos", valor: cabCompradasRecria+" cab x "+pesoEntradaRecria+" kg x $"+loc(precioCompraRecria)+"/kg", total: -costoReposicionExterna, positivo: false }] : []),
        ...(cabPropiaRecria ? [{ label: "Terneros propios (costo oportunidad)", valor: cabPropiaRecria+" cab x "+pesoDestete2+" kg x $"+loc(precioInvKg)+"/kg", total: -costoReposicionPropia, positivo: false }] : []),
        { label: "Sanidad y nutricion", valor: cabRec+" cab x $"+loc(sanidadPorCabAnio||40000)+"/ano", total: -sanidadRec, positivo: false },
      ],
    },
    { id: "term", label: "\uD83E\uDD69 Terminación", cab: cabTerm, color: "amber", ingreso: ingresoTerm, costo: feedlotCosto + sanidadTerm, margen: margenTerm,
      desglose: [
        { label: "Ingresos", tipo: "header" },
        { label: "Novillos gordo", valor: cabTermSale+" cab x "+pesoTerm+" kg x $"+loc(precioNovKg)+"/kg", total: ingresoTerm, positivo: true },
        { label: "Costos directos", tipo: "header" },
        { label: "Feedlot / hoteleria", valor: (terminacionDatos?.novillosFeedlot||0)+" cab x "+(terminacionDatos?.diasFeedlot||100)+" dias", total: -feedlotCosto, positivo: false },
        { label: "Sanidad y nutricion", valor: cabTerm+" cab x $"+loc(sanidadPorCabAnio||40000)+"/ano", total: -sanidadTerm, positivo: false },
      ],
    },
    { id: "pastaje", label: "\uD83E\uDD1D Pastaje", cab: cabPastaje, color: "teal", ingreso: ingresoPastaje, costo: 0, margen: ingresoPastaje,
      desglose: [
        { label: "Ingresos", tipo: "header" },
        { label: "Cobros periodo", valor: fmt(Math.round(kgPastaje))+" kg nov devengados", total: ingresoPastaje, positivo: true },
        { label: "Costos directos", tipo: "header" },
        { label: "Sin costo directo adicional", valor: "Usa infraestructura de estructura", total: 0, positivo: false },
      ],
    },
  ];
  if (cabHilton || cabUE481) {
    const des = [];
    if (cabHilton) {
      des.push({ label: "Cuota Hilton", tipo: "header" });
      des.push({ label: cabHilton+" novillos pasto", valor: "U$S "+fmt(Math.round(hiltonIngresoUSD))+" x $"+loc(dolarExp||1395)+" (s/ret 9%)", total: hiltonIngresoPesos, positivo: true });
      des.push({ label: "Costos Hilton", valor: "Pasto + cert. SENASA", total: -hiltonCostoTotal, positivo: false });
    }
    if (cabUE481) {
      des.push({ label: "Cuota 481 UE", tipo: "header" });
      des.push({ label: cabUE481+" novillos feedlot", valor: "U$S "+fmt(Math.round(ue481IngresoUSD))+" x $"+loc(dolarExp||1395)+" (s/ret 9%)", total: ue481IngresoPesos, positivo: true });
      des.push({ label: "Racion + hoteleria + cert.", valor: "100+ dias feedlot", total: -ue481CostoTotal, positivo: false });
    }
    base.push({ id: "export", label: "\uD83C\uDF0E Exportación", cab: cabHilton+cabUE481, color: "purple", ingreso: ingresoExport, costo: costoExport, margen: margenExport, desglose: des });
  }
  return base;
}

function MargenActividad(p) {
  const { margenTotal, margenNeto, margenNetoReal, costoEstructuraAnual, amortTotal, ebitda, ebit, iibbEstimado, inmobiliario, tasas, gananciasEstimado, impuestosTotal, costoOportunidadAnual, dolar, hectareas, fmtMoney } = p;
  const [expandedAct, setExpandedAct] = React.useState(null);
  const fmt = (n) => Math.round(n).toLocaleString("es-AR");
  const usdV = (v) => dolar ? ("U$S "+fmt(Math.round(v/dolar))) : "";
  const acts = makeActs({ ...p, fmt, fmtMoney });

  const colorMap = {
    emerald: { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-700", hdr: "bg-emerald-100" },
    blue:    { bg: "bg-blue-50",    border: "border-blue-200",    text: "text-blue-700",    hdr: "bg-blue-100"    },
    amber:   { bg: "bg-amber-50",   border: "border-amber-200",   text: "text-amber-700",   hdr: "bg-amber-100"   },
    teal:    { bg: "bg-teal-50",    border: "border-teal-200",    text: "text-teal-700",    hdr: "bg-teal-100"    },
    purple:  { bg: "bg-purple-50",  border: "border-purple-200",  text: "text-purple-700",  hdr: "bg-purple-100"  },
  };

  const cascada = [
    { label: "Margen bruto total",           val: margenTotal,            sub: "Ingresos menos costos directos de cada actividad",                     color: margenTotal >= 0 ? "text-emerald-700" : "text-red-600",    bg: "bg-white",        sep: false },
    { label: "Menos costos de estructura",   val: -costoEstructuraAnual,  sub: "Empleados, maquinaria, rolado, viajes",                                color: "text-red-600",                                             bg: "bg-slate-50",     sep: false },
    { label: "= EBITDA",                     val: ebitda,                 sub: "Margen antes de amortizaciones e impuestos",                           color: ebitda >= 0 ? "text-emerald-700" : "text-red-600",         bg: "bg-slate-100",    sep: true  },
    { label: "Menos amortizaciones",         val: -amortTotal,            sub: "Mejoras, hacienda reproductora, maquinaria",                           color: "text-red-600",                                             bg: "bg-slate-50",     sep: false },
    { label: "= EBIT",                       val: ebit,                   sub: "Resultado operativo antes de impuestos",                               color: ebit >= 0 ? "text-blue-700" : "text-red-600",              bg: "bg-blue-50",      sep: true  },
    { label: "Menos impuestos estimados",    val: -impuestosTotal,        sub: "IIBB "+fmtMoney(iibbEstimado)+" | Ganancias "+fmtMoney(gananciasEstimado)+" | Otros "+fmtMoney(inmobiliario+tasas), color: "text-red-600", bg: "bg-slate-50", sep: false },
    { label: "= Margen neto",                val: margenNeto,             sub: "Resultado neto despues de impuestos",                                  color: margenNeto >= 0 ? "text-emerald-700" : "text-red-600",     bg: "bg-emerald-50",   sep: true  },
    { label: "Menos costo de oportunidad",   val: -costoOportunidadAnual, sub: "Capital inmovilizado x 5% USD vs alternativa financiera",              color: "text-orange-600",                                         bg: "bg-orange-50",    sep: false },
    { label: "= Rentabilidad economica real",val: margenNetoReal,         sub: "La ganaderia gana mas que una alternativa financiera?",                color: margenNetoReal >= 0 ? "text-emerald-800" : "text-red-700", bg: margenNetoReal >= 0 ? "bg-emerald-100" : "bg-red-50", sep: true },
  ];

  return (
    <div className="space-y-4">
      <div className="bg-white border-2 border-slate-200 rounded-3xl overflow-hidden shadow-lg">
        <div className="h-1.5 bg-gradient-to-r from-slate-400 to-slate-600" />
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-widest text-slate-600">Margen bruto por actividad</p>
              <p className="text-xs text-slate-400 mt-0.5">Ingresos menos costos directos - sin estructura ni impuestos</p>
            </div>
            <div className="text-right">
              <span className={margenTotal >= 0 ? "text-lg font-black text-emerald-700" : "text-lg font-black text-red-600"}>{fmtMoney(margenTotal)}</span>
              {dolar ? <p className="text-xs font-bold text-blue-600">{"U$S "+fmt(Math.round(margenTotal/dolar))}</p> : null}
            </div>
          </div>

          {/* ── Resumen USD/pesos ──────────────────────────────────────────── */}
          {dolar ? (
            <div className="bg-blue-50 border-2 border-blue-200 rounded-2xl p-3">
              <p className="text-xs font-black text-blue-700 mb-2">💵 Resumen en USD (dólar oficial ${fmt(Math.round(dolar))})</p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: "Margen bruto",   val: margenTotal,     color: margenTotal >= 0 ? "text-emerald-700" : "text-red-600" },
                  { label: "EBITDA",         val: ebitda,          color: ebitda >= 0 ? "text-emerald-700" : "text-red-600" },
                  { label: "Margen neto",    val: margenNeto,      color: margenNeto >= 0 ? "text-emerald-700" : "text-red-600" },
                  { label: "Rentab. real",   val: margenNetoReal,  color: margenNetoReal >= 0 ? "text-emerald-700" : "text-red-600" },
                  { label: "Margen/ha",      val: hectareas ? margenTotal / hectareas : 0, color: "text-blue-700", isPerHa: true },
                  { label: "Neto/ha",        val: hectareas ? margenNeto  / hectareas : 0, color: "text-blue-700", isPerHa: true },
                ].map((k) => (
                  <div key={k.label} className="bg-white rounded-xl px-3 py-2 flex justify-between items-center">
                    <span className="text-xs text-slate-500">{k.label}</span>
                    <span className={"font-mono font-black text-sm " + k.color}>
                      {"U$S " + fmt(Math.round(dolar ? k.val / dolar : 0)) + (k.isPerHa ? "/ha" : "")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div className="space-y-2.5">
            {acts.map((act) => {
              const pos = act.margen >= 0;
              const expanded = expandedAct === act.id;
              const c = colorMap[act.color] || colorMap.emerald;
              return (
                <div key={act.id} className={`rounded-2xl border-2 overflow-hidden ${pos ? c.bg+" "+c.border : "bg-red-50 border-red-200"}`}>
                  <button className="w-full p-3.5 text-left" onClick={() => setExpandedAct(expanded ? null : act.id)}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={pos ? "text-sm font-black "+c.text : "text-sm font-black text-red-700"}>{act.label}</span>
                        <span className="text-xs text-slate-400">{act.cab} cab</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-right">
                          <p className={pos ? "font-mono font-black text-base "+c.text : "font-mono font-black text-base text-red-600"}>{fmtMoney(act.margen)}</p>
                          {dolar && act.margen ? <p className="text-xs font-bold text-blue-600">{usdV(act.margen)}</p> : null}
                        </div>
                        <span className="text-slate-400 text-sm">{expanded ? "v" : ">"}</span>
                      </div>
                    </div>
                    {!expanded && (
                      <div className="flex gap-3 mt-1 text-xs text-slate-500">
                        <span className="text-emerald-600">{"+" + fmtMoney(act.ingreso)}</span>
                        <span className="text-red-500">{"-" + fmtMoney(Math.max(0, act.ingreso - act.margen))}</span>
                      </div>
                    )}
                  </button>
                  {expanded && (
                    <div className="px-3.5 pb-3.5 space-y-0.5 border-t border-slate-200">
                      {act.desglose.map((item, j) => {
                        if (item.tipo === "header") return (
                          <p key={j} className={"text-xs font-black uppercase tracking-widest mt-3 mb-1 px-2 py-1 rounded-lg "+c.hdr+" "+c.text}>{item.label}</p>
                        );
                        return (
                          <div key={j} className="flex items-start justify-between gap-2 py-1.5 border-b border-slate-100 last:border-0">
                            <div className="flex-1">
                              <p className="text-xs font-semibold text-slate-700">{item.label}</p>
                              {item.valor ? <p className="text-xs text-slate-400">{item.valor}</p> : null}
                            </div>
                            <div className="text-right shrink-0">
                              <span className={item.positivo ? "font-mono font-black text-sm text-emerald-700" : "font-mono font-black text-sm text-red-600"}>
                                {item.total !== 0 ? (item.positivo ? "+" : "-")+fmtMoney(Math.abs(item.total || 0)) : "—"}
                              </span>
                              {dolar && item.total !== 0 ? <p className="text-xs font-bold text-blue-600">{usdV(Math.abs(item.total || 0))}</p> : null}
                            </div>
                          </div>
                        );
                      })}
                      <div className={"mt-2 pt-2 border-t-2 border-slate-300 flex justify-between items-center px-2 py-1.5 rounded-xl "+(pos ? c.bg : "bg-red-50")}>
                        <span className="text-xs font-black uppercase tracking-wider text-slate-600">Margen bruto</span>
                        <div className="text-right">
                          <p className={pos ? "font-mono font-black text-lg "+c.text : "font-mono font-black text-lg text-red-600"}>{fmtMoney(act.margen)}</p>
                          {dolar ? <p className="text-xs text-slate-400">{usdV(act.margen)}</p> : null}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="bg-white border-2 border-slate-300 rounded-3xl overflow-hidden shadow-lg">
        <div className="h-1.5 bg-gradient-to-r from-indigo-500 to-purple-600" />
        <div className="p-5 space-y-1">
          <p className="text-xs font-black uppercase tracking-widest text-slate-600 mb-4">📉 Cascada economica</p>
          {cascada.map((row, i) => (
            <div key={i} className={"rounded-xl px-4 py-3 "+row.bg+(row.sep ? " border-t-2 border-slate-300 mt-2" : "")}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex-1">
                  <p className="text-sm font-black text-slate-800">{row.label}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{row.sub}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className={"font-mono font-black text-lg "+row.color}>{row.val >= 0 ? "" : "-"}{fmtMoney(Math.abs(row.val))}</p>
                  {dolar && Math.abs(row.val) ? <p className="text-xs font-bold text-blue-600">{usdV(Math.abs(row.val))}</p> : null}
                </div>
              </div>
            </div>
          ))}
          <div className={"mt-4 rounded-2xl p-4 border-2 "+(margenNetoReal >= 0 ? "bg-emerald-50 border-emerald-300" : "bg-red-50 border-red-300")}>
            <div className="flex items-center gap-3">
              <span className="text-2xl">{margenNetoReal >= 0 ? "✅" : "⚠️"}</span>
              <div>
                <p className={"font-black text-sm "+(margenNetoReal >= 0 ? "text-emerald-800" : "text-red-800")}>
                  {margenNetoReal >= 0
                    ? "La ganaderia supera la alternativa financiera por "+fmtMoney(margenNetoReal)+"/ano"
                    : "La ganaderia rinde "+fmtMoney(Math.abs(margenNetoReal))+"/ano MENOS que una alternativa financiera"
                  }
                </p>
                {dolar ? <p className="text-sm font-black text-blue-700 mt-1">{"= " + usdV(margenNetoReal) + " / año en USD"}</p> : null}
                {hectareas ? <p className="text-xs text-slate-500 mt-0.5">{"= "+fmtMoney(Math.round(margenNetoReal/hectareas))+"/ha/ano | "+usdV(margenNetoReal/hectareas)+"/ha/ano"}</p> : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


function VistaMovimientos({ movimientos, setMovimientos, movimientosAnio, kgVendidosTotal, ingresoVentas, costoCompras, kgHaAct, totalDestete, reciaDatos, terminacionDatos, hectareas, anoGanadero, hoy, global, onToast }) {
  const TIPOS_MOV = [
    { id: "venta-novillos",   label: "Venta novillos",        tipo: "venta",  emoji: "💚" },
    { id: "venta-vacas",      label: "Venta vacas descarte",  tipo: "venta",  emoji: "💚" },
    { id: "venta-terneros",   label: "Venta terneros",        tipo: "venta",  emoji: "💚" },
    { id: "compra-terneros",  label: "Compra terneros recría",tipo: "compra", emoji: "🔴" },
    { id: "compra-novillos",  label: "Compra novillos engorde",tipo:"compra", emoji: "🔴" },
  ];

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ tipoId: "venta-novillos", fecha: hoy, cab: 10, kgProm: 330, precioKg: global?.precioNovilloInmag ?? 1800, obs: "" });

  const agregarMovimiento = () => {
    const tipoMov = TIPOS_MOV.find(t => t.id === form.tipoId);
    const cab = Number(form.cab), kgProm = Number(form.kgProm), precioKg = Number(form.precioKg);
    const nuevo = { ...form, cab, kgProm, precioKg, id: Date.now(), tipo: tipoMov.tipo, label: tipoMov.label, anoGanadero, kgTotal: cab * kgProm, montoTotal: cab * kgProm * precioKg };
    setMovimientos(prev => [...prev, nuevo]);
    setShowForm(false);
    onToast?.(`✅ ${tipoMov.label}: ${cab} cab · $${(nuevo.montoTotal).toLocaleString("es-AR")}`, "success");
  };

  const kgProdEstimado = Math.round((totalDestete ?? 0) * 165 + ((reciaDatos?.novillos ?? 0) + (reciaDatos?.ternerosLiquidaMachos ?? 0) + (reciaDatos?.ternerosCompraMachos ?? 0)) * 320 + ((terminacionDatos?.novillosCampo ?? 0) + (terminacionDatos?.novillosFeedlot ?? 0)) * (terminacionDatos?.pesoPromedioKg ?? 420));
  const kgProdTotal = kgProdEstimado + Math.round(kgVendidosTotal);
  const kgHaTotal   = hectareas > 0 ? Math.round(kgProdTotal / hectareas) : 0;
  const margenMov   = ingresoVentas - costoCompras;
  const fmt         = (n) => Math.round(n).toLocaleString("es-AR");
  const fmtM        = (n) => "$" + Math.round(n).toLocaleString("es-AR");

  return (
    <div className="space-y-5 sim-zoom-enter">
      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "kg vendidos", value: fmt(Math.round(kgVendidosTotal)) + " kg", color: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200" },
          { label: "Ingresos ventas", value: fmtM(ingresoVentas), color: "text-emerald-800", bg: "bg-emerald-50 border-emerald-200" },
          { label: "Costo compras", value: fmtM(costoCompras), color: "text-red-700", bg: "bg-red-50 border-red-200" },
          { label: "kg/ha c/ ventas", value: kgHaTotal + " kg/ha", color: "text-sky-700", bg: "bg-sky-50 border-sky-200" },
        ].map((k, i) => (
          <div key={i} className={`rounded-2xl border-2 p-3 ${k.bg} text-center`}>
            <p className="text-xs text-slate-500 font-semibold">{k.label}</p>
            <p className={`font-black text-lg ${k.color}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Comparativo kg */}
      <div className="bg-white rounded-2xl border-2 border-slate-200 p-4">
        <p className="text-xs font-black uppercase tracking-widest text-slate-500 mb-3">📦 Producción vs ventas — {anoGanadero}</p>
        <div className="space-y-3">
          {[
            { label: "Kg producidos estimados (stock actual)", val: kgProdEstimado, color: "#3b82f6" },
            { label: "Kg vendidos registrados", val: Math.round(kgVendidosTotal), color: "#10b981" },
            { label: "Total kg campo (prod + ventas)", val: Math.round(kgProdTotal), color: "#064e3b" },
          ].map((row, i) => {
            const pct = kgProdTotal > 0 ? Math.round(row.val / kgProdTotal * 100) : 0;
            return (
              <div key={i}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-600">{row.label}</span>
                  <span className="font-black" style={{ color: row.color }}>{fmt(row.val)} kg · {pct}%</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: Math.min(100, pct) + "%", background: row.color }} />
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 pt-3 border-t border-slate-100 flex justify-between text-xs flex-wrap gap-2">
          <span className="text-slate-500">Sin ventas: <b className="text-slate-700">{hectareas > 0 ? Math.round(kgProdEstimado/hectareas) : 0} kg/ha</b></span>
          <span className="text-slate-500">Con ventas: <b className="text-sky-700">{kgHaTotal} kg/ha</b></span>
        </div>
      </div>

      {/* Balance movimientos */}
      {(ingresoVentas > 0 || costoCompras > 0) && (
        <div className={`rounded-2xl border-2 p-4 ${margenMov >= 0 ? "bg-emerald-50 border-emerald-200" : "bg-red-50 border-red-200"}`}>
          <div className="flex justify-between items-center">
            <div>
              <p className="text-xs font-black uppercase tracking-widest text-slate-500">Balance movimientos</p>
              <p className="text-xs text-slate-400 mt-0.5">Ingresos ventas − Costo compras</p>
            </div>
            <p className={`font-black text-2xl ${margenMov >= 0 ? "text-emerald-700" : "text-red-700"}`}>{fmtM(margenMov)}</p>
          </div>
        </div>
      )}

      {/* Botón agregar */}
      <button onClick={() => setShowForm(s => !s)}
        className="w-full py-3 rounded-2xl border-2 border-dashed border-emerald-300 text-emerald-700 font-black text-sm hover:bg-emerald-50 transition-all">
        {showForm ? "✕ Cancelar" : "+ Registrar movimiento"}
      </button>

      {/* Formulario */}
      {showForm && (
        <div className="bg-white rounded-2xl border-2 border-emerald-200 p-4 space-y-4">
          <p className="text-xs font-black uppercase tracking-widest text-slate-500">Nuevo movimiento</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-bold text-slate-500">Tipo</label>
              <select value={form.tipoId} onChange={e => setForm(p => ({...p, tipoId: e.target.value}))}
                className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400">
                {TIPOS_MOV.map(t => <option key={t.id} value={t.id}>{t.emoji} {t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-bold text-slate-500">Fecha</label>
              <input type="date" value={form.fecha} onChange={e => setForm(p => ({...p, fecha: e.target.value}))}
                className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400" />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-500">Cabezas</label>
              <input type="number" min="1" value={form.cab} onChange={e => setForm(p => ({...p, cab: e.target.value}))}
                className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400" />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-500">Peso promedio (kg/cab)</label>
              <input type="number" min="1" value={form.kgProm} onChange={e => setForm(p => ({...p, kgProm: e.target.value}))}
                className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400" />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-500">Precio ($/kg vivo)</label>
              <input type="number" min="1" value={form.precioKg} onChange={e => setForm(p => ({...p, precioKg: e.target.value}))}
                className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400" />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-500">Total estimado</label>
              <div className="mt-1 w-full border-2 border-slate-100 rounded-xl px-3 py-2 text-sm bg-slate-50 font-black text-emerald-700">
                {fmtM(Number(form.cab) * Number(form.kgProm) * Number(form.precioKg))}
              </div>
            </div>
            <div className="sm:col-span-2">
              <label className="text-xs font-bold text-slate-500">Observaciones (opcional)</label>
              <input type="text" value={form.obs} onChange={e => setForm(p => ({...p, obs: e.target.value}))} placeholder="Ej: Feria Liniers, Campo La Loma…"
                className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400" />
            </div>
          </div>
          <button onClick={agregarMovimiento}
            className="w-full py-2.5 bg-emerald-600 text-white font-black rounded-xl hover:bg-emerald-700 transition-all active:scale-95">
            ✅ Guardar movimiento
          </button>
        </div>
      )}

      {/* Lista */}
      {movimientosAnio.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-black uppercase tracking-widest text-slate-500">Movimientos {anoGanadero}</p>
          {[...movimientosAnio].sort((a,b) => (b.fecha ?? "").localeCompare(a.fecha ?? "")).map(m => {
            const tipoInfo = TIPOS_MOV.find(t => t.id === m.tipoId) ?? {};
            const esVenta = m.tipo === "venta";
            return (
              <div key={m.id} className={`rounded-2xl border-2 p-3 flex items-center gap-3 ${esVenta ? "bg-emerald-50 border-emerald-200" : "bg-red-50 border-red-200"}`}>
                <span className="text-2xl">{tipoInfo.emoji ?? (esVenta ? "💚" : "🔴")}</span>
                <div className="flex-1 min-w-0">
                  <p className="font-black text-sm text-slate-800">{m.label}</p>
                  <p className="text-xs text-slate-500 truncate">{m.fecha} · {m.cab} cab · {fmt(m.kgProm)} kg/cab · ${fmt(m.precioKg)}/kg</p>
                  {m.obs && <p className="text-xs text-slate-400 italic truncate">{m.obs}</p>}
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs text-slate-400">{fmt(Math.round(m.kgTotal))} kg</p>
                  <p className={`font-black text-sm ${esVenta ? "text-emerald-700" : "text-red-700"}`}>{esVenta ? "+" : "−"}{fmtM(m.montoTotal)}</p>
                </div>
                <button onClick={() => { if (window.confirm("¿Eliminar este movimiento?")) setMovimientos(prev => prev.filter(x => x.id !== m.id)); }}
                  className="text-slate-300 hover:text-red-500 font-black transition-colors shrink-0">✕</button>
              </div>
            );
          })}
        </div>
      )}

      {movimientosAnio.length === 0 && !showForm && (
        <div className="text-center py-10 text-slate-400">
          <p className="text-3xl mb-2">🔄</p>
          <p className="text-sm font-semibold">Sin movimientos en {anoGanadero}</p>
          <p className="text-xs mt-1">Registrá ventas y compras para que impacten en el rendimiento kg/ha</p>
        </div>
      )}
    </div>
  );
}

// top-level helpers — avoid JSX parser conflict and TDZ issues inside MiCampo
function calcMesesHastaJunio(mes, anio) {
  const paricion   = new Date(anio, mes, 1);
  const cierreAnio = paricion.getMonth() >= 6 ? paricion.getFullYear() + 1 : paricion.getFullYear();
  const cierre     = new Date(cierreAnio, 5, 30);
  const diff       = (cierre - paricion) / (1000 * 60 * 60 * 24 * 30);
  return Math.max(0, Math.round(diff));
}

function calcLote(offset, paricionMes, paricionAnio, ternNacidosVivos, pesoNacimiento, gdpTernero, meseDestete, MESES_ES) {
  const mes      = (paricionMes + offset) % 12;
  const anio     = (paricionMes + offset) < 12 ? paricionAnio : paricionAnio + 1;
  const mCierre  = calcMesesHastaJunio(mes, anio);
  const cabLote  = Math.round(ternNacidosVivos / 3);
  const acumMensual = Array.from({ length: Math.min(mCierre, 12) }, function(_, i) {
    return {
      mes: MESES_ES[(mes + i) % 12],
      diasAcum:    (i + 1) * 30,
      kgPorCab:    Math.round(pesoNacimiento + (i + 1) * 30 * gdpTernero),
      kgTotales:   Math.round(cabLote * (pesoNacimiento + (i + 1) * 30 * gdpTernero)),
      esMesDestete:(i + 1) === meseDestete,
    };
  });
  const kgAlDestete = Math.round(pesoNacimiento + meseDestete * 30 * gdpTernero);
  const kgAlCierre  = mCierre < meseDestete ? kgAlDestete : Math.round(pesoNacimiento + mCierre * 30 * gdpTernero);
  return { mes, anio, mCierre, cabLote, acumMensual, kgAlDestete, kgAlCierre };
}

function calcTablaAcum(mesesHastaCierre, paricionMes, pesoNacimiento, gdpTernero, gdpNovilloInv, gdpNovilloFaena, meseDestete, MESES_ES) {
  const len = Math.min(mesesHastaCierre, 12);
  const result = [];
  for (let i = 0; i !== len; i++) {
    const m = i + 1;
    result.push({
      mes: MESES_ES[(paricionMes + i) % 12],
      kgTernero:    Math.round(pesoNacimiento + m * 30 * gdpTernero),
      kgNovilloInv: Math.round(pesoNacimiento + m * 30 * gdpNovilloInv),
      kgNovFaena:   Math.round(pesoNacimiento + m * 30 * gdpNovilloFaena),
      esMesDestete: m === meseDestete,
    });
  }
  return result;
}

function calcHistorialKgHa(historialAnos, pVacaDescarte, pTerneroInvernada, pNovilloInvernada, pNovilloFaena, hectareas, anoGanadero, kgHaAct, kgTotalAct, kgHaProx, kgTotalProx) {
  const entries = Object.entries(historialAnos || {}).sort();
  const result = entries.map(function(entry) {
    const ano = entry[0]; const snap = entry[1];
    const cr = snap.cria        || {};
    const re = snap.recria      || {};
    const te = snap.terminacion || {};
    const madresCr = (cr.vacas || 0) + (cr.vaquillonas || 0);
    const descCr   = cr.vacias || Math.max(0, madresCr - Math.round(madresCr * 0.85));
    const kg = descCr * pVacaDescarte + (re.ternerosLiquidaMachos || 0) * pTerneroInvernada + (re.novillos || 0) * pNovilloInvernada + ((te.novillosCampo || 0) + (te.novillosFeedlot || 0)) * pNovilloFaena;
    return { ano: ano.slice(0, 4), tipo: "real", kgHa: hectareas ? Math.round(kg / hectareas) : 0, kg: kg };
  });
  result.push({ ano: anoGanadero.slice(0, 4), tipo: "real",       kgHa: kgHaAct,  kg: kgTotalAct  });
  result.push({ ano: "Proy.",                 tipo: "proyectado", kgHa: kgHaProx, kg: kgTotalProx });
  return result;
}

// ── Asesor Ganadero IA ────────────────────────────────────────────────────────
// Llama a la API de Anthropic con el contexto del campo o simulador
function AsesorIA({ contexto, titulo, placeholder, color = "emerald" }) {
  const [open,     setOpen]     = React.useState(false);
  const [pregunta, setPregunta] = React.useState("");
  const [respuesta,setRespuesta]= React.useState("");
  const [loading,  setLoading]  = React.useState(false);
  const [error,    setError]    = React.useState("");

  const COLORS = {
    emerald: { btn: "bg-emerald-600 hover:bg-emerald-700", border: "border-emerald-300", bg: "bg-emerald-50", text: "text-emerald-800" },
    amber:   { btn: "bg-amber-500 hover:bg-amber-600",     border: "border-amber-300",   bg: "bg-amber-50",   text: "text-amber-800"   },
    blue:    { btn: "bg-blue-600 hover:bg-blue-700",       border: "border-blue-300",     bg: "bg-blue-50",    text: "text-blue-800"    },
    violet:  { btn: "bg-violet-600 hover:bg-violet-700",   border: "border-violet-300",  bg: "bg-violet-50",  text: "text-violet-800"  },
  };
  const c = COLORS[color] || COLORS.emerald;

  const consultar = async () => {
    if (!pregunta.trim() && !contexto) return;
    setLoading(true);
    setRespuesta("");
    setError("");
    try {
      const sistemaPrompt = `Sos un asesor ganadero experto en ganadería vacuna argentina. 
Analizás datos reales del campo y dás recomendaciones concretas, prácticas y directas.
Usás números cuando es relevante. Hablás en castellano argentino.
Sos directo — primero el veredicto, después el análisis. Máximo 250 palabras.`;

      const mensajeUsuario = contexto
        ? `DATOS DEL CAMPO:\n${contexto}\n\n${pregunta ? `CONSULTA: ${pregunta}` : "Dame tu análisis y veredicto sobre estos datos."}`
        : pregunta;

      const response = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          system: sistemaPrompt,
          messages: [{ role: "user", content: mensajeUsuario }],
        }),
      });
      const data = await response.json();
      const texto = data?.content?.[0]?.text ?? "";
      if (!texto) throw new Error(data?.error?.message || "Sin respuesta");
      setRespuesta(texto);
    } catch (e) {
      setError("Error al consultar: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  if (!open) return (
    <button onClick={() => setOpen(true)}
      className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl text-white text-xs font-black transition-all active:scale-95 shadow-md ${c.btn}`}>
      🤖 Consultá al asesor IA
    </button>
  );

  return (
    <div className={`border-2 rounded-3xl overflow-hidden ${c.border}`}>
      <div className={`px-4 py-3 flex items-center justify-between ${c.bg}`}>
        <div className="flex items-center gap-2">
          <span className="text-xl">🤖</span>
          <div>
            <p className={`text-xs font-black uppercase tracking-widest ${c.text}`}>Asesor Ganadero IA</p>
            {titulo && <p className="text-xs text-slate-500">{titulo}</p>}
          </div>
        </div>
        <button onClick={() => { setOpen(false); setRespuesta(""); setPregunta(""); }}
          className="text-slate-400 hover:text-slate-600 font-black text-sm px-2">✕</button>
      </div>

      {/* Contexto automático */}
      {contexto && (
        <div className="px-4 py-2 bg-slate-50 border-b border-slate-100">
          <p className="text-xs text-slate-400 font-semibold">📊 Datos enviados al asesor:</p>
          <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{contexto.slice(0, 150)}...</p>
        </div>
      )}

      <div className="p-4 space-y-3">
        {/* Input de pregunta */}
        <div>
          <textarea
            value={pregunta}
            onChange={e => setPregunta(e.target.value)}
            placeholder={placeholder || "¿Qué querés saber? (opcional — si no escribís nada, el asesor analiza los datos automáticamente)"}
            rows={2}
            className={`w-full border-2 ${c.border} rounded-xl px-3 py-2 text-sm focus:outline-none resize-none`}
          />
        </div>

        <button onClick={consultar} disabled={loading}
          className={`w-full py-2.5 rounded-xl text-white text-sm font-black transition-all active:scale-95 disabled:opacity-60 ${c.btn}`}>
          {loading ? "⏳ Analizando..." : "🔍 Analizar"}
        </button>

        {/* Respuesta */}
        {respuesta && (
          <div className={`${c.bg} border ${c.border} rounded-2xl p-4`}>
            <p className={`text-xs font-black uppercase tracking-widest ${c.text} mb-3`}>📋 Análisis del asesor</p>
            <div className="text-sm text-slate-700 leading-relaxed space-y-2">
              {respuesta.split('\n').map((line, i) => {
                if (!line.trim()) return <div key={i} className="h-1" />;
                // H3 ###
                if (line.startsWith('### ')) return <h3 key={i} className="font-black text-slate-800 text-base mt-3 mb-1">{line.replace('### ','')}</h3>;
                // H2 ##
                if (line.startsWith('## ')) return <h2 key={i} className="font-black text-slate-900 text-lg mt-3 mb-1 border-b border-slate-200 pb-1">{line.replace('## ','')}</h2>;
                // H1 #
                if (line.startsWith('# ')) return <h1 key={i} className="font-black text-slate-900 text-xl mt-3 mb-2">{line.replace('# ','')}</h1>;
                // List item -
                if (line.startsWith('- ') || line.startsWith('* ')) {
                  const content = line.replace(/^[-*] /, '').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
                  return <div key={i} className="flex gap-2 items-start"><span className={`${c.text} font-black mt-0.5`}>•</span><span dangerouslySetInnerHTML={{__html: content}} /></div>;
                }
                // Numbered list
                if (/^\d+\./.test(line)) {
                  const content = line.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
                  return <div key={i} className="flex gap-2 items-start"><span className={`${c.text} font-black min-w-[20px]`}>{line.match(/^\d+/)[0]}.</span><span dangerouslySetInnerHTML={{__html: content.replace(/^\d+\.\s*/,'')}} /></div>;
                }
                // Warning ⚠️
                if (line.includes('⚠️') || line.includes('Atención')) {
                  const content = line.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
                  return <div key={i} className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-amber-800 text-sm" dangerouslySetInnerHTML={{__html: content}} />;
                }
                // Separator ---
                if (/^-{3,}$/.test(line.trim())) return <hr key={i} className="border-slate-200 my-2" />;
                // Normal paragraph with bold
                const content = line.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
                return <p key={i} dangerouslySetInnerHTML={{__html: content}} />;
              })}
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3">
            <p className="text-xs text-red-600 font-bold">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function MiCampo({ onVolver, onSincronizar, cria, setCria, recria, setRecria, terminacion, setTerminacion, anoGanadero, historialAnos, onCerrarAno, campoPastaje, setCampoPastaje, precioNovilloGlobal, movimientos = [], setMovimientos, onToast }) {
  const global = useGlobal();
  const [seccion,    setSeccion]    = useState("stock");
  const [subStock,   setSubStock]   = useState(null);

  // ── Snapshots para deshacer por sección ──────────────────────────────────
  const [snapCria,       setSnapCria]       = useState(null);
  const [snapRecria,     setSnapRecria]     = useState(null);
  const [snapTerminacion,setSnapTerminacion]= useState(null);
  const [snapGastos,     setSnapGastos]     = useState(null);
  const [snapGlobal,     setSnapGlobal]     = useState(null);
  const [snapCampo,      setSnapCampo]      = useState(null);

  const entrarCria       = () => { setSnapCria(JSON.parse(JSON.stringify(cria)));        setSubStock("cria"); };
  const entrarRecria     = () => { setSnapRecria(JSON.parse(JSON.stringify(recria)));    setSubStock("recria"); };
  const entrarTerminacion= () => { setSnapTerminacion(JSON.parse(JSON.stringify(terminacion))); setSubStock("terminacion"); };

  const deshacerCria       = () => { if (snapCria)        { setCria(snapCria);               setSnapCria(null); } };
  const deshacerRecria     = () => { if (snapRecria)      { setRecria(snapRecria);            setSnapRecria(null); } };
  const deshacerTerminacion= () => { if (snapTerminacion) { setTerminacion(snapTerminacion);  setSnapTerminacion(null); } };
  const deshacerGastos     = () => { if (snapGastos)      { vacaStore.getState().setGastos(snapGastos);  setSnapGastos(null); } };
  const deshacerGlobal     = () => { if (snapGlobal)      { vacaStore.getState().setGlobal(snapGlobal);  setSnapGlobal(null); } };
  const deshacerCampo      = () => { if (snapCampo)       { vacaStore.getState().setCampo(snapCampo);    setSnapCampo(null); } };

  const handleSetSeccion = (id) => {
    const g = vacaStore.getState();
    if (id === "costos") {
      setSnapGastos(JSON.parse(JSON.stringify(vacaStore.getState().gastos)));
      setSnapCampo(JSON.parse(JSON.stringify(vacaStore.getState().campo)));
    }
    if (id === "rendimiento")   setSnapGlobal(JSON.parse(JSON.stringify(g.global)));
    if (id === "config")        setSnapGlobal(JSON.parse(JSON.stringify(g.global)));
    if (id === "stock")         { setSnapCria(null); setSnapRecria(null); setSnapTerminacion(null); }
    setSeccion(id);
    setSubStock(null);
  };
  const [verHistorial, setVerHistorial] = useState(false);
  const [anoViendo, setAnoViendo]   = useState(null);
  // Modal venta state

  // ── Cotizaciones globales ─────────────────────────────────────────────────
  // ── Estado del campo desde el store (persiste en Firestore) ──────────────
  const campoStore = useStore(vacaStore, s => s.campo);
  const setCampoStore = (p) => vacaStore.getState().setCampo(p);

  const dolar              = campoStore.dolar;
  const gasoil             = campoStore.gasoil;
  const setDolar           = (v) => setCampoStore({ dolar: v });
  const setGasoil          = (v) => setCampoStore({ gasoil: v });
  const hectareas          = campoStore.hectareas;
  const setHectareas       = (v) => setCampoStore({ hectareas: v });
  const gdpTernero         = campoStore.gdpTernero;
  const setGdpTernero      = (v) => setCampoStore({ gdpTernero: v });
  const gdpNovilloInv      = campoStore.gdpNovilloInv;
  const setGdpNovilloInv   = (v) => setCampoStore({ gdpNovilloInv: v });
  const gdpNovilloFaena    = campoStore.gdpNovilloFaena;
  const setGdpNovilloFaena = (v) => setCampoStore({ gdpNovilloFaena: v });
  const gdpVaquillonaDesc  = campoStore.gdpVaquillonaDesc;
  const setGdpVaquillonaDesc = (v) => setCampoStore({ gdpVaquillonaDesc: v });
  const empleados          = campoStore.empleados;
  const setEmpleados       = (fn) => setCampoStore({ empleados: typeof fn === "function" ? fn(campoStore.empleados) : fn });
  const maquinaria         = campoStore.maquinaria;
  const setMaquinaria      = (p) => setCampoStore({ maquinaria: { ...campoStore.maquinaria, ...(typeof p === "function" ? p(campoStore.maquinaria) : p) } });
  const roladoState        = campoStore.rolado;
  const setRolado          = (p) => setCampoStore({ rolado: { ...campoStore.rolado, ...(typeof p === "function" ? p(campoStore.rolado) : p) } });
  const viajesState        = campoStore.viajes;
  const setViajes          = (p) => setCampoStore({ viajes: { ...campoStore.viajes, ...(typeof p === "function" ? p(campoStore.viajes) : p) } });

  const setEmp = (i, k) => (v) => setEmpleados(prev => prev.map((e, idx) => idx === i ? {...e, [k]: v} : e));

  const usd = (pesos) => pesos > 0 ? `U$D ${fmt(Math.round(pesos / dolar))}` : "—";

  // Si estamos viendo un año histórico, usar esos datos (read-only)
  const stockActivo = anoViendo ? historialAnos[anoViendo] : null;
  const criaDatos       = stockActivo ? stockActivo.cria       : cria;
  const reciaDatos      = stockActivo ? stockActivo.recria     : recria;
  const terminacionDatos = stockActivo ? stockActivo.terminacion : terminacion;
  const setCriaActiva   = anoViendo ? () => {} : setCria;
  const setRecriaActiva = anoViendo ? () => {} : setRecria;
  const setTermActiva   = anoViendo ? () => {} : setTerminacion;

  // ── Helpers para ciclos de parición ──────────────────────────────────────
  const ciclos = criaDatos.ciclos ?? [{
    id: "ciclo_legacy",
    servicio: "primavera",
    paricionMes: criaDatos.paricionMes ?? 9,
    paricionAnio: criaDatos.paricionAnio ?? new Date().getFullYear() - 1,
    mesesDestete: criaDatos.mesesDestete ?? 6,
    pctPreniez: criaDatos.pctPreniez ?? 85,
    pctDestete: criaDatos.pctDestete ?? 75,
    pesoDesteteKg: criaDatos.pesoDesteteKg ?? 187,
    ternerosAlPie: totalTernerosAlPie ?? 0,
    estado: (totalTernerosAlPie ?? 0) > 0 ? "al_pie" : "al_pie",
    ternerosDestetados: criaDatos.ternerosDestetados ?? 0,
    fechaDesteReal: null,
  }];

  // Compatibilidad con código viejo que usa estas variables
  const paricionMes  = ciclos[0]?.paricionMes  ?? 9;
  const paricionAnio = ciclos[0]?.paricionAnio ?? new Date().getFullYear() - 1;
  const mesesDestete = ciclos[0]?.mesesDestete ?? 6;
  // gdpTernero ya definido arriba desde campoStore

  // Total terneros al pie (suma de todos los ciclos)
  const totalTernerosAlPie = ciclos.reduce((s, c) => s + (c.ternerosAlPie ?? 0), 0);

  // Total terneros destetados (para rendimiento — solo ciclos estado "destetado")
  const totalTernerosDestetados = ciclos
    .filter(c => c.estado === "destetado")
    .reduce((s, c) => s + (c.ternerosDestetados ?? 0), 0);

  // Peso destete promedio ponderado
  const pesoDestete2 = ciclos.length > 0
    ? Math.round(ciclos.reduce((s, c) => s + (c.pesoDesteteKg ?? 187) * (c.ternerosDestetados || c.ternerosAlPie || 1), 0)
        / ciclos.reduce((s, c) => s + (c.ternerosDestetados || c.ternerosAlPie || 1), 0))
    : (criaDatos.pesoDesteteKg ?? 187);

  // ── Costos estructura detallados ──────────────────────────────────────────
  const costoMensualEmpleado = (e) => {
    const bruto = e.sueldo * e.cantidad;
    const cs    = bruto * (e.cargasSociales / 100);
    const ag    = e.aguinaldo ? bruto / 12 : 0;
    return bruto + cs + ag + e.premio * e.cantidad;
  };
  const totalEmpleadosMes  = empleados.reduce((a, e) => a + costoMensualEmpleado(e), 0);
  const costoMaqMes        = maquinaria.tractores * maquinaria.mantenimientoMes;
  const costoGasoilRolado  = roladoState.hectareas * roladoState.litrosGasoilHa * gasoil;
  const costoSiembra       = roladoState.siembraHa * roladoState.costoSiembraHa;
  const costoRoladoAnual   = costoGasoilRolado + costoSiembra;
  const costoRoladoMes     = costoRoladoAnual / 12;
  const litrosTotalesMes   = viajesState.viajesAlMes * viajesState.kmPorViaje * (viajesState.litrosCada100 / 100);
  const costoViajesMes     = litrosTotalesMes * gasoil;

  const totalStockCampo = criaDatos.vacas + (criaDatos.vaquillonas1??criaDatos.vaquillonas??0) + (criaDatos.vaquillonas2??0) + totalTernerosAlPie + criaDatos.toros
    + (criaDatos.vacaCut??0) + (criaDatos.vaqRechazo??0)
    + reciaDatos.ternerosLiquidaMachos + reciaDatos.ternerosLiquidaHembras + reciaDatos.ternerosCompraMachos + reciaDatos.ternerosCompraHembras + reciaDatos.novillos
    + (reciaDatos.vaquillonaRecria??0) + (reciaDatos.mej??0)
    + terminacionDatos.novillosCampo + terminacionDatos.novillosFeedlot
    + (terminacionDatos.mejTerminacion??0) + (terminacionDatos.vacaEngorde??0) + (terminacionDatos.vaqEngorde??0);

  // ── Movimientos del año ───────────────────────────────────────────────────
  const movimientosAnio = movimientos.filter(m => m.anoGanadero === anoGanadero || !m.anoGanadero);
  const ventas   = movimientosAnio.filter(m => m.tipo === "venta");
  const compras  = movimientosAnio.filter(m => m.tipo === "compra");
  const kgVendidosTotal  = ventas.reduce((s, m) => s + (m.cab * m.kgProm), 0);
  const kgCompradosTotal = compras.reduce((s, m) => s + (m.cab * m.kgProm), 0);
  const ingresoVentas    = ventas.reduce((s, m) => s + (m.cab * m.kgProm * m.precioKg), 0);
  const costoCompras     = compras.reduce((s, m) => s + (m.cab * m.kgProm * m.precioKg), 0);

  // ── EV/ha — Equivalente Vaca por hectárea ─────────────────────────────────
  // Coeficientes EV estándar (INTA): vaca cría con ternero = 1, toro = 1.3,
  // vaquillona reposición = 0.85, novillo terminación = 1.0, ternero destetado = 0.55
  const totalEV = (criaDatos.vacas ?? 0) * 1.0
    + ((criaDatos.vaquillonas1??criaDatos.vaquillonas??0) + (criaDatos.vaquillonas2??0)) * 0.85
    + (criaDatos.toros ?? 0) * 1.3
    + (totalTernerosAlPie ?? 0) * 0.55
    + (criaDatos.vacias ?? 0) * 1.0
    + (reciaDatos.ternerosLiquidaMachos ?? 0) * 0.7
    + (reciaDatos.ternerosLiquidaHembras ?? 0) * 0.7
    + (reciaDatos.ternerosCompraMachos ?? 0) * 0.7
    + (reciaDatos.ternerosCompraHembras ?? 0) * 0.7
    + (reciaDatos.novillos ?? 0) * 0.95
    + (terminacionDatos.novillosCampo ?? 0) * 1.0;
  // EV en feedlot no cuenta porque no consume del campo

  // ── EV pastaje — animales de terceros que pastan en el campo ─────────────
  const EV_CAT = { vacas: 1.0, toros: 1.3, terneros: 0.55, terneras: 0.55, recria: 0.7 };
  const evPastaje = (campoPastaje?.tropas ?? []).reduce((s, t) => {
    const cab = t.cabActual ?? t.cab ?? 0;
    const ev  = EV_CAT[t.cat] ?? 0.7;
    return s + cab * ev;
  }, 0);

  const evTotal   = totalEV + evPastaje;
  const evPorHa   = hectareas > 0 ? evTotal  / hectareas : 0;
  const evPropHa  = hectareas > 0 ? totalEV  / hectareas : 0;
  const evPastHa  = hectareas > 0 ? evPastaje / hectareas : 0;

  // ── Sanidad — costo $/mes ─────────────────────────────────────────────────
  const sanidadAnual = totalStockCampo * (campoStore.sanidadPorCabAnio ?? 40000);
  const sanidadMes   = sanidadAnual / 12;

  // ── Costo de oportunidad del capital invertido en hacienda ───────────────
  const valorRodeo = totalStockCampo * (global.valorCabPromedio ?? 1500000);
  // Tasa USD anual → convertir a pesos vía dólar y aplicar
  const costoOportunidadAnual = valorRodeo * ((global.tasaOportunidadUSD ?? 5) / 100);
  const costoOportunidadMes   = costoOportunidadAnual / 12;

  // ── Margen bruto por actividad ────────────────────────────────────────────
  // Cría: produce terneros para destete, ingreso = peso destete × cab × precio nov × factor
  const precioNovKg     = global.precioNovilloInmag ?? 1800;
  const precioInvKg     = global.precioInvernada    ?? 1600;  // terneros/invernada
  // Terneros destetados reales vs proyección:
  const cabDestetados = totalTernerosDestetados > 0
    ? totalTernerosDestetados   // hay ciclos ya destetados → usar real
    : totalTernerosAlPie > 0
      ? 0                        // hay terneros al pie sin destetar → ingreso = 0
      : Math.round((criaDatos.vacas + (criaDatos.vaquillonas1??criaDatos.vaquillonas??0) + (criaDatos.vaquillonas2??0)) * ((ciclos[0]?.pctDestete ?? criaDatos.pctDestete ?? 75) / 100)); // proyección
  // pesoDestete2 ya definido arriba desde ciclos // kg al destete — editable en Stock → Cría
  const ingresoCria     = cabDestetados * pesoDestete2 * precioInvKg;   // terneros al destete → precio invernada

  // Recría: produce novillos invernada, ingreso = peso × cab × precio invernada
  const cabRecriaSale   = Math.round((reciaDatos.ternerosLiquidaMachos + reciaDatos.ternerosCompraMachos + reciaDatos.novillos) * (1 - (reciaDatos.pctMortandadRecria ?? 2) / 100));
  const pesoRecria      = 320; // promedio salida recría
  const ingresoRecria   = cabRecriaSale * pesoRecria * precioNovKg;     // novillos invernada → precio novillo gordo

  // Terminación: cab × peso final × precio
  const cabTermSale     = (terminacionDatos.novillosCampo ?? 0) + (terminacionDatos.novillosFeedlot ?? 0);
  const pesoTerm        = terminacionDatos.pesoPromedioKg ?? 420;
  const ingresoTerm     = cabTermSale * pesoTerm * precioNovKg;

  // Costos asignados (proporcional al stock de cada actividad)
  const cabCria  = (criaDatos.vacas + (criaDatos.vaquillonas1??criaDatos.vaquillonas??0) + (criaDatos.vaquillonas2??0) + criaDatos.toros + totalTernerosAlPie + (criaDatos.vacias ?? 0) + (criaDatos.vacaCut??0) + (criaDatos.vaqRechazo??0));
  const cabRec   = reciaDatos.ternerosLiquidaMachos + reciaDatos.ternerosLiquidaHembras + reciaDatos.ternerosCompraMachos + reciaDatos.ternerosCompraHembras + reciaDatos.novillos + (reciaDatos.vaquillonaRecria??0) + (reciaDatos.mej??0);
  const cabTerm  = cabTermSale;
  const totalCabAct = Math.max(1, cabCria + cabRec + cabTerm);
  const costoTotalAnual = (totalEmpleadosMes + costoMaqMes + costoRoladoMes + costoViajesMes + sanidadMes) * 12;
  const costoCriaAnual  = costoTotalAnual * (cabCria / totalCabAct);
  const costoRecAnual   = costoTotalAnual * (cabRec  / totalCabAct);
  const costoTermAnual  = costoTotalAnual * (cabTerm / totalCabAct);
  // Terminación suma costo de comida y hotelería específico
  const costoFeedlotAnual = (terminacionDatos.novillosFeedlot ?? 0) * ((terminacionDatos.costoComidaDia ?? 0) + (terminacionDatos.costoHoteleriaDia ?? 0)) * (terminacionDatos.diasFeedlot ?? 100);

  // ── Ingreso pastaje (debe calcularse ANTES del margen bruto) ─────────────
  const periodosPastaje = campoPastaje?.periodos ?? [];
  const cobrosPastaje   = periodosPastaje.filter(p => p.tipo === "cobro-periodo");
  const ingresoPastaje  = cobrosPastaje.reduce((s, p) => s + (p.totalPesos ?? p.pesos ?? 0), 0);
  const kgPastaje       = cobrosPastaje.reduce((s, p) => s + (p.kgTotal ?? 0), 0);
  const cabPastaje      = campoPastaje?.tropas?.reduce((s, t) => s + (t.cabActual ?? t.cab ?? 0), 0) ?? 0;

  // ── Kg reales producidos por tropas de pastaje en el campo ───────────────
  // Solo terneros (cat=terneras) y recría (cat=recria) generan carne en el campo
  // Fórmula: cab × gdpEstimado × días en campo
  const hoyStr = new Date().toISOString().slice(0, 10);
  const tropas = campoPastaje?.tropas ?? [];
  const diasEntrePast = (desde, hasta) => {
    if (!desde) return 0;
    const d1 = new Date(desde); const d2 = new Date(hasta ?? hoyStr);
    return Math.max(0, Math.round((d2 - d1) / 86400000));
  };
  const kgPastajeProducidos = tropas
    .filter(t => t.cat === "terneras" || t.cat === "terneros" || t.cat === "recria")
    .reduce((s, t) => {
      const cab  = t.cabActual ?? t.cab ?? 0;
      const gdp  = parseFloat(t.gdpEstimado ?? (t.cat === "terneras" || t.cat === "terneros" ? 0.6 : 0.5)) || 0;
      const dias = diasEntrePast(t.fechaIngreso, hoyStr);
      return s + cab * gdp * dias;
    }, 0);
  const kgHaPastaje = hectareas ? Math.round(kgPastajeProducidos / hectareas) : 0;

  // ── Reposicion recria (ANTES del margen bruto) ─────────────────────────
  const cabCompradasRecria  = reciaDatos.cabCompradasRecria  ?? 0;
  const precioCompraRecria  = reciaDatos.precioCompraKgRecria ?? 0;
  const pesoEntradaRecria   = reciaDatos.pesoEntradaRecria   ?? 180;
  // Costo compra externa: cab × kg entrada × precio compra
  const costoReposicionExterna = cabCompradasRecria * pesoEntradaRecria * precioCompraRecria;
  // Costo terneros propios del destete (los que no se vendieron, se mandan a recría)
  const cabPropiaRecria = Math.max(0, cabRecriaSale - cabCompradasRecria);
  const costoReposicionPropia  = cabPropiaRecria * pesoDestete2 * precioInvKg;
  // Total costo reposición = lo que pagaste para tener los animales que vas a vender este año
  const costoReposicionTotal   = costoReposicionExterna + costoReposicionPropia;


  // ── Exportación — Cuota Hilton y UE 481 ──────────────────────────────────
  const dolarExp    = global.dolar ?? 1395; // dólar oficial para liquidación exportaciones
  const retencion   = 0.09; // 9% retenciones carne vacuna Argentina

  // Hilton
  const cabHilton   = terminacionDatos.novillosHilton ?? 0;
  const hiltonPesoFinal = (terminacionDatos.hiltonPesoEntrada ?? 380) + (terminacionDatos.hiltonDias ?? 120) * (terminacionDatos.hiltonGdp ?? 0.7);
  const hiltonKgRes     = hiltonPesoFinal * (terminacionDatos.hiltonRendRes ?? 60) / 100;
  const hiltonPrecioUSD = (terminacionDatos.hiltonPrecioUSDton ?? 8000) / 1000; // USD/kg res
  const hiltonIngresoUSD = cabHilton * hiltonKgRes * hiltonPrecioUSD * (1 - retencion);
  const hiltonIngresoPesos = hiltonIngresoUSD * dolarExp;
  const hiltonCostoPasto   = cabHilton * (terminacionDatos.hiltonCostoPasto ?? 0) * ((terminacionDatos.hiltonDias ?? 120) / 30);
  const hiltonCostoCert    = cabHilton * (terminacionDatos.hiltonCertSenasa ?? 5000);
  const hiltonCostoTotal   = hiltonCostoPasto + hiltonCostoCert;
  const hiltonMargen       = hiltonIngresoPesos - hiltonCostoTotal;

  // UE 481
  const cabUE481    = terminacionDatos.novillosUE481 ?? 0;
  const ue481PesoFinal = (terminacionDatos.ue481PesoEntrada ?? 340) + (terminacionDatos.ue481Dias ?? 100) * (terminacionDatos.ue481Gdp ?? 1.1);
  const ue481KgRes     = ue481PesoFinal * (terminacionDatos.ue481RendRes ?? 58) / 100;
  const ue481PrecioUSD = (terminacionDatos.ue481PrecioUSDton ?? 7000) / 1000;
  const ue481IngresoUSD  = cabUE481 * ue481KgRes * ue481PrecioUSD * (1 - retencion);
  const ue481IngresoPesos = ue481IngresoUSD * dolarExp;
  const ue481CostoRacion  = cabUE481 * (terminacionDatos.ue481RacionKgDia ?? 8) * (terminacionDatos.ue481Dias ?? 100) * ((terminacionDatos.ue481PrecioRacionTon ?? 80000) / 1000);
  const ue481CostoHotel   = cabUE481 * (terminacionDatos.ue481Hoteleria ?? 0) * (terminacionDatos.ue481Dias ?? 100);
  const ue481CostoCert    = cabUE481 * (terminacionDatos.ue481CertSenasa ?? 8000);
  const ue481CostoTotal   = ue481CostoRacion + ue481CostoHotel + ue481CostoCert;
  const ue481Margen       = ue481IngresoPesos - ue481CostoTotal;

  const ingresoExport  = hiltonIngresoPesos + ue481IngresoPesos;
  const costoExport    = hiltonCostoTotal + ue481CostoTotal;
  const margenExport   = hiltonMargen + ue481Margen;


  // ── MARGEN BRUTO — costos directos por actividad ─────────────────────────
  const sanidadCria     = cabCria * (campoStore.sanidadPorCabAnio ?? 40000);
  const sanidadRec      = cabRec  * (campoStore.sanidadPorCabAnio ?? 40000);
  const sanidadTerm     = cabTerm * (campoStore.sanidadPorCabAnio ?? 40000);
  const margenBrutoCria = ingresoCria - sanidadCria;
  const margenBrutoRec  = ingresoRecria - costoReposicionTotal - sanidadRec;
  const margenBrutoTerm = ingresoTerm - costoFeedlotAnual - sanidadTerm;
  // Devengado de pastaje hasta hoy (kg × precio novillo) — incluye lo cobrado + lo pendiente
  const precioNovPastaje = campoPastaje?.precioNov ?? precioNovilloGlobal ?? 4300;
  const hoyPast = new Date().toISOString().slice(0, 10);
  const diasEntrePast2 = (desde, hasta) => {
    if (!desde) return 0;
    const parse = s => { const [y,m,d] = String(s).slice(0,10).split("-").map(Number); return new Date(y,m-1,d); };
    return Math.max(0, Math.floor((parse(hasta) - parse(desde)) / 86400000));
  };
  const kgDevengadosPastaje = (campoPastaje?.tropas ?? []).reduce((s, t) => {
    const cab  = t.cabActual ?? t.cab ?? 0;
    const kgM  = (campoPastaje?.precios ?? {})[t.cat] ?? 6;
    const dias = diasEntrePast2(t.ultimoCobro || t.fechaIngreso, hoyPast);
    return s + cab * kgM * (dias / 30);
  }, 0);
  const devengadoPastajeHoy = kgDevengadosPastaje * precioNovPastaje;
  const margenBrutoPastaje = ingresoPastaje + devengadoPastajeHoy;
  // margenBrutoExport se calcula más abajo, después de definir margenExport
  // Si precio > 0, hay compra externa. Si = 0, son del destete propio (costo = precio invernada)
  // ── MARGEN BRUTO TOTAL — ahora que margenExport está definido ─────────────
  const margenBrutoExport = margenExport;
  const margenBrutoTotal  = margenBrutoCria + margenBrutoRec + margenBrutoTerm + margenBrutoPastaje + margenBrutoExport;

  // ── CASCADA ECONÓMICA — todo en orden correcto ─────────────────────────────
  const costoEstructuraAnual = costoTotalAnual;
  const amortMejoras    = campoStore.amorMejoras ?? 0;
  const amortHacienda   = campoStore.amorHaciendaReproductora ?? 0;
  const amortMaquinaria = campoStore.amorMaquinaria ?? 0;
  const amortTotal      = amortMejoras + amortHacienda + amortMaquinaria;
  const ebitda          = margenBrutoTotal - costoEstructuraAnual;
  const ebit            = ebitda - amortTotal;
  const ingresosTotales = ingresoCria + ingresoRecria + ingresoTerm + ingresoPastaje + ingresoExport;
  const pctIIBB         = campoStore.pctIIBB ?? 3;
  const pctGanancias    = campoStore.pctGanancias ?? 35;
  const iibbEstimado    = ingresosTotales * (pctIIBB / 100);
  const inmobiliario    = campoStore.inmobiliarioAnual ?? 0;
  const tasas           = campoStore.tasasAnuales ?? 0;
  const gananciasBase   = Math.max(0, ebit - iibbEstimado - inmobiliario - tasas);
  const gananciasEstimado = gananciasBase * (pctGanancias / 100);
  const impuestosTotal  = iibbEstimado + inmobiliario + tasas + gananciasEstimado;
  const margenNeto      = ebit - impuestosTotal;
  const margenNetoReal  = margenNeto - costoOportunidadAnual;

  // Aliases para compatibilidad
  const margenTotal = margenBrutoTotal;
  const margenCria  = margenBrutoCria;
  const margenRec   = margenBrutoRec;
  const margenTerm  = margenBrutoTerm;

  const totalCostosMes = totalEmpleadosMes + costoMaqMes + costoRoladoMes + costoViajesMes + sanidadMes;
  const costoPorCabMes = totalStockCampo > 0 ? Math.round(totalCostosMes / totalStockCampo) : 0;

  const feedlotMes = terminacionDatos.novillosFeedlot * (terminacionDatos.costoComidaDia + terminacionDatos.costoHoteleriaDia) * 30;

  const datosSync = {
    cantidad: (criaDatos.vacas||0) + (criaDatos.vaquillonas1??criaDatos.vaquillonas??0),
    pctDestete: Math.round(totalTernerosAlPie / (criaDatos.vacas + (criaDatos.vaquillonas1??criaDatos.vaquillonas??0) + (criaDatos.vaquillonas2??0)) * 100),
    pesoTerneroDestetado: 165,
    anosVidaUtil: 6,
  };

  // ── Rendimiento kg/ha — usa datos de Cría + GDP ──────────────────────────
  const MESES_ES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  const hoy = new Date();

  // Todo lo demás viene de criaDatos (sincronizado con Stock → Cría)
  // Auto-corregir año de parición: si el destete calculado está a más de 180 días,
  // el año probablemente está mal — restar 1 año automáticamente
  const meseDestete   = ciclos[0]?.mesesDestete ?? 6;
  const pctMachos     = criaDatos.pctMachos    ?? 50;
  const pctReposicion = criaDatos.pctReposicion ?? 30;
  const pctPreniez    = ciclos[0]?.pctPreniez   ?? 85;
  const pctDestete    = ciclos[0]?.pctDestete   ?? 75;
  const mortCria     = (criaDatos.pctMortandadCria  ?? 2) / 100;
  const mortRecria   = (reciaDatos.pctMortandadRecria  ?? 2) / 100;
  const mortFeedlot  = (terminacionDatos.pctMortandadFeedlot ?? 2) / 100;

  // Meses desde parición hasta cierre 30/jun
  const mesesHastaCierre = calcMesesHastaJunio(paricionMes, paricionAnio);
  const mesesDesteteHastaCierre = Math.max(0, mesesHastaCierre - meseDestete);

  // Pesos de nacimiento / destete base
  const pesoNacimiento  = 35;   // kg al nacer
  const pesoDestete     = Math.round(pesoNacimiento + meseDestete * 30 * gdpTernero);

  // Peso al cierre del año (30/jun) desde el destete
  const pesoTerneroAlCierre    = Math.round(pesoDestete + mesesDesteteHastaCierre * 30 * gdpTernero);
  const pesoNovilloInvAlCierre = Math.round(pesoDestete + mesesHastaCierre * 30 * gdpNovilloInv);
  const pesoNovilloFaenaAlCierre = terminacionDatos.pesoPromedioKg > 0 ? terminacionDatos.pesoPromedioKg : Math.round(pesoDestete + mesesHastaCierre * 30 * gdpNovilloFaena);
  const pesoVaquillonaAlCierre = Math.round(pesoDestete + mesesDesteteHastaCierre * 30 * gdpVaquillonaDesc);

  // Cabezas por categoría
  // ── Cálculo con preñez, destete y mortandad ──────────────────────────────
  const madresCria         = (criaDatos.vacas || 0) + (criaDatos.vaquillonas1 ?? criaDatos.vaquillonas ?? 0) + (criaDatos.vaquillonas2 ?? 0);
  const preñadasCalc       = Math.round(madresCria * pctPreniez / 100);
  const ternNacidos        = Math.round(preñadasCalc * 1.0); // 1 ternero por preñada
  const ternNacidosVivos   = Math.round(ternNacidos * (1 - mortCria));
  const totalDestete       = Math.round(ternNacidosVivos * pctDestete / 100);
  const machosDest         = Math.round(totalDestete * pctMachos / 100);
  const hembrasDest        = totalDestete - machosDest;
  const hembrasReposicion  = Math.round(hembrasDest * pctReposicion / 100);
  const hembrasVenta       = hembrasDest - hembrasReposicion;

  // Aplicar mortandad recría a los animales en recría
  const cabVacasDescarte   = criaDatos.vacias || 0;
  const machosRecriaVivos  = Math.round((reciaDatos.ternerosLiquidaMachos + reciaDatos.ternerosCompraMachos) * (1 - mortRecria));
  const cabTernerosInv     = machosRecriaVivos;
  const cabNovillosInv     = Math.round(reciaDatos.novillos * (1 - mortRecria));
  // Novillos faena con mortandad feedlot
  const cabNovillosFaena   = Math.round(terminacionDatos.novillosCampo * (1 - mortRecria)) + Math.round(terminacionDatos.novillosFeedlot * (1 - mortFeedlot));
  // Vaquillonas descarte:
  // De las hembras en recría (ternerosLiquidaHembras), el % que NO va a reposición → venta
  // Más las hembras nuevas del destete que no van a reposición (hembrasVenta)
  const hembrasRecriaSale  = Math.round(reciaDatos.ternerosLiquidaHembras * (1 - pctReposicion / 100));
  const cabVaquillonaDesc  = Math.round((hembrasRecriaSale + hembrasVenta) * (1 - mortRecria));

  // Pesos de venta calculados (GDP × meses)
  const pVacaDescarte      = criaDatos.pesoVacaDescarte ?? 380;
  const pTerneroInvernada  = pesoTerneroAlCierre;
  const pNovilloInvernada  = pesoNovilloInvAlCierre;
  const pNovilloFaena      = pesoNovilloFaenaAlCierre;
  const pVaquillonaDesc    = pesoVaquillonaAlCierre;

  // kg totales por categoría
  const kgVacasDescarte    = cabVacasDescarte   * pVacaDescarte;
  const kgTernerosInv      = cabTernerosInv     * pTerneroInvernada;
  const kgNovillosInv      = cabNovillosInv     * pNovilloInvernada;
  const kgNovillosFaena    = cabNovillosFaena   * pNovilloFaena;
  const kgVaquillonaDesc   = cabVaquillonaDesc  * pVaquillonaDesc;
  const kgTotalAct         = kgVacasDescarte + kgTernerosInv + kgNovillosInv + kgNovillosFaena + kgVaquillonaDesc + Math.round(kgVendidosTotal);
  const kgHaAct            = hectareas > 0 ? Math.round(kgTotalAct / hectareas) : 0;

  // Proyección año siguiente — con GDP proyectada 12 meses completos
  const pesoTernProx       = Math.round(pesoDestete + 12 * 30 * gdpTernero);
  const pesoNovInvProx     = Math.round(pesoDestete + 18 * 30 * gdpNovilloInv);
  const pesoNovFaenaProx   = Math.round(pesoDestete + 24 * 30 * gdpNovilloFaena);
  const pesoVaqProx        = Math.round(pesoDestete + 18 * 30 * gdpVaquillonaDesc);

  const comprasProx        = reciaDatos.ternerosCompraMachos;
  const novillosFaenaProx  = reciaDatos.novillos + comprasProx;
  const ternerosInvProx    = machosDest;
  const vaquillonaDescProx = hembrasVenta;
  const vacasDescarteProx  = cabVacasDescarte;

  const kgVacasDescProx    = vacasDescarteProx  * pVacaDescarte;
  const kgTernerosInvProx  = ternerosInvProx    * pesoTernProx;
  const kgNovillosFaenaProx= novillosFaenaProx  * pesoNovFaenaProx;
  const kgVaqDescProx      = vaquillonaDescProx * pesoVaqProx;
  const kgTotalProx        = kgVacasDescProx + kgTernerosInvProx + kgNovillosFaenaProx + kgVaqDescProx;
  const kgHaProx           = hectareas ? Math.round(kgTotalProx / hectareas) : 0;
  const tendencia          = kgHaProx !== kgHaAct ? (kgHaProx === Math.max(kgHaProx, kgHaAct) ? "sube" : "baja") : "estable";

  // Tabla mensual de acumulación de kg (actual: desde hoy hasta 30/jun)
  // ── Parición escalonada 3 meses ─────────────────────────────────────────────
  // Los terneros nacen repartidos en 3 meses (paricionMes, +1, +2)
  // Parición escalonada — calculado con función top-level calcLote
  const lotesPacion = [
    calcLote(0, paricionMes, paricionAnio, ternNacidosVivos, pesoNacimiento, gdpTernero, meseDestete, MESES_ES),
    calcLote(1, paricionMes, paricionAnio, ternNacidosVivos, pesoNacimiento, gdpTernero, meseDestete, MESES_ES),
    calcLote(2, paricionMes, paricionAnio, ternNacidosVivos, pesoNacimiento, gdpTernero, meseDestete, MESES_ES),
  ];

  // Kg totales de terneros
  let kgTernerosAlCierre  = 0;
  let kgTernerosAlDestete = 0;
  for (let li = 0; li !== lotesPacion.length; li++) {
    kgTernerosAlCierre  += lotesPacion[li].cabLote * lotesPacion[li].kgAlCierre;
    kgTernerosAlDestete += lotesPacion[li].cabLote * lotesPacion[li].kgAlDestete;
  }

  // Mes actual para resaltar en la tabla
  const mesActual = new Date().getMonth();
  const anioActual = new Date().getFullYear();

  const tablaAcumulacion = calcTablaAcum(mesesHastaCierre, paricionMes, pesoNacimiento, gdpTernero, gdpNovilloInv, gdpNovilloFaena, meseDestete, MESES_ES);
  const historialKgHa    = calcHistorialKgHa(historialAnos, pVacaDescarte, pTerneroInvernada, pNovilloInvernada, pNovilloFaena, hectareas, anoGanadero, kgHaAct, kgTotalAct, kgHaProx, kgTotalProx);

  const SECCIONES = [
    { id: "stock",        label: "Stock hacienda",    icon: "🐄" },
    { id: "movimientos",  label: "Movimientos",        icon: "🔄" },
    { id: "rendimiento",  label: "Rendimiento",        icon: "📊" },
    { id: "costos",       label: "Costos estructura",  icon: "💰" },
    { id: "config",       label: "Cotizaciones",       icon: "💲" },
    { id: "pastaje",      label: "Pastaje",            icon: "🤝" },
  ];

  // ── Mini helper: campo editable con +/- ─────────────────────────────────
  // EditField definido como componente de nivel superior (ver arriba)

  return (
    <div className="app-bg text-slate-800 font-sans antialiased min-h-screen">
      <nav className="sticky top-0 z-50 bg-white border-b-2 border-slate-100 shadow-md simulator-enter">
        <div className="h-1 w-full bg-gradient-to-r from-blue-500 via-cyan-500 to-emerald-500" />
        <div className="max-w-[1100px] mx-auto px-3 sm:px-6 lg:px-8 py-2.5 flex items-center justify-between gap-3">
          <button onClick={onVolver}
            className="flex items-center gap-2.5 bg-gradient-to-r from-slate-800 to-slate-700 hover:from-slate-700 hover:to-slate-600 text-white font-black text-xs sm:text-sm px-4 py-2.5 rounded-2xl shadow-md hover:shadow-lg transition-all active:scale-95 group"
            style={{transition:"all 0.2s cubic-bezier(0.34,1.56,0.64,1)"}}>
            <ArrowLeft size={18} className="transition-transform group-hover:-translate-x-1" />
            Volver al Menú
          </button>
          <div className="flex items-center gap-2.5 flex-1 justify-center min-w-0">
            <img src={`data:image/png;base64,${LOGO_B64}`} alt="SoyPekun"
              className="h-11 sm:h-14 object-contain shrink-0" style={{ maxWidth: "160px" }} />
            <div className="bg-blue-500 text-white font-black text-xs px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-sm shrink-0">
              <span>🌾</span><span className="hidden sm:inline">Mi Campo</span>
            </div>
          </div>
          <button onClick={() => onSincronizar(datosSync)}
            className="flex items-center gap-2 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white font-black text-xs px-3 py-2 rounded-xl shadow-md transition-all active:scale-95 group shrink-0">
            <RefreshCw size={14} className="group-hover:rotate-180 transition-transform duration-500" />
            <span className="hidden sm:inline">Sync al Simulador</span>
          </button>
        </div>
        {/* Año ganadero bar */}
        <div className="border-t border-slate-100 px-3 sm:px-6 lg:px-8 py-2 flex items-center gap-3 overflow-x-auto">
          <span className="text-xs text-slate-400 font-semibold shrink-0">Año ganadero:</span>
          <div className="flex items-center gap-2">
            <span className={`text-xs font-black px-3 py-1 rounded-full ${!anoViendo ? "bg-blue-500 text-white" : "bg-slate-100 text-slate-500 cursor-pointer hover:bg-slate-200"}`}
              onClick={() => setAnoViendo(null)}>
              {anoGanadero} {!anoViendo && "· actual"}
            </span>
            {Object.keys(historialAnos).sort().reverse().map(ano => (
              <span key={ano}
                className={`text-xs font-bold px-3 py-1 rounded-full cursor-pointer transition-all ${anoViendo === ano ? "bg-slate-700 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}
                onClick={() => setAnoViendo(ano)}>
                {ano}
              </span>
            ))}
          </div>
          {!anoViendo && (
            <button onClick={() => {
              if (window.confirm(`¿Cerrar el año ${anoGanadero} y abrir el siguiente? El stock se mantiene.`)) onCerrarAno();
            }}
              className="ml-auto text-xs font-bold text-slate-400 hover:text-orange-500 border border-dashed border-slate-200 hover:border-orange-300 px-3 py-1 rounded-full transition-all shrink-0">
              Cerrar año →
            </button>
          )}
          {anoViendo && (
            <span className="ml-auto text-xs font-bold text-amber-600 bg-amber-50 border border-amber-200 px-3 py-1 rounded-full shrink-0">
              Solo lectura — año {anoViendo}
            </span>
          )}
        </div>
      </nav>

      {/* ── Línea de tiempo año ganadero ──────────────────────────────────── */}
      {(() => {
        const hoy = new Date();
        const cierre = new Date(hoy.getFullYear(), 5, 30);
        if (hoy > cierre) cierre.setFullYear(cierre.getFullYear() + 1);
        const inicio = new Date(cierre.getFullYear() - 1, 6, 1);
        const total  = Math.round((cierre - inicio) / 86400000);
        const trans  = Math.round((hoy - inicio) / 86400000);
        const restantes = Math.round((cierre - hoy) / 86400000);
        const pct = Math.min(100, Math.max(0, (trans / total) * 100));
        const color = restantes < 30 ? "linear-gradient(90deg,#ef4444,#f97316)"
                    : restantes < 90 ? "linear-gradient(90deg,#f59e0b,#eab308)"
                    : "linear-gradient(90deg,#10b981,#059669)";
        return (
          <div className="px-3 sm:px-6 lg:px-8 py-2 bg-white border-b border-slate-100">
            <div className="max-w-[1100px] mx-auto flex items-center gap-3">
              <span className="text-xs text-slate-400 shrink-0">1 jul {inicio.getFullYear()}</span>
              <div className="flex-1 relative h-3 bg-slate-100 rounded-full overflow-hidden border border-slate-200">
                <div className="h-full rounded-full" style={{ width: pct + "%", background: color }} />
              </div>
              <span className={`text-xs font-black shrink-0 ${restantes < 30 ? "text-red-500" : restantes < 90 ? "text-amber-500" : "text-emerald-600"}`}>
                {restantes}d → 30/06/{cierre.getFullYear()}
              </span>
            </div>
          </div>
        );
      })()}

      <div className="w-full max-w-[1200px] mx-auto px-2 sm:px-4 py-4 md:py-6">

        {/* KPI resumen */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5 simulator-enter">
          {[
            { label:"Total hacienda", value:`${totalStockCampo} cab`, color:"text-slate-800", icon:"🐄" },
            { label:"Cría",           value:`${criaDatos.vacas+(criaDatos.vaquillonas1??criaDatos.vaquillonas??0)} madres`, color:"text-emerald-700", icon:"🐮" },
            { label:"Recría",         value:`${reciaDatos.ternerosLiquidaMachos+reciaDatos.ternerosLiquidaHembras+reciaDatos.ternerosCompraMachos+reciaDatos.ternerosCompraHembras+reciaDatos.novillos} cab`, color:"text-blue-700", icon:"🐂" },
            { label:"Terminación",    value:`${terminacionDatos.novillosCampo+terminacionDatos.novillosFeedlot} cab`, color:"text-amber-700", icon:"🥩" },
          ].map((k,i) => (
            <div key={i} className="kpi-pop bg-white rounded-2xl border-2 border-slate-100 p-4 flex flex-col gap-1 shadow-sm card-hover">
              <span className="text-xl">{k.icon}</span>
              <span className="text-xs sm:text-xs font-bold uppercase tracking-wider text-slate-400">{k.label}</span>
              <span className={`font-mono font-black text-2xl sm:text-xl ${k.color}`}>{k.value}</span>
            </div>
          ))}
        </div>

        {/* ── Carga animal — EV/ha ──────────────────────────────────────── */}
        {hectareas > 0 && (() => {
          const cargaIdeal = Number(campoStore.receptividadEvHa) > 0 ? Number(campoStore.receptividadEvHa) : 1.0;
          // ── Capacidad ociosa / sobrecarga (oportunidad de $) ──────────────
          const evDisponibleHa = cargaIdeal - evPorHa;
          const evOcioso  = Math.max(0, evDisponibleHa) * hectareas;
          const evExceso  = Math.max(0, -evDisponibleHa) * hectareas;
          const cabAdic   = Math.round(evOcioso);              // ~1 EV por novillo de invernada
          const pctOcioso = cargaIdeal > 0 ? (Math.max(0, evDisponibleHa) / cargaIdeal) * 100 : 0;
          const precioNovPast = precioNovPastaje || 0;
          const ingresoPastajePotencial = cabAdic * 6 * precioNovPast * 12; // 6 kg novillo/mes por cab
          const setRecep = (v) => vacaStore.getState().setCampo({ receptividadEvHa: isNaN(v) ? 0 : v });
          const pct     = Math.min(100, (evPorHa  / cargaIdeal) * 100);
          const pctProp = Math.min(100, (evPropHa / cargaIdeal) * 100);
          const pctPast = Math.min(100, (evPastHa / cargaIdeal) * 100);
          const estado = evPorHa < 0.7 ? { label: "Subutilizado", color: "bg-sky-100 text-sky-700 border-sky-300",         bar: "#0ea5e9" }
                       : evPorHa < 1.1 ? { label: "Óptimo",        color: "bg-emerald-100 text-emerald-700 border-emerald-300", bar: "#10b981" }
                       : evPorHa < 1.4 ? { label: "Cargado",       color: "bg-amber-100 text-amber-700 border-amber-300",   bar: "#f59e0b" }
                                       : { label: "Sobrecarga",    color: "bg-red-100 text-red-700 border-red-300",         bar: "#ef4444" };
          return (
            <div className="bg-white rounded-2xl border-2 border-slate-200 p-4 mb-5 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-lg">🌾</span>
                  <p className="text-xs font-black uppercase tracking-widest text-slate-600">Carga animal — EV/ha</p>
                </div>
                <span className={`text-xs font-black px-2.5 py-1 rounded-full border ${estado.color}`}>{estado.label}</span>
              </div>
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div className="text-center">
                  <p className="text-xs text-slate-400">EV propio</p>
                  <p className="font-mono font-black text-xl text-slate-700">{Math.round(totalEV)}</p>
                </div>
                <div className="text-center">
                  <p className="text-xs text-slate-400">EV pastaje</p>
                  <p className="font-mono font-black text-xl text-orange-500">{Math.round(evPastaje)}</p>
                </div>
                <div className="text-center">
                  <p className="text-xs text-slate-400">EV/ha total</p>
                  <p className="font-mono font-black text-2xl" style={{ color: estado.bar }}>{evPorHa.toFixed(2)}</p>
                </div>
              </div>
              {/* Barra apilada: propio (azul) + pastaje (naranja) */}
              <div className="h-3 bg-slate-100 rounded-full overflow-hidden border border-slate-200 flex">
                <div className="h-full transition-all" style={{ width: pctProp + "%", background: estado.bar }} />
                {evPastaje > 0 && <div className="h-full transition-all" style={{ width: pctPast + "%", background: "#f97316" }} />}
              </div>
              {/* Receptividad editable del campo */}
              <div className="flex items-center justify-center gap-2 mt-3 text-xs text-slate-500">
                <span>Receptividad del campo:</span>
                <input type="number" step="0.1" min="0" value={campoStore.receptividadEvHa ?? 1.0}
                  onChange={e => setRecep(parseFloat(e.target.value))}
                  className="w-20 border-2 border-slate-200 rounded-lg px-2 py-1 text-right font-mono text-sm" />
                <span>EV/ha</span>
              </div>
              {/* Capacidad ociosa → oportunidad de $ */}
              {evOcioso >= 1 && (
                <div className="mt-3 rounded-xl border-2 border-sky-200 bg-sky-50 p-3">
                  <p className="text-xs font-black uppercase tracking-widest text-sky-700 mb-1">💡 Capacidad ociosa</p>
                  <p className="text-sm text-slate-700 leading-relaxed">
                    Te sobran <b className="font-mono">{Math.round(evOcioso)} EV</b> ({Math.round(pctOcioso)}% sin usar): podés sumar <b>≈ {cabAdic} novillos</b> de invernada, o tomar pastaje por <b className="text-sky-700">{fmtMoney(ingresoPastajePotencial)}/año</b>.
                  </p>
                  <p className="text-xs text-slate-400 mt-1">Estimado a 6 kg novillo/mes por cabeza · novillo {fmtMoney(precioNovPast)}/kg</p>
                </div>
              )}
              {evExceso >= 1 && (
                <div className="mt-3 rounded-xl border-2 border-red-200 bg-red-50 p-3">
                  <p className="text-xs font-black uppercase tracking-widest text-red-700 mb-1">⚠️ Sobrecarga</p>
                  <p className="text-sm text-slate-700 leading-relaxed">
                    Estás <b className="font-mono">{Math.round(evExceso)} EV</b> por encima de la receptividad. Riesgo de pérdida de estado, menor preñez y más mortandad: conviene aliviar carga o suplementar.
                  </p>
                </div>
              )}
              {evPastaje > 0 && (
                <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
                  <span className="flex items-center gap-1"><span style={{ display:"inline-block", width:10, height:10, borderRadius:"50%", background: estado.bar }} /> Propio {evPropHa.toFixed(2)} EV/ha</span>
                  <span className="flex items-center gap-1"><span style={{ display:"inline-block", width:10, height:10, borderRadius:"50%", background:"#f97316" }} /> Pastaje {evPastHa.toFixed(2)} EV/ha</span>
                </div>
              )}
              <p className="text-xs text-slate-400 text-center mt-1.5">Referencia: 1.0 EV/ha · zona templada típica · ajustá según receptividad real</p>
            </div>
          );
        })()}


        {/* ── Balance del año cerrado (solo cuando vemos historial) ────── */}
        {anoViendo && stockActivo?.balance && (() => {
          const b = stockActivo.balance;
          const pos = b.rendimientoReal >= 0;
          return (
            <div className="bg-white rounded-2xl border-2 border-violet-200 p-4 mb-5 shadow-sm">
              <p className="text-xs font-black uppercase tracking-widest text-violet-700 mb-3">📋 Balance del año {anoViendo}</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                {[
                  { label: "kg nov producidos", value: (b.kgTotalAnio||0).toLocaleString("es-AR") + " kg", color: "text-emerald-700" },
                  { label: "kg/ha", value: (b.kgHaAnio||0) + " kg/ha", color: "text-sky-700" },
                  { label: "% destete", value: (b.pctDestete||0) + "%", color: "text-amber-700" },
                  { label: "EV/ha", value: (b.evPorHa||0).toFixed(2), color: "text-teal-700" },
                ].map((k,i) => (
                  <div key={i} className="bg-slate-50 rounded-xl border border-slate-200 p-2.5 text-center">
                    <p className="text-xs text-slate-400">{k.label}</p>
                    <p className={`font-black text-base ${k.color}`}>{k.value}</p>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="bg-emerald-50 rounded-xl p-2.5">
                  <p className="text-xs text-slate-400">Ingreso</p>
                  <p className="font-black text-emerald-700">{fmtMoney(b.ingresoAnio||0)}</p>
                </div>
                <div className="bg-red-50 rounded-xl p-2.5">
                  <p className="text-xs text-slate-400">Costo estructura</p>
                  <p className="font-black text-red-700">−{fmtMoney(b.costoEst||0)}</p>
                </div>
                <div className={`rounded-xl p-2.5 ${pos?"bg-emerald-100":"bg-red-100"}`}>
                  <p className="text-xs text-slate-400">Margen neto real</p>
                  <p className={`font-black text-base ${pos?"text-emerald-800":"text-red-800"}`}>{fmtMoney(b.rendimientoReal||0)}</p>
                </div>
              </div>
            </div>
          );
        })()}
        <style>{`
          .campo-sidebar { display:flex; flex-direction:column; gap:4px; width:176px; flex-shrink:0; position:sticky; top:5.5rem; }
          .campo-mobile-nav { display:none; }
          @media (max-width: 767px) {
            .campo-sidebar { display:none; }
            .campo-mobile-nav { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-bottom:20px; }
          }
        `}</style>
        <div style={{display:"flex", gap:"1.5rem", alignItems:"flex-start"}}>

          {/* Sidebar desktop — no se renderiza en resultado */}
          <div className="campo-sidebar">
            {SECCIONES.map(s => (
              <button key={s.id} onClick={() => handleSetSeccion(s.id)}
                style={{width:"100%", display:"flex", alignItems:"center", gap:"10px", padding:"10px 14px", borderRadius:"14px", textAlign:"left", transition:"all 0.15s", border: seccion===s.id?"none":"2px solid #e2e8f0", background: seccion===s.id?"#1e293b":"white", color: seccion===s.id?"white":"#64748b"}}>
                <span style={{fontSize:"16px", lineHeight:1}}>{s.icon}</span>
                <span style={{fontSize:"10px", fontWeight:900, textTransform:"uppercase", letterSpacing:"0.08em", lineHeight:1.2}}>{s.label}</span>
              </button>
            ))}
          </div>

          {/* Main content */}
          <div style={{flex:1, minWidth:0}}>

            {/* Grilla mobile */}
            <div className="campo-mobile-nav">
              {SECCIONES.map(s => (
                <button key={s.id} onClick={() => handleSetSeccion(s.id)}
                  style={{display:"flex", flexDirection:"column", alignItems:"center", gap:"4px", padding:"10px 4px", borderRadius:"16px", border: seccion===s.id?"none":"2px solid #e2e8f0", background: seccion===s.id?"#1e293b":"white", color: seccion===s.id?"white":"#64748b", transition:"all 0.15s"}}>
                  <span style={{fontSize:"20px", lineHeight:1}}>{s.icon}</span>
                  <span style={{fontSize:"9px", fontWeight:900, textTransform:"uppercase", letterSpacing:"0.07em", lineHeight:1.2, textAlign:"center"}}>{s.label}</span>
                </button>
              ))}
            </div>

          {/* ══════════════════════════════════════════════════════════════
              STOCK HACIENDA
          ══════════════════════════════════════════════════════════════ */}
          {seccion === "stock" && !subStock && (
            <div className="space-y-4 sim-zoom-enter">
  
              {/* ── CRÍA — vista fija ───────────────────────────────────────── */}
              <div className="cat-enter bg-white border-2 border-emerald-200 rounded-3xl overflow-hidden shadow-lg" style={{animationDelay:"0.05s"}}>
                <div className="h-1.5 bg-gradient-to-r from-emerald-400 to-teal-400"/>
                <div className="p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">🐮</span>
                      <div>
                        <p className="text-xs font-black uppercase tracking-widest text-emerald-700">Cría</p>
                        <p className="text-3xl font-black text-slate-800">{(criaDatos.vacas||0)+(criaDatos.vaquillonas1??criaDatos.vaquillonas??0)+totalTernerosAlPie+(criaDatos.toros||0)} <span className="text-base font-bold text-slate-400">cab</span></p>
                      </div>
                    </div>
                    <button onClick={entrarCria}
                      className="flex items-center gap-1.5 text-xs font-black text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 px-3 py-2 rounded-xl transition-all">
                      ✏️ Editar
                    </button>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { label:"Vacas",           val: criaDatos.vacas,                 color:"text-emerald-800" },
                      { label:"Vaquillonas",     val: (criaDatos.vaquillonas1??criaDatos.vaquillonas??0), color:"text-emerald-700" },
                      { label:"Toros",           val: criaDatos.toros,                 color:"text-slate-700"   },
                      { label:"Vacías (desc.)",  val: criaDatos.vacias||0,             color:"text-rose-600"    },
                      { label:"Tern. no dest.",  val: totalTernerosAlPie,  color:"text-blue-700"    },
                      { label:"% Preñez",        val: `${criaDatos.pctPreniez??85}%`,  color:"text-emerald-700" },
                      { label:"% Destete",       val: `${criaDatos.pctDestete??75}%`,  color:"text-emerald-700" },
                      { label:"% Mort. cría",    val: `${criaDatos.pctMortandadCria??2}%`, color:"text-slate-500" },
                    ].map(({label,val,color})=>(
                      <div key={label} className="bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2">
                        <p className="text-xs text-slate-400">{label}</p>
                        <p className={`font-black text-base ${color}`}>{val}</p>
                      </div>
                    ))}
                  </div>
                  {(() => {
                    const MESES_C = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
                    const pMes = criaDatos.paricionMes ?? 9;
                    const pAnio = criaDatos.paricionAnio ?? new Date().getFullYear();
                    const mDest = criaDatos.mesesDestete ?? 6;
                    const destMes = (pMes + mDest) % 12;
                    const destAnio = (pMes + mDest) >= 12 ? pAnio + 1 : pAnio;
                    const diasParaDest = Math.round((new Date(destAnio, destMes, 1) - new Date()) / 86400000);
                    return (
                      <div className="mt-3 flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-slate-400">Parición: <b className="text-slate-600">{MESES_C[pMes]} {pAnio}</b></span>
                        <span className="text-xs text-slate-300">·</span>
                        <div className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-black ${diasParaDest < 0 ? "bg-emerald-100 text-emerald-700" : diasParaDest < 30 ? "bg-orange-100 text-orange-700" : "bg-blue-100 text-blue-700"}`}>
                          {diasParaDest < 0 ? "✅ Destete alcanzado" : `🗓 Destete: ${MESES_C[destMes]} ${destAnio} (${diasParaDest}d)`}
                        </div>
                        <span className="text-xs text-slate-400">Repos: <b className="text-slate-600">{criaDatos.pctReposicion??30}%</b></span>
                        <span className="text-xs text-slate-400">M/H: <b className="text-slate-600">{criaDatos.pctMachos??50}/{100-(criaDatos.pctMachos??50)}</b></span>
                      </div>
                    );
                  })()}
                </div>
              </div>
  
              {/* ── RECRÍA — vista fija ─────────────────────────────────────── */}
              <div className="cat-enter bg-white border-2 border-blue-200 rounded-3xl overflow-hidden shadow-lg" style={{animationDelay:"0.12s"}}>
                <div className="h-1.5 bg-gradient-to-r from-blue-400 to-indigo-400"/>
                <div className="p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">🐂</span>
                      <div>
                        <p className="text-xs font-black uppercase tracking-widest text-blue-700">Recría</p>
                        <p className="text-3xl font-black text-slate-800">{reciaDatos.ternerosLiquidaMachos+reciaDatos.ternerosLiquidaHembras+reciaDatos.ternerosCompraMachos+reciaDatos.ternerosCompraHembras+reciaDatos.novillos} <span className="text-base font-bold text-slate-400">cab</span></p>
                      </div>
                    </div>
                    <button onClick={entrarRecria}
                      className="flex items-center gap-1.5 text-xs font-black text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 px-3 py-2 rounded-xl transition-all">
                      ✏️ Editar
                    </button>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {[
                      { label:"Marca líq. machos",   val: reciaDatos.ternerosLiquidaMachos,  color:"text-blue-800"   },
                      { label:"Marca líq. hembras",  val: reciaDatos.ternerosLiquidaHembras, color:"text-rose-600"   },
                      { label:"Compra machos",        val: reciaDatos.ternerosCompraMachos,   color:"text-indigo-700" },
                      { label:"Compra hembras",       val: reciaDatos.ternerosCompraHembras,  color:"text-pink-600"   },
                      { label:"Novillos (para vender)", val: reciaDatos.novillos,             color:"text-amber-700"  },
                      { label:"% Mort. recría",       val: `${reciaDatos.pctMortandadRecria??2}%`, color:"text-slate-500" },
                    ].map(({label,val,color})=>(
                      <div key={label} className="bg-blue-50 border border-blue-100 rounded-xl px-3 py-2">
                        <p className="text-xs text-slate-400">{label}</p>
                        <p className={`font-black text-base ${color}`}>{val}</p>
                      </div>
                    ))}
                  </div>
                  {(reciaDatos.ternerosLiquidaMachos+reciaDatos.ternerosLiquidaHembras) > 0 && (
                    <div className="mt-3 flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
                      <span className="text-sm">✓</span>
                      <p className="text-xs text-emerald-700 font-semibold">{reciaDatos.ternerosLiquidaMachos+reciaDatos.ternerosLiquidaHembras} terneros destetados en recría — {reciaDatos.ternerosLiquidaMachos}M + {reciaDatos.ternerosLiquidaHembras}H</p>
                    </div>
                  )}
                </div>
              </div>
  
              {/* ── TERMINACIÓN — vista fija ────────────────────────────────── */}
              <div className="cat-enter bg-white border-2 border-amber-200 rounded-3xl overflow-hidden shadow-lg" style={{animationDelay:"0.19s"}}>
                <div className="h-1.5 bg-gradient-to-r from-amber-400 to-orange-400"/>
                <div className="p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">🥩</span>
                      <div>
                        <p className="text-xs font-black uppercase tracking-widest text-amber-700">Terminación</p>
                        <p className="text-3xl font-black text-slate-800">{terminacionDatos.novillosCampo+terminacionDatos.novillosFeedlot} <span className="text-base font-bold text-slate-400">cab</span></p>
                      </div>
                    </div>
                    <button onClick={entrarTerminacion}
                      className="flex items-center gap-1.5 text-xs font-black text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 px-3 py-2 rounded-xl transition-all">
                      ✏️ Editar
                    </button>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { label:"Campo",          val: terminacionDatos.novillosCampo,              color:"text-amber-800"  },
                      { label:"Feedlot",        val: terminacionDatos.novillosFeedlot,            color:"text-orange-700" },
                      { label:"Peso prom.",     val: `${terminacionDatos.pesoPromedioKg} kg`,     color:"text-slate-700"  },
                      { label:"% Mort. feedlot",val: `${terminacionDatos.pctMortandadFeedlot??2}%`, color:"text-slate-500" },
                    ].map(({label,val,color})=>(
                      <div key={label} className="bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
                        <p className="text-xs text-slate-400">{label}</p>
                        <p className={`font-black text-base ${color}`}>{val}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
  
            </div>
          )}
  
          {/* ── DETALLE CRÍA ─────────────────────────────────────────────── */}
          {seccion === "stock" && subStock === "cria" && (
            <div className="sim-zoom-enter space-y-4">
              <button onClick={() => { setSnapCria(null); setSubStock(null); }} className="flex items-center gap-2 text-slate-500 hover:text-slate-800 text-xs font-bold uppercase tracking-widest transition-colors">
                <ArrowLeft size={14} /> Volver a stock
              </button>
              <SaveUndoBar
                modificado={snapCria !== null}
                onGuardar={async () => { await guardarEstado(vacaStore.getState().__userEmail); setSnapCria(null); }}
                onDeshacer={deshacerCria}
              />
              <div className="bg-white border-2 border-emerald-200 rounded-3xl overflow-hidden shadow-lg">
                <div className="h-1.5 bg-gradient-to-r from-emerald-400 to-teal-400" />
                <div className="p-5 md:p-6 space-y-6">
                  <p className="text-xs font-black uppercase tracking-widest text-emerald-700">Cría — stock</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <EditField label="Vacas" value={criaDatos.vacas} onChange={v=>setCriaActiva(p=>({...p,vacas:v}))} hint="Vacas con cría o sin servicio" />
                    <EditField label="Vaquillonas 1° Servicio" value={criaDatos.vaquillonas1??criaDatos.vaquillonas??0} onChange={v=>setCriaActiva(p=>({...p,vaquillonas1:v}))} hint="Entrada al rodeo por primera vez" />
                    <EditField label="Vaquillonas 2° Servicio" value={criaDatos.vaquillonas2??0} onChange={v=>setCriaActiva(p=>({...p,vaquillonas2:v}))} hint="Segundo servicio — ya acreditadas" />
                    <EditField label="Toros" value={criaDatos.toros} onChange={v=>setCriaActiva(p=>({...p,toros:v}))} hint={`Relación ${criaDatos.toros>0?Math.round((criaDatos.vacas+(criaDatos.vaquillonas1??criaDatos.vaquillonas??0)+(criaDatos.vaquillonas2??0))/criaDatos.toros):0}:1 vaca/toro`} />
                    <EditField label="Vacas vacías (descarte)" value={criaDatos.vacias||0} onChange={v=>setCriaActiva(p=>({...p,vacias:v}))} hint="Van al rendimiento como descarte" />
                    <EditField label="Peso vaca descarte (kg)" value={criaDatos.pesoVacaDescarte??380} onChange={v=>setCriaActiva(p=>({...p,pesoVacaDescarte:Math.max(200,Math.min(600,v))}))} step={10} suffix="kg" hint="Peso promedio vaca al momento de faena" />
                  </div>

                  {/* Descartes — Vaca CUT y Vaq Rechazo */}
                  <div>
                    <p className="text-xs font-black uppercase tracking-widest text-slate-600 mb-3">Descartes</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <EditField label="Vaca CUT" value={criaDatos.vacaCut??0} onChange={v=>setCriaActiva(p=>({...p,vacaCut:v}))} hint="Vacas descartadas por producción o dentición" />
                      <EditField label="Vaq Rechazo" value={criaDatos.vaqRechazo??0} onChange={v=>setCriaActiva(p=>({...p,vaqRechazo:v}))} hint="Vaquillonas que no quedaron preñadas" />
                    </div>
                    {/* Sincronizar a Terminación */}
                    {((criaDatos.vacaCut??0) > 0 || (criaDatos.vaqRechazo??0) > 0) && (
                      <div className="mt-3">
                        <SyncDescartesBtn
                          criaDatos={criaDatos}
                          setCriaActiva={setCriaActiva}
                          setTermActiva={setTermActiva}
                          onToast={onToast}
                        />
                      </div>
                    )}
                  </div>

                  {/* Terneros no destetados + destete parcial */}
                  <div>
                    <p className="text-xs font-black uppercase tracking-widest text-emerald-700 mb-3">Terneros al pie</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <EditField label="Terneros no destetados" value={totalTernerosAlPie} onChange={v=>setCriaActiva(p=>{
                        const ciclos = (p.ciclos && p.ciclos.length) ? [...p.ciclos] : [];
                        if (ciclos.length) ciclos[0] = { ...ciclos[0], ternerosAlPie: v };
                        return { ...p, ciclos, ternerosNoDestetados: v };
                      })} hint="Al pie de la madre — no computan rendimiento aún" />
                      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 flex items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-semibold text-slate-600">Destetados este año</p>
                          <p className="text-2xl font-black text-emerald-700">{totalTernerosDestetados}</p>
                        </div>
                      </div>
                    </div>
                  </div>
  
                  {/* Preñez, destete y mortandad */}
                  <div>
                    <p className="text-xs font-black uppercase tracking-widest text-emerald-700 mb-3">% Productivos — sincronizados con Rendimiento</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <EditField label="% Preñez" value={criaDatos.pctPreniez??85} onChange={v=>setCriaActiva(p=>({...p,pctPreniez:Math.min(100,Math.max(0,v))}))} step={1} suffix="%" hint={`${Math.round(((criaDatos.vacas||0)+(criaDatos.vaquillonas1??criaDatos.vaquillonas??0))*(criaDatos.pctPreniez??85)/100)} madres preñadas`} />
                      <EditField label="% Destete" value={criaDatos.pctDestete??75} onChange={v=>setCriaActiva(p=>({...p,pctDestete:Math.min(100,Math.max(0,v))}))} step={1} suffix="%" hint={`Valor final para rendimiento`} />
                      <EditField label="Peso al destete (kg)" value={criaDatos.pesoDesteteKg??187} onChange={v=>setCriaActiva(p=>({...p,pesoDesteteKg:Math.max(100,Math.min(300,v))}))} step={5} suffix="kg" hint="175-200 kg típico para Argentina. Impacta en margen de Cría y costo de reposición de Recría." />
                      <EditField label="% Mortandad cría" value={criaDatos.pctMortandadCria??2} onChange={v=>setCriaActiva(p=>({...p,pctMortandadCria:Math.min(10,Math.max(0,v))}))} step={0.5} suffix="%" hint="0% a 10%" />
                    </div>
                    {/* GDP Ternero */}
                    <div className="mt-3 p-3 bg-emerald-50 border border-emerald-200 rounded-2xl">
                      <p className="text-xs font-black text-emerald-700 mb-2">⚡ GDP Ternero — nacimiento → destete</p>
                      <div className="flex items-center gap-3">
                        <button onClick={()=>setGdpTernero(v=>Math.max(0,Math.round((v-0.1)*10)/10))}
                          className="w-8 h-8 rounded-lg bg-emerald-700 text-white font-black flex items-center justify-center text-sm active:scale-95">−</button>
                        <input type="range" min="0" max="1.5" step="0.1" value={gdpTernero}
                          onChange={e=>setGdpTernero(Math.round(parseFloat(e.target.value)*10)/10)}
                          className="flex-1 accent-emerald-500"/>
                        <button onClick={()=>setGdpTernero(v=>Math.min(1.5,Math.round((v+0.1)*10)/10))}
                          className="w-8 h-8 rounded-lg bg-emerald-700 text-white font-black flex items-center justify-center text-sm active:scale-95">+</button>
                        <span className="font-mono font-black text-emerald-800 text-lg w-16 text-right">{gdpTernero.toFixed(1)} kg/d</span>
                        <span className="text-xs text-emerald-600 font-semibold whitespace-nowrap">→ destete: <b>{pesoDestete} kg</b></span>
                      </div>
                    </div>
                  </div>
  
                  {/* Ciclos de parición */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-black uppercase tracking-widest text-emerald-700">Ciclos de parición</p>
                      <button onClick={() => setCriaActiva(p => ({
                        ...p,
                        ciclos: [...(p.ciclos ?? []), {
                          id: "ciclo_" + Date.now(),
                          servicio: "otoño",
                          paricionMes: 4,
                          paricionAnio: new Date().getFullYear(),
                          mesesDestete: 7,
                          pctPreniez: 85,
                          pctDestete: 75,
                          pesoDesteteKg: 187,
                          ternerosAlPie: 0,
                          pctMachos: 50,
                          estado: "al_pie",
                          ternerosDestetados: 0,
                          fechaDesteReal: null,
                        }]
                      }))}
                        className="text-xs font-black px-3 py-1.5 bg-emerald-100 hover:bg-emerald-200 text-emerald-700 rounded-xl transition-all active:scale-95">
                        + Agregar ciclo
                      </button>
                    </div>
                    {ciclos.map((ciclo, idx) => {
                      const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
                      const MESES_C = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
                      const mesDest = (ciclo.paricionMes + ciclo.mesesDestete) % 12;
                      const anioDest = (ciclo.paricionMes + ciclo.mesesDestete) >= 12 ? ciclo.paricionAnio + 1 : ciclo.paricionAnio;
                      const diasParaDest = Math.round((new Date(anioDest, mesDest, 1) - new Date()) / 86400000);
                      const madresCiclo = criaDatos.vacas + (criaDatos.vaquillonas1??0) + (criaDatos.vaquillonas2??0);
                      const ternNacidos = Math.round(madresCiclo * (ciclo.pctPreniez / 100));
                      const ternDestProyec = Math.round(ternNacidos * (ciclo.pctDestete / 100));
                      const updateCiclo = (patch) => setCriaActiva(p => ({
                        ...p,
                        ciclos: (p.ciclos ?? []).map((c, i) => i === idx ? { ...c, ...patch } : c)
                      }));
                      const deleteCiclo = () => setCriaActiva(p => ({
                        ...p,
                        ciclos: (p.ciclos ?? []).filter((_, i) => i !== idx)
                      }));
                      const isDestetado = ciclo.estado === "destetado";
                      return (
                        <div key={ciclo.id} className={"border-2 rounded-2xl overflow-hidden " + (isDestetado ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white")}>
                          {/* Header del ciclo */}
                          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
                            <div className="flex items-center gap-2">
                              <span className={"text-xs font-black px-2 py-0.5 rounded-full " + (isDestetado ? "bg-emerald-200 text-emerald-800" : "bg-amber-100 text-amber-800")}>
                                {isDestetado ? "✅ Destetado" : "🐄 Al pie"}
                              </span>
                              <select value={ciclo.servicio} onChange={e => updateCiclo({ servicio: e.target.value })}
                                className="text-xs font-black bg-transparent text-slate-700 focus:outline-none">
                                <option value="primavera">Servicio primavera</option>
                                <option value="otoño">Servicio otoño</option>
                                <option value="verano">Servicio verano</option>
                              </select>
                            </div>
                            {ciclos.length > 1 && (
                              <button onClick={deleteCiclo} className="text-xs text-slate-300 hover:text-red-500 font-black px-1">✕</button>
                            )}
                          </div>
                          <div className="p-4 space-y-4">
                            {/* Parición */}
                            <div className="grid grid-cols-3 gap-3">
                              <div className="space-y-1">
                                <span className="text-xs text-slate-500 font-semibold">Mes parición</span>
                                <select value={ciclo.paricionMes} onChange={e => updateCiclo({ paricionMes: Number(e.target.value) })}
                                  className="w-full bg-slate-50 border-2 border-slate-200 rounded-xl px-2 py-2 text-xs font-bold text-slate-800 focus:outline-none focus:border-emerald-400">
                                  {MESES.map((m,i) => <option key={i} value={i}>{m}</option>)}
                                </select>
                              </div>
                              <div className="space-y-1">
                                <span className="text-xs text-slate-500 font-semibold">Año</span>
                                <select value={ciclo.paricionAnio} onChange={e => updateCiclo({ paricionAnio: Number(e.target.value) })}
                                  className="w-full bg-slate-50 border-2 border-slate-200 rounded-xl px-2 py-2 text-xs font-bold text-slate-800 focus:outline-none focus:border-emerald-400">
                                  {[new Date().getFullYear()-1, new Date().getFullYear(), new Date().getFullYear()+1].map(y => <option key={y} value={y}>{y}</option>)}
                                </select>
                              </div>
                              <EditField label="Meses al destete" value={ciclo.mesesDestete} onChange={v => updateCiclo({ mesesDestete: v })} step={1} suffix=" m" hint={"Destete: " + MESES_C[mesDest] + " " + anioDest} minVal={1} />
                            </div>

                            {/* Terneros al pie */}
                            <div className="grid grid-cols-2 gap-3">
                              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                                <p className="text-xs text-slate-500 font-bold mb-1">🐂 Terneros al pie</p>
                                <input type="number" min="0" value={ciclo.ternerosAlPie ?? 0}
                                  onChange={e => updateCiclo({ ternerosAlPie: parseInt(e.target.value)||0 })}
                                  className="w-full text-2xl font-black text-amber-800 bg-transparent focus:outline-none" />
                                <p className="text-xs text-slate-400">sin destetar aún</p>
                              </div>
                              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                                <p className="text-xs text-slate-500 font-bold mb-1">📅 Destete estimado</p>
                                <p className="text-lg font-black text-slate-700">{MESES_C[mesDest]} {anioDest}</p>
                                <p className={"text-xs font-semibold " + (diasParaDest > 0 ? "text-blue-600" : "text-emerald-600")}>
                                  {diasParaDest > 0 ? "Faltan " + diasParaDest + " días" : "✅ Ya podés destetar"}
                                </p>
                              </div>
                            </div>

                            {/* % Preñez y destete */}
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                              <EditField label="% Preñez" value={ciclo.pctPreniez} onChange={v => updateCiclo({ pctPreniez: Math.min(100, Math.max(0, v)) })} step={1} suffix="%" hint={ternNacidos + " terneros nacidos"} />
                              <EditField label="% Destete" value={ciclo.pctDestete} onChange={v => updateCiclo({ pctDestete: Math.min(100, Math.max(0, v)) })} step={1} suffix="%" hint={ternDestProyec + " proyectados"} />
                              <EditField label="Peso destete (kg)" value={ciclo.pesoDesteteKg} onChange={v => updateCiclo({ pesoDesteteKg: Math.max(100, Math.min(300, v)) })} step={5} suffix=" kg" />
                              <EditField label="% Machos" value={ciclo.pctMachos ?? 50} onChange={v => updateCiclo({ pctMachos: Math.min(100, Math.max(0, v)) })} step={1} suffix="%" hint={"Hembras: " + (100 - (ciclo.pctMachos ?? 50)) + "%"} />
                            </div>
                            {/* Proyección machos/hembras */}
                            {ternDestProyec > 0 && (
                              <div className="grid grid-cols-2 gap-2">
                                <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 text-center">
                                  <p className="text-xs text-blue-600 font-bold">♂ Machos proyectados</p>
                                  <p className="font-black text-blue-800 text-xl">{Math.round(ternDestProyec * (ciclo.pctMachos ?? 50) / 100)}</p>
                                  <p className="text-xs text-blue-500">→ recría</p>
                                </div>
                                <div className="bg-rose-50 border border-rose-200 rounded-xl px-3 py-2 text-center">
                                  <p className="text-xs text-rose-600 font-bold">♀ Hembras proyectadas</p>
                                  <p className="font-black text-rose-800 text-xl">{ternDestProyec - Math.round(ternDestProyec * (ciclo.pctMachos ?? 50) / 100)}</p>
                                  <p className="text-xs text-rose-500">→ reposición / venta</p>
                                </div>
                              </div>
                            )}

                            {/* Botón destete */}
                            {!isDestetado && (
                              <DesteteParcialBtn
                                ternerosNoDestetados={ciclo.ternerosAlPie ?? 0}
                                pctMachos={ciclo.pctMachos ?? 50}
                                onDestetar={(cant, machos, hembras) => {
                                  const restantes = Math.max(0, (ciclo.ternerosAlPie ?? 0) - cant);
                                  updateCiclo({
                                    ternerosAlPie: restantes,
                                    ternerosDestetados: (ciclo.ternerosDestetados ?? 0) + cant,
                                    machosDestetados: (ciclo.machosDestetados ?? 0) + machos,
                                    hembrasDestetadas: (ciclo.hembrasDestetadas ?? 0) + hembras,
                                    estado: restantes === 0 ? "destetado" : "al_pie",
                                    fechaDesteReal: restantes === 0 ? new Date().toISOString().slice(0, 10) : ciclo.fechaDesteReal,
                                  });
                                  onToast("✅ " + cant + " destetados — " + machos + " machos, " + hembras + " hembras" + (restantes === 0 ? " — ciclo completo" : " — quedan " + restantes), "success");
                                }}
                              />
                            )}
                            {isDestetado && (
                              <div className="space-y-2">
                                <div className="bg-emerald-100 rounded-xl px-3 py-2 space-y-1">
                                  <div className="flex items-center justify-between">
                                    <span className="text-xs font-black text-emerald-800">✅ {ciclo.ternerosDestetados} destetados — {ciclo.fechaDesteReal ?? "—"}</span>
                                    <button onClick={() => {
                                        // Si ya se había transferido a recría, revertir esa suma primero
                                        if (ciclo.transferidoRecria) {
                                          const machos     = ciclo.machosDestetados ?? 0;
                                          const hembras    = ciclo.hembrasDestetadas ?? 0;
                                          const pctRep      = criaDatos.pctReposicion ?? 30;
                                          const hembrasRep  = Math.round(hembras * pctRep / 100);
                                          const hembrasVta  = hembras - hembrasRep;
                                          setRecriaActiva(p => ({
                                            ...p,
                                            ternerosLiquidaMachos:  Math.max(0, (p.ternerosLiquidaMachos  ?? 0) - machos),
                                            vaquillonaRecria:       Math.max(0, (p.vaquillonaRecria       ?? 0) - hembrasRep),
                                            ternerosLiquidaHembras: Math.max(0, (p.ternerosLiquidaHembras ?? 0) - hembrasVta),
                                          }));
                                        }
                                        updateCiclo({ estado: "al_pie", ternerosAlPie: ciclo.ternerosDestetados, ternerosDestetados: 0, machosDestetados: 0, hembrasDestetadas: 0, fechaDesteReal: null, transferidoRecria: false });
                                      }}
                                      className="text-xs text-slate-400 hover:text-red-500 font-bold">↩ Deshacer</button>
                                  </div>
                                  <div className="flex gap-2">
                                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-bold">♂ {ciclo.machosDestetados ?? 0} machos</span>
                                    <span className="text-xs bg-rose-100 text-rose-700 px-2 py-0.5 rounded-full font-bold">♀ {ciclo.hembrasDestetadas ?? 0} hembras</span>
                                  </div>
                                </div>
                                {/* Estrategia de reposición */}
                                {(ciclo.hembrasDestetadas ?? 0) > 0 && (() => {
                                  const hembras    = ciclo.hembrasDestetadas ?? 0;
                                  const pctRep     = criaDatos.pctReposicion ?? 30;
                                  const paraReponer = Math.round(hembras * pctRep / 100);
                                  const paraVenta   = hembras - paraReponer;
                                  return (
                                    <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 space-y-2">
                                      <p className="text-xs font-black text-rose-700 uppercase tracking-widest">♀ Estrategia hembras</p>
                                      <div className="grid grid-cols-2 gap-2">
                                        <div className="bg-white rounded-xl p-2 text-center border border-rose-200">
                                          <p className="text-xs text-slate-500">Reposición ({pctRep}%)</p>
                                          <p className="text-2xl font-black text-rose-700">{paraReponer}</p>
                                          <p className="text-xs text-slate-400">→ vaquillonas</p>
                                        </div>
                                        <div className="bg-white rounded-xl p-2 text-center border border-rose-200">
                                          <p className="text-xs text-slate-500">Venta ({100-pctRep}%)</p>
                                          <p className="text-2xl font-black text-amber-600">{paraVenta}</p>
                                          <p className="text-xs text-slate-400">→ a recría / liquidar</p>
                                        </div>
                                      </div>
                                      <p className="text-xs text-slate-400">% reposición editable en Stock → Cría → % Reposición</p>
                                    </div>
                                  );
                                })()}
                                {/* Estrategia machos */}
                                {(ciclo.machosDestetados ?? 0) > 0 && (
                                  <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 space-y-2">
                                    <p className="text-xs font-black text-blue-700 uppercase tracking-widest">♂ Estrategia machos</p>
                                    <div className="grid grid-cols-2 gap-2">
                                      <div className="bg-white rounded-xl p-2 text-center border border-blue-200">
                                        <p className="text-xs text-slate-500">Recría propia</p>
                                        <p className="text-2xl font-black text-blue-700">{ciclo.machosDestetados ?? 0}</p>
                                        <p className="text-xs text-slate-400">→ novillos</p>
                                      </div>
                                      <div className="bg-white rounded-xl p-2 text-center border border-blue-200">
                                        <p className="text-xs text-slate-500">Peso entrada</p>
                                        <p className="text-2xl font-black text-blue-700">{ciclo.pesoDesteteKg ?? 187} kg</p>
                                        <p className="text-xs text-slate-400">al inicio recría</p>
                                      </div>
                                    </div>
                                  </div>
                                )}

                                {/* ── Botón: Pasar destetados a Recría ── */}
                                {!ciclo.transferidoRecria && (ciclo.ternerosDestetados ?? 0) > 0 && (() => {
                                  const machos      = ciclo.machosDestetados ?? 0;
                                  const hembras     = ciclo.hembrasDestetadas ?? 0;
                                  const pctRep      = criaDatos.pctReposicion ?? 30;
                                  const hembrasRep  = Math.round(hembras * pctRep / 100);
                                  const hembrasVta  = hembras - hembrasRep;
                                  return (
                                    <button
                                      onClick={() => {
                                        // Sumar al stock real de recría
                                        setRecriaActiva(p => ({
                                          ...p,
                                          ternerosLiquidaMachos:  (p.ternerosLiquidaMachos  ?? 0) + machos,
                                          vaquillonaRecria:       (p.vaquillonaRecria       ?? 0) + hembrasRep,
                                          ternerosLiquidaHembras: (p.ternerosLiquidaHembras ?? 0) + hembrasVta,
                                          pesoEntradaRecria:      ciclo.pesoDesteteKg ?? p.pesoEntradaRecria ?? 187,
                                        }));
                                        // Marcar el ciclo como transferido
                                        updateCiclo({ transferidoRecria: true });
                                        onToast(`✅ Pasados a Recría: ${machos} machos → novillos, ${hembrasRep} hembras → reposición, ${hembrasVta} hembras → venta`, "success");
                                      }}
                                      className="w-full py-3 rounded-2xl bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-700 hover:to-blue-600 text-white font-black text-sm shadow-md transition-all active:scale-95"
                                    >
                                      🐂 Pasar {ciclo.ternerosDestetados} terneros a Recría →
                                    </button>
                                  );
                                })()}

                                {ciclo.transferidoRecria && (
                                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 flex items-center justify-between">
                                    <span className="text-xs font-black text-emerald-700">✅ Ya transferido a Recría</span>
                                    <button
                                      onClick={() => {
                                        // Revertir: restar del stock de recría
                                        const machos      = ciclo.machosDestetados ?? 0;
                                        const hembras     = ciclo.hembrasDestetadas ?? 0;
                                        const pctRep      = criaDatos.pctReposicion ?? 30;
                                        const hembrasRep  = Math.round(hembras * pctRep / 100);
                                        const hembrasVta  = hembras - hembrasRep;
                                        setRecriaActiva(p => ({
                                          ...p,
                                          ternerosLiquidaMachos:  Math.max(0, (p.ternerosLiquidaMachos  ?? 0) - machos),
                                          vaquillonaRecria:       Math.max(0, (p.vaquillonaRecria       ?? 0) - hembrasRep),
                                          ternerosLiquidaHembras: Math.max(0, (p.ternerosLiquidaHembras ?? 0) - hembrasVta),
                                        }));
                                        updateCiclo({ transferidoRecria: false });
                                        onToast("↩ Transferencia a Recría revertida", "warn");
                                      }}
                                      className="text-xs text-slate-400 hover:text-red-500 font-bold">↩ Deshacer</button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
  
                  {/* Machos/hembras + reposición */}
                  <div>
                    <p className="text-xs font-black uppercase tracking-widest text-emerald-700 mb-3">Distribución destete y reposición</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                      <div className="space-y-2">
                        <div className="flex justify-between text-xs font-bold">
                          <span className="text-blue-700">♂ Machos {criaDatos.pctMachos??50}%</span>
                          <span className="text-rose-600">♀ Hembras {100-(criaDatos.pctMachos??50)}%</span>
                        </div>
                        <div className="h-5 rounded-full overflow-hidden flex">
                          <div className="bg-blue-400 flex items-center justify-center text-white text-xs font-black transition-all" style={{width:`${criaDatos.pctMachos??50}%`}}>{criaDatos.pctMachos??50}%</div>
                          <div className="bg-rose-400 flex-1 flex items-center justify-center text-white text-xs font-black">{100-(criaDatos.pctMachos??50)}%</div>
                        </div>
                        <input type="range" min="40" max="60" step="1" value={criaDatos.pctMachos??50}
                          onChange={e=>setCriaActiva(p=>({...p,pctMachos:Number(e.target.value)}))}
                          className="w-full accent-blue-500" />
                      </div>
                      <div className="space-y-2">
                        <div className="flex justify-between text-xs font-bold">
                          <span className="text-emerald-700">🔄 Reposición {criaDatos.pctReposicion??30}%</span>
                          <span className="text-amber-700">→ Venta {100-(criaDatos.pctReposicion??30)}%</span>
                        </div>
                        <div className="h-5 rounded-full overflow-hidden flex">
                          <div className="bg-emerald-400 flex items-center justify-center text-white text-xs font-black transition-all" style={{width:`${criaDatos.pctReposicion??30}%`}}>{criaDatos.pctReposicion??30}%</div>
                          <div className="bg-amber-400 flex-1 flex items-center justify-center text-white text-xs font-black">{100-(criaDatos.pctReposicion??30)}%</div>
                        </div>
                        <input type="range" min="0" max="100" step="5" value={criaDatos.pctReposicion??30}
                          onChange={e=>setCriaActiva(p=>({...p,pctReposicion:Number(e.target.value)}))}
                          className="w-full accent-emerald-500" />
                      </div>
                    </div>
                  </div>
  
                  {/* Resumen calculado */}
                  {(() => {
                    const madres = (criaDatos.vacas||0) + (criaDatos.vaquillonas1??criaDatos.vaquillonas??0);
                    const pren   = Math.round(madres * (criaDatos.pctPreniez??85) / 100);
                    const nacidos= Math.round(pren * (1 - (criaDatos.pctMortandadCria??2)/100));
                    const dest   = Math.round(nacidos * (criaDatos.pctDestete??75) / 100);
                    const machos = Math.round(dest * (criaDatos.pctMachos??50) / 100);
                    const hembras= dest - machos;
                    const repos  = Math.round(hembras * (criaDatos.pctReposicion??30) / 100);
                    const venta  = hembras - repos;
                    return (
                      <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                        <div><p className="text-xs text-emerald-600">Terneros nacidos</p><p className="font-black text-emerald-900 text-xl">{nacidos}</p></div>
                        <div><p className="text-xs text-emerald-600">Total destete</p><p className="font-black text-emerald-900 text-xl">{dest}</p></div>
                        <div><p className="text-xs text-blue-600">Machos → recría</p><p className="font-black text-blue-800 text-xl">{machos}</p></div>
                        <div><p className="text-xs text-amber-600">Hembras → venta</p><p className="font-black text-amber-800 text-xl">{venta}</p></div>
                      </div>
                    );
                  })()}
                  {/* ── Botón Destetar ── */}
                  {(() => {
                    const madres       = (criaDatos.vacas||0) + (criaDatos.vaquillonas1??criaDatos.vaquillonas??0);
                    const pren         = Math.round(madres * (criaDatos.pctPreniez ?? 85) / 100);
                    const nacidos      = Math.round(pren * (1 - (criaDatos.pctMortandadCria ?? 2) / 100));
                    const destTotal    = Math.round(nacidos * (criaDatos.pctDestete ?? 75) / 100);
                    const machos       = Math.round(destTotal * (criaDatos.pctMachos ?? 50) / 100);
                    const hembras      = destTotal - machos;
                    // Cuánto ya pasó a recría como marca líquida
                    const yaEnRecria   = reciaDatos.ternerosLiquidaMachos + reciaDatos.ternerosLiquidaHembras;
                    const pendiente    = Math.max(0, destTotal - yaEnRecria);
                    const machosPend   = Math.round(pendiente * (criaDatos.pctMachos ?? 50) / 100);
                    const hembrasPend  = pendiente - machosPend;
                    const todoDestetado= pendiente === 0 && yaEnRecria > 0;
  
                    if (todoDestetado) return (
                      <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-4 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="text-lg">✅</span>
                          <div>
                            <p className="text-xs font-black text-emerald-700">Destete completo — {destTotal} terneros en Recría</p>
                            <p className="text-xs text-emerald-600">{reciaDatos.ternerosLiquidaMachos}M + {reciaDatos.ternerosLiquidaHembras}H como marca líquida</p>
                          </div>
                        </div>
                        <button onClick={() => onSincronizar({ _accion: "deshacer-destete", machos: reciaDatos.ternerosLiquidaMachos, hembras: reciaDatos.ternerosLiquidaHembras })}
                          className="text-xs font-black text-slate-400 hover:text-red-500 border border-dashed border-slate-200 hover:border-red-300 px-3 py-1.5 rounded-xl transition-all shrink-0">
                          ↩ Deshacer
                        </button>
                      </div>
                    );
  
                    return (
                      <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-black uppercase tracking-widest text-emerald-700">🍼 Destetar y pasar a Recría</p>
                      {(() => {
                        const pMes = criaDatos.paricionMes ?? 9;
                        const pAnio = criaDatos.paricionAnio ?? new Date().getFullYear();
                        const mDest = criaDatos.mesesDestete ?? 6;
                        const destMes = (pMes + mDest) % 12;
                        const destAnio = (pMes + mDest) >= 12 ? pAnio + 1 : pAnio;
                        const diasParaDest = Math.round((new Date(destAnio, destMes, 1) - new Date()) / 86400000);
                        const MESES_C = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
                        return diasParaDest > 0 ? (
                          <p className="text-xs text-blue-600 font-semibold">
                            🗓 Fecha estimada de destete: <b>{MESES_C[destMes]} {destAnio}</b> — faltan {diasParaDest} días
                          </p>
                        ) : (
                          <p className="text-xs text-emerald-600 font-semibold">✅ Mes de destete alcanzado — podés destetar ahora</p>
                        );
                      })()}
                          {yaEnRecria > 0 && <span className="text-xs font-bold text-emerald-600 bg-emerald-100 border border-emerald-300 px-2 py-0.5 rounded-full">{yaEnRecria} ya en recría</span>}
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="bg-white rounded-xl border border-emerald-200 py-2">
                            <p className="text-xs text-emerald-600">Pendiente</p>
                            <p className="font-black text-emerald-900 text-lg">{pendiente}</p>
                          </div>
                          <div className="bg-white rounded-xl border border-blue-200 py-2">
                            <p className="text-xs text-blue-600">Machos</p>
                            <p className="font-black text-blue-800 text-lg">{machosPend}</p>
                          </div>
                          <div className="bg-white rounded-xl border border-rose-200 py-2">
                            <p className="text-xs text-rose-600">Hembras</p>
                            <p className="font-black text-rose-700 text-lg">{hembrasPend}</p>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            disabled={pendiente === 0}
                            onClick={() => {
                            const hVenta = Math.round(hembrasPend * (1 - (criaDatos.pctReposicion??100)/100));
                            const hRepos = hembrasPend - hVenta;
                            onSincronizar({ _accion: "pasar-destete-recria", machos: machosPend, hembrasVenta: hVenta, hembrasReposicion: hRepos });
                          }}
                            className={`flex items-center justify-center gap-2 font-black text-sm px-4 py-3 rounded-2xl transition-all active:scale-95
                              ${pendiente === 0 ? "bg-slate-200 text-slate-400 cursor-not-allowed" : "bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white shadow-md"}`}>
                            <RefreshCw size={14}/>
                            Destetar {pendiente} terneros
                          </button>
                          {yaEnRecria > 0 && (
                            <button onClick={() => onSincronizar({ _accion: "deshacer-destete", machos: reciaDatos.ternerosLiquidaMachos, hembras: reciaDatos.ternerosLiquidaHembras })}
                              className="flex items-center justify-center gap-2 text-slate-500 font-black text-sm px-4 py-3 rounded-2xl border-2 border-dashed border-slate-200 hover:border-red-300 hover:text-red-500 transition-all">
                              ↩ Deshacer
                            </button>
                          )}
                        </div>
                        <p className="text-xs text-emerald-600 text-center">Las vacas quedan libres · Los terneros pasan a Recría como marca líquida</p>
                      </div>
                    );
                  })()}
  
                  <button
                    onClick={() => onSincronizar({
                      target: "vientres",
                      descripcion: `${(criaDatos.vacas||0)+(criaDatos.vaquillonas1??criaDatos.vaquillonas??0)} madres · ${(criaDatos.vacas||0)+(criaDatos.vaquillonas1??criaDatos.vaquillonas??0) > 0 ? Math.round(totalTernerosAlPie/((criaDatos.vacas||0)+(criaDatos.vaquillonas1??criaDatos.vaquillonas??0))*100) : 0}% destete · datos reales de cría`,
                      inputs: {
                        cantidad: (criaDatos.vacas||0) + (criaDatos.vaquillonas1??criaDatos.vaquillonas??0),
                        pesoCompra: 380,
                        precioKgCompra: 1800,
                        precioBulto: 350000,
                        mesesRecriaPreServicio: 15,
                        anosVidaUtil: 6,
                        kgIatf: 8,
                        pctDestete: Math.round(totalTernerosAlPie / (criaDatos.vacas + (criaDatos.vaquillonas1??criaDatos.vaquillonas??0) + (criaDatos.vaquillonas2??0)) * 100),
                        pesoTerneroDestetado: 160,
                        precioTerneroKg: 2000,
                        pesoVacaDescarte: 380,
                        precioDescarteSalidaKg: 1600,
                        kgToros: 3,
                        mesesSuplTerneras: [],
                        costoSuplTernerasMes: 12000,
                        mesesSuplVacas: [],
                        costoSuplVacasMes: 15000,
                        anosSuplementacion: 6,
                        kreepOn: false,
                        kreepMeses: 3,
                        kreepCostoMes: 8000,
                        kreepKgExtra: 15,
                      }
                    })}
                    className="mt-4 w-full flex items-center justify-center gap-2 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white font-black text-sm px-5 py-3 rounded-2xl shadow-md transition-all active:scale-95 group">
                    <RefreshCw size={16} className="group-hover:rotate-180 transition-transform duration-500" />
                    Simular ROI del rodeo en Proyecto Vientres
                  </button>
                </div>
              </div>
            </div>
          )}
  
          {/* ── DETALLE RECRÍA ───────────────────────────────────────────── */}
          {seccion === "stock" && subStock === "recria" && (
            <div className="sim-zoom-enter space-y-4">
              <button onClick={() => { setSnapRecria(null); setSubStock(null); }} className="flex items-center gap-2 text-slate-500 hover:text-slate-800 text-xs font-bold uppercase tracking-widest transition-colors">
                <ArrowLeft size={14} /> Volver a stock
              </button>
              <SaveUndoBar
                modificado={snapRecria !== null}
                onGuardar={async () => { await guardarEstado(vacaStore.getState().__userEmail); setSnapRecria(null); }}
                onDeshacer={deshacerRecria}
              />
              <div className="bg-white border-2 border-blue-200 rounded-3xl overflow-hidden shadow-lg">
                <div className="h-1.5 bg-gradient-to-r from-blue-400 to-indigo-400" />
                <div className="p-5 md:p-6">
                  <p className="text-xs font-black uppercase tracking-widest text-blue-700 mb-5">Recría — detalle</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                    <EditField label="Terneros marca líquida — machos" value={reciaDatos.ternerosLiquidaMachos} onChange={v=>setRecriaActiva(p=>({...p,ternerosLiquidaMachos:v}))} hint="Destetados de la cría propia" />
                    <EditField label="Terneros marca líquida — hembras" value={reciaDatos.ternerosLiquidaHembras} onChange={v=>setRecriaActiva(p=>({...p,ternerosLiquidaHembras:v}))} hint="Candidatas a vaquillonas o venta" />
                    <EditField label="Terneros compra — machos" value={reciaDatos.ternerosCompraMachos} onChange={v=>setRecriaActiva(p=>({...p,ternerosCompraMachos:v}))} hint="Comprados para invernar" />
                    <EditField label="Terneros compra — hembras" value={reciaDatos.ternerosCompraHembras} onChange={v=>setRecriaActiva(p=>({...p,ternerosCompraHembras:v}))} hint="Compradas para recría" />
                    <EditField label="Novillos en recría" value={reciaDatos.novillos} onChange={v=>setRecriaActiva(p=>({...p,novillos:v}))} hint="En camino a terminación" />
                    <EditField label="Vaquillona Recría" value={reciaDatos.vaquillonaRecria??0} onChange={v=>setRecriaActiva(p=>({...p,vaquillonaRecria:v}))} hint="Vaquillonas en etapa de recría" />
                    <EditField label="MEJ (Mejoramiento)" value={reciaDatos.mej??0} onChange={v=>setRecriaActiva(p=>({...p,mej:v}))} hint="Animales de mejoramiento genético" />
                    <div className="sm:col-span-2 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <p className="text-xs text-slate-500 font-semibold">⚡ GDP Novillo invernada</p>
                        <div className="flex items-center gap-2">
                          <button onClick={()=>setGdpNovilloInv(v=>Math.max(0,Math.round((v-0.1)*10)/10))}
                            className="w-7 h-7 rounded-lg bg-blue-700 text-white font-black flex items-center justify-center text-xs active:scale-95">−</button>
                          <div className="flex-1 bg-blue-50 border-2 border-blue-200 rounded-xl text-center py-1">
                            <span className="font-mono font-black text-base text-blue-800">{gdpNovilloInv.toFixed(1)}</span>
                            <span className="text-xs text-blue-600 ml-1">kg/d</span>
                          </div>
                          <button onClick={()=>setGdpNovilloInv(v=>Math.min(1.5,Math.round((v+0.1)*10)/10))}
                            className="w-7 h-7 rounded-lg bg-blue-700 text-white font-black flex items-center justify-center text-xs active:scale-95">+</button>
                        </div>
                        <input type="range" min="0" max="1.5" step="0.1" value={gdpNovilloInv}
                          onChange={e=>setGdpNovilloInv(Math.round(parseFloat(e.target.value)*10)/10)}
                          className="w-full accent-blue-500"/>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-slate-500 font-semibold">⚡ GDP Vaquillona desc.</p>
                        <div className="flex items-center gap-2">
                          <button onClick={()=>setGdpVaquillonaDesc(v=>Math.max(0,Math.round((v-0.1)*10)/10))}
                            className="w-7 h-7 rounded-lg bg-rose-700 text-white font-black flex items-center justify-center text-xs active:scale-95">−</button>
                          <div className="flex-1 bg-rose-50 border-2 border-rose-200 rounded-xl text-center py-1">
                            <span className="font-mono font-black text-base text-rose-800">{gdpVaquillonaDesc.toFixed(1)}</span>
                            <span className="text-xs text-rose-600 ml-1">kg/d</span>
                          </div>
                          <button onClick={()=>setGdpVaquillonaDesc(v=>Math.min(1.5,Math.round((v+0.1)*10)/10))}
                            className="w-7 h-7 rounded-lg bg-rose-700 text-white font-black flex items-center justify-center text-xs active:scale-95">+</button>
                        </div>
                        <input type="range" min="0" max="1.5" step="0.1" value={gdpVaquillonaDesc}
                          onChange={e=>setGdpVaquillonaDesc(Math.round(parseFloat(e.target.value)*10)/10)}
                          className="w-full accent-rose-500"/>
                      </div>
                    </div>
                  </div>
                  <EditField label="% Mortandad recría" value={reciaDatos.pctMortandadRecria??2} onChange={v=>setRecriaActiva(p=>({...p,pctMortandadRecria:Math.min(10,Math.max(0,v))}))} step={0.5} suffix="%" hint="0% a 10% · afecta rendimiento" />

                  {/* ── Reposición — costo de compra del ciclo ── */}
                  <div className="bg-amber-50 border-2 border-amber-200 rounded-2xl p-4 space-y-3">
                    <p className="text-xs font-black uppercase tracking-widest text-amber-700">🔄 Reposición — compra de terneros</p>
                    <p className="text-xs text-amber-600">Cargá cuántos terneros compraste externamente y a qué precio para cerrar el ciclo anual. Impacta directamente en el margen de Recría.</p>
                    <EditField label="Cabezas compradas" value={reciaDatos.cabCompradasRecria??0} onChange={v=>setRecriaActiva(p=>({...p,cabCompradasRecria:Math.max(0,v)}))} step={1} hint="0 si todos vienen del destete propio" />
                    <EditField label="Peso entrada (kg/cab)" value={reciaDatos.pesoEntradaRecria??180} onChange={v=>setRecriaActiva(p=>({...p,pesoEntradaRecria:Math.max(100,v)}))} step={5} suffix="kg" hint="Peso promedio al ingreso a recría" />
                    <EditField label="Precio de compra ($/kg)" value={reciaDatos.precioCompraKgRecria??0} onChange={v=>setRecriaActiva(p=>({...p,precioCompraKgRecria:Math.max(0,v)}))} step={50} prefix="$" hint="Precio ternero entrada · 0 = solo destete propio" />
                    {(reciaDatos.cabCompradasRecria??0) > 0 && (reciaDatos.precioCompraKgRecria??0) > 0 && (
                      <div className="bg-white rounded-xl px-3 py-2 flex justify-between items-center border border-amber-200">
                        <span className="text-xs text-amber-700 font-bold">Costo reposición total</span>
                        <span className="font-black text-amber-800">${Math.round((reciaDatos.cabCompradasRecria??0) * (reciaDatos.pesoEntradaRecria??180) * (reciaDatos.precioCompraKgRecria??0)).toLocaleString("es-AR")}</span>
                      </div>
                    )}
                  </div>
                  </div>
                  <div className="mt-5 p-4 bg-blue-50 border border-blue-200 rounded-2xl space-y-2">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                      {[
                        ["Total recría", reciaDatos.ternerosLiquidaMachos+reciaDatos.ternerosLiquidaHembras+reciaDatos.ternerosCompraMachos+reciaDatos.ternerosCompraHembras+reciaDatos.novillos],
                        ["Marca líquida", reciaDatos.ternerosLiquidaMachos+reciaDatos.ternerosLiquidaHembras],
                        ["Compra", reciaDatos.ternerosCompraMachos+reciaDatos.ternerosCompraHembras],
                        ["Novillos", reciaDatos.novillos],
                      ].map(([l,v]) => (
                        <div key={l}><p className="text-xs text-blue-600">{l}</p><p className="font-black text-blue-900 text-xl">{v}</p></div>
                      ))}
                    </div>
                    {(reciaDatos.ternerosLiquidaMachos+reciaDatos.ternerosLiquidaHembras) > 0 && (
                      <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
                        <span className="text-sm">✓</span>
                        <p className="text-xs text-emerald-700 font-semibold">
                          {reciaDatos.ternerosLiquidaMachos+reciaDatos.ternerosLiquidaHembras} terneros destetados en recría —
                          {reciaDatos.ternerosLiquidaMachos}M + {reciaDatos.ternerosLiquidaHembras}H
                        </p>
                      </div>
                    )}
                    {(reciaDatos.ternerosLiquidaMachos+reciaDatos.ternerosLiquidaHembras) === 0 && (
                      <p className="text-xs text-slate-400 text-center">Sin marca líquida — destetá desde Cría para agregar terneros</p>
                    )}
                  </div>
                  <button
                      onClick={() => onSincronizar({
                        target: "poder",
                        descripcion: `${reciaDatos.ternerosCompraMachos+reciaDatos.ternerosCompraHembras > 0 ? reciaDatos.ternerosCompraMachos+reciaDatos.ternerosCompraHembras+" terneros compra" : "nueva compra"} · simulando poder de compra`,
                        venta: {
                          cantidad: Math.max(1, reciaDatos.ternerosCompraMachos + reciaDatos.ternerosCompraHembras),
                          pesoPromedio: 180,
                          precioKg: 2200,
                        }
                      })}
                      className="mt-4 w-full flex items-center justify-center gap-2 bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white font-black text-sm px-5 py-3 rounded-2xl shadow-md transition-all active:scale-95 group">
                      <RefreshCw size={16} className="group-hover:rotate-180 transition-transform duration-500" />
                      Simular compra en Poder de Compra
                    </button>
                </div>
              </div>

              {/* ── Panel Venta / Feedlot ────────────────────────────────── */}
              {(() => {
                const totalRecria = reciaDatos.ternerosLiquidaMachos + reciaDatos.ternerosCompraMachos + reciaDatos.novillos;
                if (totalRecria === 0) return null;

                const CATS = [
                  { key:"ternerosLiquidaMachos", label:"Terneros marca M",  icon:"🐄", color:"emerald", peso: pesoTerneroAlCierre,    pesoEntrada: pesoDestete2,                        gdp: gdpNovilloInv   },
                  { key:"ternerosCompraMachos",  label:"Terneros compra M", icon:"🛒", color:"blue",    peso: pesoNovilloInvAlCierre, pesoEntrada: reciaDatos.pesoEntradaRecria ?? 180, gdp: gdpNovilloInv   },
                  { key:"novillos",              label:"Novillos",          icon:"🐂", color:"amber",   peso: pesoNovilloInvAlCierre, pesoEntrada: reciaDatos.pesoEntradaRecria ?? 200, gdp: gdpNovilloFaena },
                ].filter(c => reciaDatos[c.key] > 0);

                return (
                  <div className="bg-white border-2 border-slate-100 rounded-3xl overflow-hidden shadow-lg">
                    <div className="h-1.5 bg-gradient-to-r from-blue-400 to-amber-400"/>
                    <div className="p-5 space-y-4">
                      <p className="text-xs font-black uppercase tracking-widest text-slate-600">🐂 Decisión de venta / feedlot</p>
                      <p className="text-xs text-slate-400">Elegí cuántos animales querés vender como invernada o mandar a feedlot, y simulá en el calculador.</p>

                      {CATS.map(cat => {
                        const total = reciaDatos[cat.key];
                        return (
                          <div key={cat.key} className={`border-2 border-${cat.color}-100 bg-${cat.color}-50 rounded-2xl p-4 space-y-3`}>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span>{cat.icon}</span>
                                <p className={`text-xs font-black uppercase tracking-widest text-${cat.color}-700`}>{cat.label}</p>
                              </div>
                              <div className="text-right">
                                <p className="text-xs text-slate-400">Stock: <b className="text-slate-700">{total} cab</b></p>
                                <p className="text-xs text-slate-400">Entrada: <b className="text-slate-600">{cat.pesoEntrada} kg</b> → Peso est.: <b className="text-slate-700">{cat.peso} kg/cab</b></p>
                              </div>
                            </div>

                            {/* Botones directos al simulador */}
                            <div className="grid grid-cols-2 gap-2">
                              <button
                                onClick={() => onSincronizar({
                                  target: "invernada",
                                  descripcion: `${total} ${cat.label} · ${cat.peso} kg · invernada vs feedlot`,
                                  base: { cantidad: total, pesoIngreso: cat.pesoEntrada, precioCompraKg: 1800 },
                                })}
                                className="flex items-center justify-center gap-1.5 bg-white border-2 border-emerald-300 hover:bg-emerald-50 text-emerald-700 font-black text-xs px-3 py-2.5 rounded-xl transition-all active:scale-95 group">
                                <RefreshCw size={12} className="group-hover:rotate-180 transition-transform"/>
                                🌿 Simular invernada
                              </button>
                              <button
                                onClick={() => onSincronizar({
                                  target: "poder",
                                  descripcion: `Venta ${total} ${cat.label} ${cat.peso}kg → simular reposición`,
                                  venta: { cantidad: total, pesoPromedio: cat.peso, precioKg: 2200 },
                                })}
                                className="flex items-center justify-center gap-1.5 bg-white border-2 border-blue-300 hover:bg-blue-50 text-blue-700 font-black text-xs px-3 py-2.5 rounded-xl transition-all active:scale-95 group">
                                <RefreshCw size={12} className="group-hover:rotate-180 transition-transform"/>
                                💰 Simular reposición
                              </button>
                            </div>

                            {/* Barra para elegir cuántos a feedlot vs invernada */}
                            <div className="space-y-1.5">
                              <div className="flex justify-between text-xs font-bold">
                                <span className="text-emerald-600">🌿 Invernada: {total - Math.round(total * (reciaDatos[cat.key + "_feedlotPct"] || 0) / 100)} cab</span>
                                <span className="text-amber-600">🏭 Feedlot: {Math.round(total * (reciaDatos[cat.key + "_feedlotPct"] || 0) / 100)} cab</span>
                              </div>
                              <div className="h-4 rounded-full overflow-hidden flex">
                                <div className="bg-emerald-400 transition-all flex items-center justify-center text-white text-xs font-black"
                                  style={{width:`${100-(reciaDatos[cat.key+"_feedlotPct"]||0)}%`}}>
                                  {100-(reciaDatos[cat.key+"_feedlotPct"]||0)}%
                                </div>
                                <div className="bg-amber-400 flex-1 flex items-center justify-center text-white text-xs font-black">
                                  {reciaDatos[cat.key+"_feedlotPct"]||0}%
                                </div>
                              </div>
                              <input type="range" min="0" max="100" step="10"
                                value={reciaDatos[cat.key+"_feedlotPct"]||0}
                                onChange={e=>setRecriaActiva(p=>({...p,[cat.key+"_feedlotPct"]:Number(e.target.value)}))}
                                className="w-full accent-amber-500"/>
                              <div className="grid grid-cols-2 gap-2 mt-1">
                                <button
                                  disabled={total - Math.round(total*(reciaDatos[cat.key+"_feedlotPct"]||0)/100) === 0}
                                  onClick={() => onSincronizar({
                                    target: "invernada",
                                    descripcion: `${total - Math.round(total*(reciaDatos[cat.key+"_feedlotPct"]||0)/100)} ${cat.label} invernada directa`,
                                    base: {
                                      cantidad: total - Math.round(total*(reciaDatos[cat.key+"_feedlotPct"]||0)/100),
                                      pesoIngreso: cat.pesoEntrada, precioCompraKg: 1800,
                                    },
                                  })}
                                  className="text-xs bg-emerald-500 disabled:opacity-40 hover:bg-emerald-600 text-white font-black px-3 py-2 rounded-xl transition-all active:scale-95">
                                  Simular {total - Math.round(total*(reciaDatos[cat.key+"_feedlotPct"]||0)/100)} como invernada
                                </button>
                                <button
                                  disabled={Math.round(total*(reciaDatos[cat.key+"_feedlotPct"]||0)/100) === 0}
                                  onClick={() => onSincronizar({
                                    target: "invernada",
                                    descripcion: `${Math.round(total*(reciaDatos[cat.key+"_feedlotPct"]||0)/100)} ${cat.label} a feedlot`,
                                    base: {
                                      cantidad: Math.round(total*(reciaDatos[cat.key+"_feedlotPct"]||0)/100),
                                      pesoIngreso: cat.pesoEntrada, precioCompraKg: 1800,
                                    },
                                  })}
                                  className="text-xs bg-amber-500 disabled:opacity-40 hover:bg-amber-600 text-white font-black px-3 py-2 rounded-xl transition-all active:scale-95">
                                  Simular {Math.round(total*(reciaDatos[cat.key+"_feedlotPct"]||0)/100)} a feedlot
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
  
          {/* ── DETALLE TERMINACIÓN ──────────────────────────────────────── */}
          {seccion === "stock" && subStock === "terminacion" && (
            <div className="sim-zoom-enter space-y-4">
              <button onClick={() => { setSnapTerminacion(null); setSubStock(null); }} className="flex items-center gap-2 text-slate-500 hover:text-slate-800 text-xs font-bold uppercase tracking-widest transition-colors">
                <ArrowLeft size={14} /> Volver a stock
              </button>
              <SaveUndoBar
                modificado={snapTerminacion !== null}
                onGuardar={async () => { await guardarEstado(vacaStore.getState().__userEmail); setSnapTerminacion(null); }}
                onDeshacer={deshacerTerminacion}
              />
              <div className="bg-white border-2 border-amber-200 rounded-3xl overflow-hidden shadow-lg">
                <div className="h-1.5 bg-gradient-to-r from-amber-400 to-orange-400" />
                <div className="p-5 md:p-6 space-y-5">
                  <p className="text-xs font-black uppercase tracking-widest text-amber-700">Terminación — detalle</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                    <EditField label="Novillos en campo" value={terminacionDatos.novillosCampo} onChange={v=>setTermActiva(p=>({...p,novillosCampo:v}))} />
                    <EditField label="Novillos en feedlot" value={terminacionDatos.novillosFeedlot} onChange={v=>setTermActiva(p=>({...p,novillosFeedlot:v}))} />
                    <EditField label="MEJ Terminación" value={terminacionDatos.mejTerminacion??0} onChange={v=>setTermActiva(p=>({...p,mejTerminacion:v}))} hint="Mejoramiento en terminación" />
                    <EditField label="Vaca Engorde" value={terminacionDatos.vacaEngorde??0} onChange={v=>setTermActiva(p=>({...p,vacaEngorde:v}))} hint="Vacas CUT transferidas de Cría" />
                    <EditField label="Vaq Engorde" value={terminacionDatos.vaqEngorde??0} onChange={v=>setTermActiva(p=>({...p,vaqEngorde:v}))} hint="Vaq Rechazo transferidas de Cría" />
                    <EditField label="Peso promedio (kg)" value={terminacionDatos.pesoPromedioKg} onChange={v=>setTermActiva(p=>({...p,pesoPromedioKg:v}))} step={5} suffix=" kg" />
                    <EditField label="Días para venta" value={terminacionDatos.diasRestantes} onChange={v=>setTermActiva(p=>({...p,diasRestantes:v}))} suffix=" días" />
                    <div className="space-y-1">
                    <p className="text-xs text-slate-500 font-semibold">⚡ GDP Feedlot / terminación</p>
                    <div className="flex items-center gap-2">
                      <button onClick={()=>setGdpNovilloFaena(v=>Math.max(0,Math.round((v-0.1)*10)/10))}
                        className="w-8 h-8 rounded-lg bg-amber-700 text-white font-black flex items-center justify-center text-sm active:scale-95">−</button>
                      <div className="flex-1 bg-amber-50 border-2 border-amber-200 rounded-xl text-center py-1.5">
                        <span className="font-mono font-black text-lg text-amber-800">{gdpNovilloFaena.toFixed(1)}</span>
                        <span className="text-xs text-amber-600 ml-1">kg/día</span>
                      </div>
                      <button onClick={()=>setGdpNovilloFaena(v=>Math.min(1.5,Math.round((v+0.1)*10)/10))}
                        className="w-8 h-8 rounded-lg bg-amber-700 text-white font-black flex items-center justify-center text-sm active:scale-95">+</button>
                    </div>
                    <input type="range" min="0" max="1.5" step="0.1" value={gdpNovilloFaena}
                      onChange={e=>setGdpNovilloFaena(Math.round(parseFloat(e.target.value)*10)/10)}
                      className="w-full accent-amber-500"/>
                    <p className="text-xs text-slate-400 italic">Típico feedlot: 1.1 kg/día</p>
                  </div>
                  <EditField label="% Mortandad feedlot" value={terminacionDatos.pctMortandadFeedlot??2} onChange={v=>setTermActiva(p=>({...p,pctMortandadFeedlot:Math.min(10,Math.max(0,v))}))} step={0.5} suffix="%" hint="0% a 10% · afecta rendimiento" />
                  </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                    <button
                      onClick={() => onSincronizar({
                        target: "poder",
                        descripcion: `${terminacionDatos.novillosCampo+terminacionDatos.novillosFeedlot} novillos ${terminacionDatos.pesoPromedioKg} kg · ¿cuántos terneros puedo reponer?`,
                        venta: {
                          cantidad: terminacionDatos.novillosCampo + terminacionDatos.novillosFeedlot,
                          pesoPromedio: terminacionDatos.pesoPromedioKg,
                          precioKg: 2200,
                        }
                      })}
                      className="flex items-center justify-center gap-2 bg-gradient-to-r from-slate-800 to-slate-700 hover:from-slate-700 hover:to-slate-600 text-white font-black text-xs px-4 py-3 rounded-2xl shadow-md transition-all active:scale-95 group">
                      <RefreshCw size={14} className="group-hover:rotate-180 transition-transform duration-500" />
                      ¿Cuántos terneros repongo?
                    </button>
                    <button
                      onClick={() => onSincronizar({
                        target: "invernada",
                        descripcion: `${terminacionDatos.novillosCampo+terminacionDatos.novillosFeedlot} novillos · ${terminacionDatos.pesoPromedioKg} kg · campo vs feedlot`,
                        base: {
                          cantidad: terminacionDatos.novillosCampo + terminacionDatos.novillosFeedlot,
                          pesoIngreso: terminacionDatos.pesoPromedioKg,
                          precioCompraKg: 1800,
                        }
                      })}
                      className="flex items-center justify-center gap-2 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-black text-xs px-4 py-3 rounded-2xl shadow-md transition-all active:scale-95 group">
                      <RefreshCw size={14} className="group-hover:rotate-180 transition-transform duration-500" />
                      Comparar campo vs feedlot
                    </button>
                  </div>
                {terminacionDatos.novillosFeedlot > 0 && (
                    <div className="section-amber rounded-2xl border-2 p-4 space-y-4">
                      <p className="text-xs font-black uppercase tracking-widest text-amber-700">Costos feedlot</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                        <EditField label="Comida / cab / día" value={terminacionDatos.costoComidaDia} onChange={v=>setTerminacion(p=>({...p,costoComidaDia:v}))} step={500} prefix="$" usdVal={usd(terminacionDatos.costoComidaDia)} />
                        <EditField label="Hotelería / cab / día" value={terminacionDatos.costoHoteleriaDia} onChange={v=>setTerminacion(p=>({...p,costoHoteleriaDia:v}))} step={100} prefix="$" usdVal={usd(terminacionDatos.costoHoteleriaDia)} />
                        <EditField label="Días de feedlot (ciclo)" value={terminacionDatos.diasFeedlot ?? 100} onChange={v=>setTerminacion(p=>({...p,diasFeedlot:v}))} step={10} suffix=" días" hint="Duración del ciclo de engorde — típico 90 a 120 días" />
                      </div>
                      <div className="bg-white rounded-xl border border-amber-200 p-3 grid grid-cols-3 gap-3 text-center">
                        <div><p className="text-xs text-amber-600">Costo/cab/día</p><p className="font-black text-amber-900">{fmtMoney(terminacionDatos.costoComidaDia+terminacionDatos.costoHoteleriaDia)}</p><p className="text-xs text-emerald-600">{usd(terminacionDatos.costoComidaDia+terminacionDatos.costoHoteleriaDia)}</p></div>
                        <div><p className="text-xs text-amber-600">Costo mensual total</p><p className="font-black text-amber-900">{fmtMoney(feedlotMes)}</p><p className="text-xs text-emerald-600">{usd(feedlotMes)}</p></div>
                        <div><p className="text-xs text-amber-600">Hasta venta ({terminacionDatos.diasRestantes}d)</p><p className="font-black text-amber-900">{fmtMoney(terminacionDatos.novillosFeedlot*(terminacionDatos.costoComidaDia+terminacionDatos.costoHoteleriaDia)*terminacionDatos.diasRestantes)}</p><p className="text-xs text-emerald-600">{usd(terminacionDatos.novillosFeedlot*(terminacionDatos.costoComidaDia+terminacionDatos.costoHoteleriaDia)*terminacionDatos.diasRestantes)}</p></div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ── EXPORTACIÓN ─────────────────────────────────────────── */}
              <div className="bg-white border-2 border-purple-200 rounded-3xl overflow-hidden shadow-lg">
                <div className="h-1.5 bg-gradient-to-r from-purple-400 to-indigo-500"/>
                <div className="p-5 space-y-5">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">🌎</span>
                    <div>
                      <p className="text-xs font-black uppercase tracking-widest text-purple-700">Exportación</p>
                      <p className="text-xs text-slate-400">Dólar oficial: ${fmtMoney(dolarExp).replace("$","")} · Retenciones: 9%</p>
                    </div>
                  </div>

                  {/* Cuota Hilton */}
                  <div className="bg-purple-50 border border-purple-200 rounded-2xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-black uppercase tracking-widest text-purple-700">🥩 Cuota Hilton — terminación a pasto</p>
                      {cabHilton > 0 && <span className={`text-xs font-black px-2 py-0.5 rounded-full ${hiltonMargen >= 0 ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>{fmtMoney(hiltonMargen)}</span>}
                    </div>
                    <p className="text-xs text-purple-600">Cortes premium enfriados. Tipificación EUROP. Mín 221 kg res. Habilitación SENASA exportación.</p>
                    <EditField label="Cabezas Hilton" value={terminacionDatos.novillosHilton??0} onChange={v=>setTermActiva(p=>({...p,novillosHilton:Math.max(0,v)}))} step={1} hint="Novillos en terminación a pasto para Cuota Hilton" />
                    {(terminacionDatos.novillosHilton??0) > 0 && (<>
                      <div className="grid grid-cols-2 gap-3">
                        <EditField label="Peso entrada (kg)" value={terminacionDatos.hiltonPesoEntrada??380} onChange={v=>setTermActiva(p=>({...p,hiltonPesoEntrada:v}))} step={5} suffix="kg" />
                        <EditField label="Días terminación" value={terminacionDatos.hiltonDias??120} onChange={v=>setTermActiva(p=>({...p,hiltonDias:v}))} step={10} suffix="d" hint="Mín 90-120 días" />
                        <EditField label="GDP a pasto (kg/día)" value={terminacionDatos.hiltonGdp??0.7} onChange={v=>setTermActiva(p=>({...p,hiltonGdp:v}))} step={0.05} suffix="kg/d" />
                        <EditField label="Rendimiento res (%)" value={terminacionDatos.hiltonRendRes??60} onChange={v=>setTermActiva(p=>({...p,hiltonRendRes:v}))} step={1} suffix="%" hint="58-62% típico" />
                        <EditField label="Precio USD/ton res" value={terminacionDatos.hiltonPrecioUSDton??8000} onChange={v=>setTermActiva(p=>({...p,hiltonPrecioUSDton:v}))} step={100} prefix="U$S" suffix="/ton" hint="Con hueso. Negociado con frigorífico." />
                        <EditField label="Costo pasto/mes/cab" value={terminacionDatos.hiltonCostoPasto??0} onChange={v=>setTermActiva(p=>({...p,hiltonCostoPasto:v}))} step={1000} prefix="$" hint="0 si es campo propio" />
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-center bg-white rounded-xl p-3">
                        <div><p className="text-xs text-purple-500">Peso final</p><p className="font-black text-purple-800">{Math.round(hiltonPesoFinal)} kg</p></div>
                        <div><p className="text-xs text-purple-500">Kg res/cab</p><p className="font-black text-purple-800">{Math.round(hiltonKgRes)} kg</p></div>
                        <div><p className="text-xs text-purple-500">Ingreso neto (s/ret)</p><p className="font-black text-emerald-700">{fmtMoney(hiltonIngresoPesos)}</p></div>
                        <div><p className="text-xs text-purple-500">USD/cab</p><p className="font-black text-blue-700">U$S {Math.round(hiltonIngresoUSD / Math.max(1,cabHilton)).toLocaleString("es-AR")}</p></div>
                        <div><p className="text-xs text-purple-500">USD total</p><p className="font-black text-blue-800">U$S {Math.round(hiltonIngresoUSD).toLocaleString("es-AR")}</p></div>
                        <div><p className="text-xs text-purple-500">Margen</p><p className={`font-black ${hiltonMargen >= 0 ? "text-emerald-700" : "text-red-600"}`}>{fmtMoney(hiltonMargen)}</p></div>
                      </div>
                    </>)}
                  </div>

                  {/* UE 481 */}
                  <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-black uppercase tracking-widest text-indigo-700">🏭 Cuota 481 UE — feedlot certificado</p>
                      {cabUE481 > 0 && <span className={`text-xs font-black px-2 py-0.5 rounded-full ${ue481Margen >= 0 ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>{fmtMoney(ue481Margen)}</span>}
                    </div>
                    <p className="text-xs text-indigo-600">Feedlot certificado UE. Mín 100 días. Mín 320 kg al ingreso. Sin hormonas. Certificación específica.</p>
                    <EditField label="Cabezas UE 481" value={terminacionDatos.novillosUE481??0} onChange={v=>setTermActiva(p=>({...p,novillosUE481:Math.max(0,v)}))} step={1} hint="Novillos en feedlot certificado UE" />
                    {(terminacionDatos.novillosUE481??0) > 0 && (<>
                      <div className="grid grid-cols-2 gap-3">
                        <EditField label="Peso entrada (kg)" value={terminacionDatos.ue481PesoEntrada??340} onChange={v=>setTermActiva(p=>({...p,ue481PesoEntrada:v}))} step={5} suffix="kg" hint="Mín 320 kg" />
                        <EditField label="Días feedlot" value={terminacionDatos.ue481Dias??100} onChange={v=>setTermActiva(p=>({...p,ue481Dias:v}))} step={5} suffix="d" hint="Mín 100 días UE" />
                        <EditField label="GDP feedlot (kg/día)" value={terminacionDatos.ue481Gdp??1.1} onChange={v=>setTermActiva(p=>({...p,ue481Gdp:v}))} step={0.05} suffix="kg/d" />
                        <EditField label="Rendimiento res (%)" value={terminacionDatos.ue481RendRes??58} onChange={v=>setTermActiva(p=>({...p,ue481RendRes:v}))} step={1} suffix="%" />
                        <EditField label="Precio USD/ton res UE" value={terminacionDatos.ue481PrecioUSDton??7000} onChange={v=>setTermActiva(p=>({...p,ue481PrecioUSDton:v}))} step={100} prefix="U$S" suffix="/ton" />
                        <EditField label="Ración (kg MS/cab/día)" value={terminacionDatos.ue481RacionKgDia??8} onChange={v=>setTermActiva(p=>({...p,ue481RacionKgDia:v}))} step={0.5} suffix="kg/d" />
                        <EditField label="Precio ración ($/ton)" value={terminacionDatos.ue481PrecioRacionTon??80000} onChange={v=>setTermActiva(p=>({...p,ue481PrecioRacionTon:v}))} step={5000} prefix="$" suffix="/ton" />
                        <EditField label="Hotelería ($/cab/día)" value={terminacionDatos.ue481Hoteleria??0} onChange={v=>setTermActiva(p=>({...p,ue481Hoteleria:v}))} step={100} prefix="$" hint="0 si feedlot propio" />
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-center bg-white rounded-xl p-3">
                        <div><p className="text-xs text-indigo-500">Peso final</p><p className="font-black text-indigo-800">{Math.round(ue481PesoFinal)} kg</p></div>
                        <div><p className="text-xs text-indigo-500">Kg res/cab</p><p className="font-black text-indigo-800">{Math.round(ue481KgRes)} kg</p></div>
                        <div><p className="text-xs text-indigo-500">Ingreso neto (s/ret)</p><p className="font-black text-emerald-700">{fmtMoney(ue481IngresoPesos)}</p></div>
                        <div><p className="text-xs text-indigo-500">USD/cab</p><p className="font-black text-blue-700">U$S {Math.round(ue481IngresoUSD / Math.max(1,cabUE481)).toLocaleString("es-AR")}</p></div>
                        <div><p className="text-xs text-indigo-500">Costo ración total</p><p className="font-black text-red-600">{fmtMoney(ue481CostoRacion)}</p></div>
                        <div><p className="text-xs text-indigo-500">Margen</p><p className={`font-black ${ue481Margen >= 0 ? "text-emerald-700" : "text-red-600"}`}>{fmtMoney(ue481Margen)}</p></div>
                      </div>
                    </>)}
                  </div>
                </div>
              </div>
            </div>
          )}
  
          {/* ══════════════════════════════════════════════════════════════
              COSTOS ESTRUCTURA
          ══════════════════════════════════════════════════════════════ */}
          {/* ══ MOVIMIENTOS ══════════════════════════════════════════════ */}
          {seccion === "movimientos" && (
            <VistaMovimientos
              movimientos={movimientos}
              setMovimientos={setMovimientos}
              movimientosAnio={movimientosAnio}
              kgVendidosTotal={kgVendidosTotal}
              ingresoVentas={ingresoVentas}
              costoCompras={costoCompras}
              kgHaAct={kgHaAct}
              totalDestete={totalDestete}
              reciaDatos={reciaDatos}
              terminacionDatos={terminacionDatos}
              hectareas={hectareas}
              anoGanadero={anoGanadero}
              hoy={hoy}
              global={global}
              onToast={onToast}
            />
          )}

          {seccion === "rendimiento" && (
            <div className="space-y-5 sim-zoom-enter">
              <SaveUndoBar
                modificado={snapGlobal !== null}
                onGuardar={async () => { await guardarEstado(vacaStore.getState().__userEmail); setSnapGlobal(null); }}
                onDeshacer={deshacerGlobal}
              />

              {/* ── Margen bruto por actividad ──────────────────────────── */}
              <MargenActividad
                ingresoCria={ingresoCria} ingresoRecria={ingresoRecria} ingresoTerm={ingresoTerm}
                sanidadCria={sanidadCria} sanidadRec={sanidadRec} sanidadTerm={sanidadTerm}
                margenCria={margenBrutoCria} margenRec={margenBrutoRec} margenTerm={margenBrutoTerm}
                margenTotal={margenBrutoTotal}
                cabCria={cabCria} cabRec={cabRec} cabTerm={cabTerm}
                cabDestetados={cabDestetados} pesoDestete2={pesoDestete2} precioInvKg={precioInvKg}
                cabRecriaSale={cabRecriaSale} pesoRecria={pesoRecria} precioNovKg={precioNovKg}
                cabTermSale={cabTermSale} pesoTerm={pesoTerm}
                costoOportunidadAnual={costoOportunidadAnual}
                sanidadPorCabAnio={campoStore.sanidadPorCabAnio}
                totalCabAct={totalCabAct}
                terminacionDatos={terminacionDatos}
                costoReposicionTotal={costoReposicionTotal}
                costoReposicionExterna={costoReposicionExterna}
                costoReposicionPropia={costoReposicionPropia}
                cabCompradasRecria={cabCompradasRecria}
                pesoEntradaRecria={pesoEntradaRecria}
                precioCompraRecria={precioCompraRecria}
                cabPropiaRecria={cabPropiaRecria}
                ingresoPastaje={ingresoPastaje}
                kgPastaje={kgPastaje}
                cabPastaje={cabPastaje}
                margenExport={margenBrutoExport}
                ingresoExport={ingresoExport}
                costoExport={costoExport}
                hiltonMargen={hiltonMargen}
                hiltonIngresoPesos={hiltonIngresoPesos}
                hiltonCostoTotal={hiltonCostoTotal}
                hiltonIngresoUSD={hiltonIngresoUSD}
                cabHilton={cabHilton}
                ue481Margen={ue481Margen}
                ue481IngresoPesos={ue481IngresoPesos}
                ue481CostoTotal={ue481CostoTotal}
                ue481IngresoUSD={ue481IngresoUSD}
                cabUE481={cabUE481}
                dolarExp={dolarExp}
                // Cascada margen neto
                costoEstructuraAnual={costoEstructuraAnual}
                amortTotal={amortTotal}
                ebitda={ebitda}
                ebit={ebit}
                iibbEstimado={iibbEstimado}
                inmobiliario={inmobiliario}
                tasas={tasas}
                gananciasEstimado={gananciasEstimado}
                impuestosTotal={impuestosTotal}
                margenNeto={margenNeto}
                margenNetoReal={margenNetoReal}
                dolar={dolar}
                hectareas={hectareas}
                fmtMoney={fmtMoney}
              />

              {/* ── Panel Capital y Rotación ─────────────────────────────── */}
              {(() => {
                const tasaAlternativa = (global.tasaOportunidadUSD ?? 5) / 100;
                const fmt2 = (n) => Math.round(n).toLocaleString("es-AR");
                const pct = (n) => (n * 100).toFixed(1) + "%";

                // Capital inmovilizado por actividad
                const capitalCria = (criaDatos.vacas + (criaDatos.vaquillonas1??criaDatos.vaquillonas??0) + (criaDatos.vaquillonas2??0)) * (pVacaDescarte ?? 380) * precioNovKg;
                const diasCria = 365;
                const roiCria = capitalCria ? margenBrutoCria / capitalCria : 0;
                const roiAnualCria = roiCria; // ya es anual (ciclo 365 días)

                const pesoEntradaRec = reciaDatos.pesoEntradaRecria ?? 180;
                const diasRec = 270;
                const capitalRec = cabRec * pesoEntradaRec * precioInvKg;
                const roiAnualRec = capitalRec ? (margenBrutoRec / capitalRec) * (365 / diasRec) : 0;

                const pesoEntradaTerm = terminacionDatos.pesoPromedioKg ? terminacionDatos.pesoPromedioKg - (terminacionDatos.gdpNovilloFaena ?? 1.1) * (terminacionDatos.diasRestantes ?? 45) : 360;
                const diasTerm = terminacionDatos.diasRestantes ?? 45;
                const capitalTerm = cabTerm * pesoEntradaTerm * precioNovKg;
                const roiAnualTerm = capitalTerm ? (margenBrutoTerm / capitalTerm) * (365 / diasTerm) : 0;

                const capitalExport = (cabHilton + cabUE481) * 380 * precioNovKg;
                const diasExport = 110;
                const roiAnualExport = capitalExport ? (margenBrutoExport / capitalExport) * (365 / diasExport) : 0;

                const actividades = [
                  { label: "🐄 Cría",        capital: capitalCria,    dias: diasCria,    margen: margenBrutoCria,    roi: roiAnualCria,    color: "emerald", rotaciones: (365/diasCria).toFixed(1) },
                  { label: "🐂 Recría",      capital: capitalRec,     dias: diasRec,     margen: margenBrutoRec,     roi: roiAnualRec,     color: "blue",    rotaciones: (365/diasRec).toFixed(1) },
                  { label: "🥩 Terminación", capital: capitalTerm,    dias: diasTerm,    margen: margenBrutoTerm,    roi: roiAnualTerm,    color: "amber",   rotaciones: (365/diasTerm).toFixed(1) },
                  ...(cabHilton + cabUE481 ? [{ label: "🌎 Exportación", capital: capitalExport, dias: diasExport, margen: margenBrutoExport, roi: roiAnualExport, color: "purple", rotaciones: (365/diasExport).toFixed(1) }] : []),
                ].filter(a => a.capital > 0);

                const maxRoi = Math.max(...actividades.map(a => a.roi));

                const colorMap = {
                  emerald: { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-700", bar: "bg-emerald-400" },
                  blue:    { bg: "bg-blue-50",    border: "border-blue-200",    text: "text-blue-700",    bar: "bg-blue-400" },
                  amber:   { bg: "bg-amber-50",   border: "border-amber-200",   text: "text-amber-700",   bar: "bg-amber-400" },
                  purple:  { bg: "bg-purple-50",  border: "border-purple-200",  text: "text-purple-700",  bar: "bg-purple-400" },
                };

                return (
                  <div className="bg-white border-2 border-slate-200 rounded-3xl overflow-hidden shadow-lg">
                    <div className="h-1.5 bg-gradient-to-r from-violet-500 to-indigo-500" />
                    <div className="p-5 space-y-4">
                      <div>
                        <p className="text-xs font-black uppercase tracking-widest text-slate-600">💰 Capital inmovilizado y ROI por actividad</p>
                        <p className="text-xs text-slate-400 mt-0.5">¿En qué actividad rinde más cada peso invertido? Compara vs tasa alternativa {pct(tasaAlternativa)} USD/año</p>
                      </div>
                      <div className="space-y-3">
                        {actividades.map((act) => {
                          const c = colorMap[act.color] || colorMap.emerald;
                          const superaTasa = act.roi > tasaAlternativa;
                          const esBest = act.roi === maxRoi;
                          const barWidth = maxRoi ? Math.max(4, Math.round((act.roi / maxRoi) * 100)) : 4;
                          return (
                            <div key={act.label} className={"rounded-2xl border-2 p-4 " + c.bg + " " + c.border + (esBest ? " ring-2 ring-offset-1 ring-violet-400" : "")}>
                              <div className="flex items-start justify-between gap-2 mb-3">
                                <div>
                                  <div className="flex items-center gap-2">
                                    <span className={"text-sm font-black " + c.text}>{act.label}</span>
                                    {esBest && <span className="text-xs bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full font-black">⭐ Mejor ROI</span>}
                                  </div>
                                  <p className="text-xs text-slate-500 mt-0.5">{act.rotaciones}x/año · {act.dias} días por ciclo</p>
                                </div>
                                <div className="text-right shrink-0">
                                  <p className={"font-mono font-black text-xl " + (superaTasa ? "text-emerald-700" : "text-red-600")}>{pct(act.roi)}</p>
                                  <p className="text-xs text-slate-400">ROI anual</p>
                                </div>
                              </div>
                              <div className="w-full bg-slate-200 rounded-full h-2 mb-3">
                                <div className={"h-2 rounded-full transition-all " + c.bar} style={{ width: barWidth + "%" }} />
                              </div>
                              <div className="grid grid-cols-3 gap-2 text-center">
                                <div className="bg-white rounded-xl p-2">
                                  <p className="text-xs text-slate-400">Capital</p>
                                  <p className={"font-black text-sm " + c.text}>${fmt2(Math.round(act.capital / 1000000))}M</p>
                                </div>
                                <div className="bg-white rounded-xl p-2">
                                  <p className="text-xs text-slate-400">Margen bruto</p>
                                  <p className={"font-black text-sm " + (act.margen >= 0 ? "text-emerald-700" : "text-red-600")}>${fmt2(Math.round(act.margen / 1000000))}M</p>
                                </div>
                                <div className="bg-white rounded-xl p-2">
                                  <p className="text-xs text-slate-400">vs alternativa</p>
                                  <p className={"font-black text-sm " + (superaTasa ? "text-emerald-700" : "text-red-600")}>{superaTasa ? "+" : ""}{pct(act.roi - tasaAlternativa)}</p>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="bg-violet-50 border border-violet-200 rounded-2xl p-4 space-y-2">
                        <p className="text-xs font-black text-violet-700">📊 Velocidad de rotación del capital</p>
                        <p className="text-xs text-slate-600">La rotación mide cuántas veces por año el capital "da la vuelta". Feedlot rotates 3x/año vs Cría que rota 1x/año — aunque el margen absoluto del feedlot sea menor, el ROI anual puede ser mayor.</p>
                        <div className="grid grid-cols-2 gap-2 pt-1">
                          <div className="bg-white rounded-xl p-2 text-center">
                            <p className="text-xs text-slate-400">Capital total</p>
                            <p className="font-black text-slate-800">${fmt2(Math.round(actividades.reduce((s,a) => s + a.capital, 0) / 1000000))}M</p>
                          </div>
                          <div className="bg-white rounded-xl p-2 text-center">
                            <p className="text-xs text-slate-400">ROI ponderado</p>
                            <p className={"font-black " + (actividades.reduce((s,a) => s + a.margen, 0) / Math.max(1, actividades.reduce((s,a) => s + a.capital, 0)) > tasaAlternativa ? "text-emerald-700" : "text-red-600")}>
                              {pct(actividades.reduce((s,a) => s + a.margen, 0) / Math.max(1, actividades.reduce((s,a) => s + a.capital, 0)))}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-emerald-50 border-2 border-emerald-200 rounded-2xl p-3">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs font-black text-emerald-700 uppercase tracking-widest">🐄 Cría</p>
                    <button onClick={()=>{setSeccion("stock");setSubStock("cria");}}
                      className="text-xs text-emerald-600 border border-emerald-200 px-2 py-0.5 rounded-lg hover:bg-emerald-100">editar</button>
                  </div>
                  <p className="text-xs text-emerald-600">Parición: <b>{MESES_ES[paricionMes]} {paricionAnio}</b> · {meseDestete}m destete</p>
                  <p className="text-xs text-emerald-600">{totalDestete} terneros · mort. {criaDatos.pctMortandadCria??2}%</p>
                  <div className="mt-2 bg-emerald-100 rounded-xl px-3 py-1.5 flex items-center justify-between">
                    <span className="text-xs text-emerald-700 font-black">GDP ternero</span>
                    <span className="font-mono font-black text-emerald-800">{gdpTernero.toFixed(1)} kg/d</span>
                    <span className="text-xs text-emerald-600 font-semibold">{pesoDestete} kg</span>
                  </div>
                </div>
                <div className="bg-blue-50 border-2 border-blue-200 rounded-2xl p-3">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs font-black text-blue-700 uppercase tracking-widest">🐂 Recría</p>
                    <button onClick={()=>{setSeccion("stock");setSubStock("recria");}}
                      className="text-xs text-blue-600 border border-blue-200 px-2 py-0.5 rounded-lg hover:bg-blue-100">editar</button>
                  </div>
                  <p className="text-xs text-blue-600">Novillos: <b>{cabNovillosInv} cab</b> · Vaquillonas: <b>{cabVaquillonaDesc} cab</b></p>
                  <p className="text-xs text-blue-600">mort. {reciaDatos.pctMortandadRecria??2}%</p>
                  <div className="mt-2 bg-blue-100 rounded-xl px-3 py-1.5 flex items-center justify-between">
                    <span className="text-xs text-blue-700 font-black">GDP novillo</span>
                    <span className="font-mono font-black text-blue-800">{gdpNovilloInv.toFixed(1)} kg/d</span>
                    <span className="text-xs text-blue-600 font-semibold">{pesoNovilloInvAlCierre} kg</span>
                  </div>
                </div>
                <div className="bg-amber-50 border-2 border-amber-200 rounded-2xl p-3">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs font-black text-amber-700 uppercase tracking-widest">🏭 Feedlot</p>
                    <button onClick={()=>{setSeccion("stock");setSubStock("terminacion");}}
                      className="text-xs text-amber-600 border border-amber-200 px-2 py-0.5 rounded-lg hover:bg-amber-100">editar</button>
                  </div>
                  <p className="text-xs text-amber-600">Campo: <b>{terminacionDatos.novillosCampo}</b> · Feedlot: <b>{terminacionDatos.novillosFeedlot} cab</b></p>
                  <p className="text-xs text-amber-600">mort. {terminacionDatos.pctMortandadFeedlot??2}%</p>
                  <div className="mt-2 bg-amber-100 rounded-xl px-3 py-1.5 flex items-center justify-between">
                    <span className="text-xs text-amber-700 font-black">GDP feedlot</span>
                    <span className="font-mono font-black text-amber-800">{gdpNovilloFaena.toFixed(1)} kg/d</span>
                    <span className="text-xs text-amber-600 font-semibold">{pesoNovilloFaenaAlCierre} kg</span>
                  </div>
                </div>
              </div>
  
              {/* Hectáreas + GDP */}
              <div className="bg-white border-2 border-slate-100 rounded-3xl p-5 shadow-lg">
                <p className="text-xs font-black uppercase tracking-widest text-slate-500 mb-4">⚙️ Configuración rendimiento</p>
                <EditField label="Hectáreas del campo" value={hectareas} onChange={setHectareas} step={50} suffix=" ha" minVal={1} />
              </div>
  
              {/* ── KPIs ── */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label:"kg/ha año actual",  val:kgHaAct,               color:"text-emerald-700", bg:"bg-emerald-50 border-emerald-200", icon:"📦" },
                  { label:"kg/ha proyectado",  val:kgHaProx,              color:tendencia==="sube"?"text-blue-700":tendencia==="baja"?"text-red-600":"text-slate-600", bg:tendencia==="sube"?"bg-blue-50 border-blue-200":tendencia==="baja"?"bg-red-50 border-red-200":"bg-slate-50 border-slate-100", icon:tendencia==="sube"?"📈":tendencia==="baja"?"📉":"➡️" },
                  { label:"kg totales año",    val:fmt(kgTotalAct)+" kg", color:"text-slate-800",   bg:"bg-white border-slate-100", icon:"🥩" },
                  { label:"Hectáreas campo",   val:fmt(hectareas)+" ha",  color:"text-amber-700",   bg:"bg-amber-50 border-amber-200", icon:"🌾" },
                ].map((k,i)=>(
                  <div key={i} className={`kpi-pop border-2 ${k.bg} rounded-2xl p-4 space-y-1 card-hover`}>
                    <span className="text-base">{k.icon}</span>
                    <p className="text-xs font-bold uppercase tracking-wider text-slate-400">{k.label}</p>
                    <p className={`font-mono font-black text-2xl ${k.color}`}>{k.val}</p>
                  </div>
                ))}
              </div>

              {/* ── Rendimiento total campo (propio + pastaje) ── */}
              {(ingresoPastaje > 0 || kgPastajeProducidos > 0) && (() => {
                // Kg producidos por animales de pastaje = GDP real por categoría × días en campo
                // Vacas y toros: GDP ≈ 0 (mantienen peso, no producen kg netos)
                // Terneros/terneras: GDP ≈ 0.7 kg/día (crecimiento destete → recría)
                // Use kgPastajeProducidos calculated in MiCampo scope (from stored gdpEstimado per tropa)
                const kgHaPastajeReal = kgHaPastaje; // already computed above
                const kgHaTotal = kgHaAct + kgHaPastajeReal;

                // Detail by tropa
                const tropasPastaje = (campoPastaje?.tropas ?? []).filter(t => t.cat === "terneras" || t.cat === "terneros" || t.cat === "recria");
                const hoyNow = new Date();

                return (
                  <div className="bg-white border-2 border-teal-200 rounded-3xl overflow-hidden shadow-lg">
                    <div className="h-1.5 bg-gradient-to-r from-teal-400 to-emerald-500" />
                    <div className="p-5 space-y-4">
                      <p className="text-xs font-black uppercase tracking-widest text-teal-700">🌾 Rendimiento total del campo — propio + pastaje</p>
                      <div className="space-y-3">
                        {/* Hacienda propia */}
                        <div className="flex items-center justify-between py-2 border-b border-slate-100">
                          <div>
                            <p className="text-sm font-black text-slate-700">🐄 Hacienda propia</p>
                            <p className="text-xs text-slate-400">Terneros + novillos propios · {hectareas} ha</p>
                          </div>
                          <div className="text-right">
                            <p className="font-mono font-black text-xl text-emerald-700">{kgHaAct} kg/ha</p>
                            <p className="text-xs text-slate-400">indicador comparable</p>
                          </div>
                        </div>
                        {/* Pastaje — solo terneras y recría */}
                        {kgHaPastajeReal > 0 && (
                          <div className="py-2 border-b border-slate-100 space-y-2">
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="text-sm font-black text-slate-700">🤝 Pastaje (terneros y recría de terceros)</p>
                                <p className="text-xs text-slate-400">kg de carne producidos en tu campo por animales de terceros</p>
                              </div>
                              <div className="text-right">
                                <p className="font-mono font-black text-xl text-teal-700">+{kgHaPastajeReal} kg/ha</p>
                                <p className="text-xs text-slate-400">{Math.round(kgPastajeProducidos).toLocaleString("es-AR")} kg totales</p>
                              </div>
                            </div>
                            {/* Desglose por tropa */}
                            {tropasPastaje.map(t => {
                              const cab  = t.cabActual ?? t.cab ?? 0;
                              const gdp  = parseFloat(t.gdpEstimado ?? (t.cat === "terneras" || t.cat === "terneros" ? 0.6 : 0.5)) || 0;
                              const fi   = t.fechaIngreso ? new Date(t.fechaIngreso) : hoyNow;
                              const dias = Math.max(0, Math.round((hoyNow - fi) / 86400000));
                              const kg   = Math.round(cab * gdp * dias);
                              return (
                                <div key={t.id} className="flex items-center justify-between bg-teal-50 rounded-xl px-3 py-2 text-xs">
                                  <span className="text-slate-600 font-semibold">{t.origen}</span>
                                  <span className="text-teal-700 font-black">{cab} cab · {gdp} kg/d · {dias}d = {kg.toLocaleString("es-AR")} kg</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {/* Total */}
                        <div className="flex items-center justify-between pt-2">
                          <div>
                            <p className="text-sm font-black text-slate-800">Total campo</p>
                            <p className="text-xs text-slate-400">Producción propia + pastaje de terceros</p>
                          </div>
                          <p className="font-mono font-black text-3xl text-emerald-700">{kgHaTotal} kg/ha</p>
                        </div>
                      </div>
                      <div className="bg-teal-50 border border-teal-200 rounded-xl p-3 text-xs text-teal-700">
                        <p className="font-black mb-1">💡 ¿Por qué solo terneros y recría?</p>
                        <p>Las vacas mantienen su peso — no generan kg netos en tu campo. Los terneros y novillos en recría sí: tu pasto los hace crecer. Para editar el GDP de cada tropa, tocá el badge violeta en Pastaje → Tropas.</p>
                      </div>
                    </div>
                  </div>
                );
              })()}
  
              {/* ── Gráfico ── */}
              <div className="bg-white border-2 border-slate-100 rounded-3xl p-5 shadow-lg">
                <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                  <p className="text-xs font-black uppercase tracking-widest text-slate-600">📊 Evolución kg/ha</p>
                  <div className="flex gap-4 text-xs text-slate-400">
                    <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-emerald-500 inline-block"></span>Real</span>
                    <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-blue-400 opacity-75 inline-block"></span>Proyectado</span>
                  </div>
                </div>
                {(() => {
                  const data    = historialKgHa;
                  const maxVal  = Math.max(...data.map(d=>d.kgHa), 1);
                  const W=580; const H=200; const PL=44; const PT=16; const PB=36;
                  const cH=H-PT-PB; const slots=Math.max(data.length,1);
                  const sW=(W-PL)/slots; const bW=Math.min(52,sW-16);
                  const cx=i=>PL+sW*i+sW/2;
                  const cy=v=>PT+cH-Math.max(4,(v/maxVal)*cH);
                  return (
                    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{overflow:"visible"}}>
                      {[0,25,50,75,100].map(p=>{
                        const y=PT+cH-(p/100)*cH; const v=Math.round(maxVal*p/100);
                        return <g key={p}><line x1={PL} x2={W} y1={y} y2={y} stroke="#f1f5f9" strokeWidth="1"/><text x={PL-6} y={y+4} textAnchor="end" fontSize="9" fill="#94a3b8">{v}</text></g>;
                      })}
                      {data.map((d,i)=>(
                        <g key={i}>
                          <rect x={cx(i)-bW/2} y={cy(d.kgHa)} width={bW} height={Math.max(4,(d.kgHa/maxVal)*cH)} rx="5"
                            fill={d.tipo==="proyectado"?"#60a5fa":"#10b981"} opacity={d.tipo==="proyectado"?0.7:1}/>
                          <text x={cx(i)} y={cy(d.kgHa)-5} textAnchor="middle" fontSize="10" fontWeight="700" fill={d.tipo==="proyectado"?"#3b82f6":"#059669"}>{d.kgHa}</text>
                          <text x={cx(i)} y={H-6} textAnchor="middle" fontSize="9" fill="#64748b">{d.ano}</text>
                        </g>
                      ))}
                      {data.length>1&&<polyline points={data.map((d,i)=>`${cx(i)},${cy(d.kgHa)}`).join(" ")} fill="none" stroke="#f59e0b" strokeWidth="2" strokeDasharray="5,3"/>}
                      {data.map((d,i)=><circle key={i} cx={cx(i)} cy={cy(d.kgHa)} r="4" fill="#f59e0b" stroke="white" strokeWidth="1.5"/>)}
                    </svg>
                  );
                })()}
              </div>
  
              {/* ── Tabla resumen año actual ── */}
              <div className="bg-white border-2 border-slate-100 rounded-3xl overflow-hidden shadow-lg">
                <div className="h-1.5 bg-gradient-to-r from-emerald-400 to-teal-400"/>
                <div className="p-5 space-y-4">
                  <p className="text-xs font-black uppercase tracking-widest text-slate-600">Tabla — año actual</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                      <thead><tr className="border-b-2 border-slate-100">
                        {["Categoría","Cab","Peso venta","kg totales","kg/ha"].map(h=>(
                          <th key={h} className={`py-2 text-xs font-black uppercase tracking-wider text-slate-400 ${h==="Categoría"?"text-left pr-4":"text-right pr-2"}`}>{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {[
                          { cat:"Vacas descarte",     cab:cabVacasDescarte,  kg:kgVacasDescarte,  peso:pVacaDescarte,    color:"text-rose-700"   },
                          { cat:"Terneros invernada", cab:cabTernerosInv,    kg:kgTernerosInv,    peso:pTerneroInvernada,color:"text-sky-700"    },
                          { cat:"Novillos invernada", cab:cabNovillosInv,    kg:kgNovillosInv,    peso:pNovilloInvernada,color:"text-violet-700" },
                          { cat:"Novillos faena",     cab:cabNovillosFaena,  kg:kgNovillosFaena,  peso:pNovilloFaena,    color:"text-amber-700" },
                          { cat:"Vaquillonas desc.",  cab:cabVaquillonaDesc, kg:kgVaquillonaDesc, peso:pVaquillonaDesc,  color:"text-pink-700"  },
                        ].map((r,i)=>(
                          <tr key={i} className="border-b border-slate-50 hover:bg-slate-50">
                            <td className={`py-2.5 pr-4 font-semibold ${r.color}`}>{r.cat}</td>
                            <td className="text-right py-2.5 pr-2 font-mono font-bold text-slate-700">{fmt(r.cab)}</td>
                            <td className="text-right py-2.5 pr-2 font-mono text-slate-500">{fmt(r.peso)} kg</td>
                            <td className="text-right py-2.5 pr-2 font-mono font-bold text-slate-700">{fmt(r.kg)} kg</td>
                            <td className="text-right py-2.5 font-mono font-bold text-emerald-700">{hectareas>0?fmt(Math.round(r.kg/hectareas)):"-"}</td>
                          </tr>
                        ))}
                        <tr className="border-t-2 border-emerald-200 bg-emerald-50">
                          <td className="py-3 pr-4 font-black text-emerald-800">TOTAL AÑO ACTUAL</td>
                          <td className="text-right py-3 pr-2 font-black text-emerald-800 font-mono">{fmt(cabVacasDescarte+cabTernerosInv+cabNovillosInv+cabNovillosFaena+cabVaquillonaDesc)}</td>
                          <td className="text-right py-3 pr-2 text-slate-400">—</td>
                          <td className="text-right py-3 pr-2 font-black text-emerald-800 font-mono">{fmt(kgTotalAct)} kg</td>
                          <td className="text-right py-3 font-black text-emerald-800 font-mono text-lg">{kgHaAct}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
  
                  {/* Proyección */}
                  <div className="border-t-2 border-slate-100 pt-4">
                    <p className="text-xs font-black uppercase tracking-widest text-blue-700 mb-3">Proyección año siguiente</p>
                    <table className="w-full text-sm border-collapse">
                      <tbody>
                        {[
                          { cat:"Vacas descarte",    cab:vacasDescarteProx,  kg:kgVacasDescProx,    color:"text-rose-600"  },
                          { cat:"Terneros invernada",cab:ternerosInvProx,    kg:kgTernerosInvProx,  color:"text-sky-600"   },
                          { cat:"Novillos faena",    cab:novillosFaenaProx,  kg:kgNovillosFaenaProx,color:"text-amber-600" },
                          { cat:"Vaquillonas desc.", cab:vaquillonaDescProx, kg:kgVaqDescProx,      color:"text-pink-600"  },
                        ].map((r,i)=>(
                          <tr key={i} className="border-b border-slate-50 hover:bg-blue-50">
                            <td className={`py-2.5 pr-4 font-semibold ${r.color}`}>{r.cat}</td>
                            <td className="text-right py-2.5 pr-2 font-mono text-slate-600">{fmt(r.cab)} cab</td>
                            <td className="text-right py-2.5 pr-2 font-mono font-bold text-slate-700">{fmt(r.kg)} kg</td>
                            <td className={`text-right py-2.5 font-mono text-blue-700`}>{hectareas>0?fmt(Math.round(r.kg/hectareas)):"-"} kg/ha</td>
                          </tr>
                        ))}
                        <tr className="border-t-2 border-blue-200 bg-blue-50">
                          <td className="py-3 pr-4 font-black text-blue-800">TOTAL PROYECTADO</td>
                          <td className="text-right py-3 pr-2 font-black text-blue-800 font-mono">{fmt(vacasDescarteProx+ternerosInvProx+novillosFaenaProx+vaquillonaDescProx)} cab</td>
                          <td className="text-right py-3 pr-2 font-black text-blue-800 font-mono">{fmt(kgTotalProx)} kg</td>
                          <td className={`text-right py-3 font-black font-mono text-lg ${tendencia==="sube"?"text-blue-700":tendencia==="baja"?"text-red-600":"text-slate-600"}`}>
                            {kgHaProx} {tendencia==="sube"?"↑":tendencia==="baja"?"↓":"→"}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
  
                  {/* Alertas */}
                  {tendencia==="baja"&&<div className="flex items-start gap-2 bg-orange-50 border border-orange-200 rounded-2xl p-3"><span>📉</span><p className="text-xs text-orange-700 font-semibold">La proyección baja de {kgHaAct} a {kgHaProx} kg/ha. Considerá agregar más madres o comprar terneros.</p></div>}
                  {tendencia==="sube"&&<div className="flex items-start gap-2 bg-emerald-50 border border-emerald-200 rounded-2xl p-3"><span>📈</span><p className="text-xs text-emerald-700 font-semibold">Buen ritmo — la proyección mejora de {kgHaAct} a {kgHaProx} kg/ha.</p></div>}
  
                  {/* Tabla mensual acumulación */}
                  {/* ── Parición escalonada oct-dic ── */}
                  <div className="border-t-2 border-slate-100 pt-4 space-y-4">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <p className="text-xs font-black uppercase tracking-widest text-slate-600">🐄 Kg acumulados por lote de parición</p>
                      <div className="flex items-center gap-2 text-xs text-slate-400">
                        <span className="w-3 h-3 rounded-sm bg-sky-400 inline-block"></span>En gestación/cría
                        <span className="w-3 h-3 rounded-sm bg-emerald-400 inline-block ml-2"></span>Destete
                        <span className="w-3 h-3 rounded-sm bg-amber-400 inline-block ml-2"></span>Post-destete
                      </div>
                    </div>
  
                    {/* 3 lotes */}
                    {lotesPacion.map((lote, li) => (
                      <div key={li} className="bg-slate-50 border border-slate-200 rounded-2xl overflow-hidden">
                        <div className="flex items-center justify-between px-4 py-2.5 bg-white border-b border-slate-100">
                          <div className="flex items-center gap-2">
                            <span className={`w-2.5 h-2.5 rounded-full ${li===0?"bg-sky-500":li===1?"bg-indigo-500":"bg-violet-500"}`}></span>
                            <span className="text-xs font-black text-slate-700">
                              Lote {li+1} — {MESES_ES[lote.mes]} {lote.anio}
                            </span>
                            <span className="text-xs text-slate-400">({lote.cabLote} cab)</span>
                          </div>
                          <div className="flex items-center gap-3 text-xs">
                            <span className="text-slate-500">Al destete: <b className="text-emerald-700">{lote.kgAlDestete} kg/cab</b></span>
                            <span className="text-slate-500">Al cierre: <b className="text-blue-700">{lote.kgAlCierre} kg/cab</b></span>
                          </div>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs border-collapse">
                            <thead><tr className="border-b border-slate-200">
                              <th className="text-left py-1.5 px-3 font-black uppercase tracking-wider text-slate-400">Mes</th>
                              <th className="text-right py-1.5 px-2 font-black uppercase tracking-wider text-slate-400">Días</th>
                              <th className="text-right py-1.5 px-2 font-black uppercase tracking-wider text-sky-600">kg/cab</th>
                              <th className="text-right py-1.5 px-3 font-black uppercase tracking-wider text-emerald-600">kg lote</th>
                            </tr></thead>
                            <tbody>
                              {lote.acumMensual.map((r,i)=>(
                                <tr key={i} className={`border-b border-slate-100 ${r.esMesDestete?"bg-emerald-50 font-bold":"hover:bg-white"}`}>
                                  <td className={`py-1.5 px-3 font-semibold ${r.esMesDestete?"text-emerald-700":"text-slate-600"}`}>
                                    {r.mes} {r.esMesDestete?"← destete":""}
                                  </td>
                                  <td className="text-right py-1.5 px-2 font-mono text-slate-500">{r.diasAcum}d</td>
                                  <td className={`text-right py-1.5 px-2 font-mono font-bold ${r.esMesDestete?"text-emerald-700":"text-sky-700"}`}>{r.kgPorCab} kg</td>
                                  <td className={`text-right py-1.5 px-3 font-mono font-bold ${r.esMesDestete?"text-emerald-800":"text-slate-700"}`}>{fmt(r.kgTotales)} kg</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
  
                    {/* Resumen 3 lotes + botón pasar a recría */}
                    <div className="bg-emerald-50 border-2 border-emerald-200 rounded-2xl p-4 space-y-3">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                        <div><p className="text-xs text-emerald-600">Total terneros</p><p className="font-black text-emerald-900 text-xl">{ternNacidosVivos}</p></div>
                        <div><p className="text-xs text-emerald-600">Kg al destete</p><p className="font-black text-emerald-900 text-xl">{fmt(kgTernerosAlDestete)}</p></div>
                        <div><p className="text-xs text-blue-600">Kg al cierre</p><p className="font-black text-blue-800 text-xl">{fmt(kgTernerosAlCierre)}</p></div>
                        <div><p className="text-xs text-emerald-600">kg/ha terneros</p><p className="font-black text-emerald-900 text-xl">{hectareas>0?Math.round(kgTernerosAlCierre/hectareas):"-"}</p></div>
                      </div>
                      <button onClick={()=>{setSeccion("stock");setSubStock("cria");}}
                        className="w-full flex items-center justify-center gap-2 bg-slate-700 hover:bg-slate-800 text-white font-black text-sm px-5 py-3 rounded-2xl shadow-md transition-all active:scale-95">
                        → Ir a Cría para destetar
                      </button>
                    </div>
  
                    {/* Tabla comparativa kg/cab por mes */}
                    {tablaAcumulacion.length > 0 && (
                      <div>
                        <p className="text-xs font-black uppercase tracking-widest text-slate-500 mb-2">Comparativo por categoría — kg/cab/mes</p>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs border-collapse">
                            <thead><tr className="border-b border-slate-200">
                              <th className="text-left py-1.5 pr-3 font-black uppercase tracking-wider text-slate-400">Mes</th>
                              <th className="text-right py-1.5 pr-3 font-black uppercase tracking-wider text-sky-500">Ternero</th>
                              <th className="text-right py-1.5 pr-3 font-black uppercase tracking-wider text-violet-500">Nov. inv.</th>
                              <th className="text-right py-1.5 font-black uppercase tracking-wider text-amber-500">Nov. faena</th>
                            </tr></thead>
                            <tbody>
                              {tablaAcumulacion.map((r,i)=>(
                                <tr key={i} className={`border-b border-slate-50 ${r.esMesDestete?"bg-emerald-50":""}`}>
                                  <td className={`py-1.5 pr-3 font-semibold ${r.esMesDestete?"text-emerald-700":"text-slate-600"}`}>{r.mes}{r.esMesDestete?" ← destete":""}</td>
                                  <td className="text-right py-1.5 pr-3 font-mono font-bold text-sky-700">{r.kgTernero} kg</td>
                                  <td className="text-right py-1.5 pr-3 font-mono font-bold text-violet-700">{r.kgNovilloInv} kg</td>
                                  <td className="text-right py-1.5 font-mono font-bold text-amber-700">{r.kgNovFaena} kg</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
  

              {/* Flujo de caja mensual */}
              {(() => {
                const MESES_CORTO = ["Jul","Ago","Sep","Oct","Nov","Dic","Ene","Feb","Mar","Abr","May","Jun"];
                const mesDesteteFC = ((paricionMes + Math.round(criaDatos.mesesDestete ?? 6) - 7 + 12) % 12);
                const costoMes = totalCostosMes;
                const precioNovFC = global.precioNovilloInmag ?? 1800;
                const flujo = MESES_CORTO.map((mes, i) => {
                  let ingreso = 0;
                  if (i === mesDesteteFC) ingreso += Math.round(totalDestete ?? 0) * 165 * precioNovFC;
                  if (i === 7) ingreso += (reciaDatos.novillos ?? 0) * 320 * precioNovFC;
                  if (i === 10) ingreso += ((terminacionDatos.novillosCampo ?? 0) + (terminacionDatos.novillosFeedlot ?? 0)) * (terminacionDatos.pesoPromedioKg ?? 420) * precioNovFC;
                  if (i === 9) ingreso += Math.round((criaDatos.vacias ?? 0) * 0.65 * (criaDatos.pesoVacaDescarte ?? 380) * precioNovFC);
                  return { mes, ingreso, egreso: costoMes, saldo: ingreso - costoMes };
                });
                const maxVal = Math.max(...flujo.map(f => Math.max(f.ingreso, f.egreso)), 1);
                const saldoAcum = flujo.reduce((acc, f) => { acc.push({ ...f, acum: (acc.length > 0 ? acc[acc.length-1].acum : 0) + f.saldo }); return acc; }, []);
                const mesesNeg = flujo.filter(f => f.saldo < 0).length;
                const peorAcum = Math.min(...saldoAcum.map(f => f.acum));
                return (
                  <div className="bg-white border-2 border-sky-200 rounded-3xl overflow-hidden shadow-lg">
                    <div className="h-1.5 bg-gradient-to-r from-sky-400 to-blue-500" />
                    <div className="p-5 space-y-4">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-black uppercase tracking-widest text-sky-700">📅 Flujo de caja mensual</p>
                        <span className={`text-xs font-black px-2.5 py-1 rounded-full border ${mesesNeg > 0 ? "bg-red-50 border-red-200 text-red-700" : "bg-emerald-50 border-emerald-200 text-emerald-700"}`}>
                          {mesesNeg} mes{mesesNeg !== 1 ? "es" : ""} con saldo negativo
                        </span>
                      </div>
                      <div className="flex items-end gap-1" style={{height:"100px"}}>
                        {flujo.map((f, i) => {
                          const hIng = (f.ingreso / maxVal) * 100;
                          const hEgr = (f.egreso  / maxVal) * 100;
                          const pos  = f.saldo >= 0;
                          return (
                            <div key={i} className="flex-1 flex flex-col items-center gap-0.5 h-full justify-end relative group">
                              <div className="w-full flex flex-col justify-end" style={{height:"84px"}}>
                                {f.ingreso > 0 && <div className="w-full rounded-t-sm bg-emerald-400" style={{height: hIng+"%"}} />}
                                <div className="w-full rounded-t-sm bg-red-300" style={{height: hEgr+"%"}} />
                              </div>
                              <span className={`text-[8px] font-bold ${pos?"text-emerald-700":"text-red-600"}`}>{f.mes}</span>
                              <div className="absolute bottom-full mb-1 hidden group-hover:flex flex-col bg-slate-800 text-white text-xs rounded-lg p-2 whitespace-nowrap z-10 shadow-xl">
                                <p className="font-black">{f.mes}</p>
                                {f.ingreso > 0 && <p className="text-emerald-400">+{fmtMoney(f.ingreso)}</p>}
                                <p className="text-red-300">−{fmtMoney(f.egreso)}</p>
                                <p className={pos?"text-emerald-300":"text-red-400"}>Saldo: {fmtMoney(f.saldo)}</p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="flex gap-4 text-xs text-slate-500">
                        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-emerald-400 inline-block"/>Ingresos</span>
                        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-300 inline-block"/>Egresos fijos</span>
                      </div>
                      {mesesNeg > 0 && peorAcum < 0 && (
                        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
                          <p className="font-black mb-1">⚠ Pico de necesidad financiera: {fmtMoney(Math.abs(peorAcum))}</p>
                          <p>Los meses con déficit son: {flujo.filter(f=>f.saldo<0).map(f=>f.mes).join(", ")}. Planificá financiamiento o ventas anticipadas para cubrirlos.</p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Proyeccion de stock 3 anos */}
              {(() => {
                let vac = criaDatos.vacas||0, vaq = (criaDatos.vaquillonas1??criaDatos.vaquillonas??0);
                const proyeccion = [1,2,3].map(n => {
                  const madres = vac + vaq;
                  const preniadas = Math.round(madres * criaDatos.pctPreniez / 100);
                  const nacidos  = Math.round(preniadas * (1 - criaDatos.pctMortandadCria / 100));
                  const destete  = Math.round(nacidos * criaDatos.pctDestete / 100);
                  const machos   = Math.round(destete * criaDatos.pctMachos / 100);
                  const hembras  = destete - machos;
                  const repos    = Math.round(hembras * criaDatos.pctReposicion / 100);
                  const mortVac  = Math.round(vac * criaDatos.pctMortandadCria / 100);
                  const vacias   = Math.round(madres * (100 - criaDatos.pctPreniez) / 100);
                  const newVac   = Math.max(0, vac - vacias - mortVac + vaq);
                  const newVaq   = repos;
                  const evTot    = newVac*1.0 + newVaq*0.85 + criaDatos.toros*1.3 + destete*0.55 + machos*0.95;
                  const evHa     = hectareas > 0 ? Math.round(evTot/hectareas*100)/100 : 0;
                  const [a1,a2]  = anoGanadero.split("/").map(Number);
                  vac = newVac; vaq = newVaq;
                  return { n, ano: `${a1+n}/${a2+n}`, vacas: newVac, vaquillonas: newVaq, destete, machos, evHa };
                });
                const diff3 = proyeccion[2].vacas - criaDatos.vacas;
                return (
                  <div className="bg-white border-2 border-violet-200 rounded-3xl overflow-hidden shadow-lg">
                    <div className="h-1.5 bg-gradient-to-r from-violet-400 to-purple-500" />
                    <div className="p-5 space-y-4">
                      <p className="text-xs font-black uppercase tracking-widest text-violet-700">🔭 Proyección de stock — 3 años</p>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm border-collapse">
                          <thead>
                            <tr className="border-b-2 border-slate-100">
                              {["Año","Vacas","Vaquillonas","Terneros dest.","Novillos","EV/ha"].map(h => (
                                <th key={h} className={`py-2 text-xs font-black uppercase tracking-wider text-slate-400 ${h==="Año"?"text-left pr-3":"text-right pr-2"}`}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            <tr className="border-b border-slate-100 bg-slate-50">
                              <td className="py-2 pr-3 font-black text-slate-500 text-xs">{anoGanadero} <span className="text-slate-400 font-normal">actual</span></td>
                              <td className="text-right py-2 pr-2 font-mono font-bold text-slate-700">{criaDatos.vacas}</td>
                              <td className="text-right py-2 pr-2 font-mono text-slate-600">{criaDatos.vaquillonas1??criaDatos.vaquillonas??0}</td>
                              <td className="text-right py-2 pr-2 font-mono text-sky-700">{totalTernerosAlPie}</td>
                              <td className="text-right py-2 pr-2 font-mono text-violet-700">{reciaDatos.novillos}</td>
                              <td className="text-right py-2 font-mono font-bold text-emerald-700">{evPorHa.toFixed(2)}</td>
                            </tr>
                            {proyeccion.map((p, i) => {
                              const d = p.vacas - criaDatos.vacas;
                              return (
                                <tr key={i} className="border-b border-slate-50 hover:bg-slate-50">
                                  <td className="py-2 pr-3 font-semibold text-violet-700 text-xs">{p.ano}</td>
                                  <td className="text-right py-2 pr-2 font-mono font-bold text-slate-700">
                                    {p.vacas} <span className={`text-xs ${d>=0?"text-emerald-600":"text-red-500"}`}>{d>=0?"+":""}{d}</span>
                                  </td>
                                  <td className="text-right py-2 pr-2 font-mono text-slate-600">{p.vaquillonas}</td>
                                  <td className="text-right py-2 pr-2 font-mono text-sky-700">{p.destete}</td>
                                  <td className="text-right py-2 pr-2 font-mono text-violet-700">{p.machos}</td>
                                  <td className={`text-right py-2 font-mono font-bold ${p.evHa<0.7?"text-sky-600":p.evHa<1.1?"text-emerald-700":p.evHa<1.4?"text-amber-600":"text-red-600"}`}>{p.evHa}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      {diff3 < -criaDatos.vacas * 0.1 && (
                        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-800">
                          <p className="font-black">⚠ Rodeo en contracción</p>
                          <p>A 3 años el rodeo baja un {Math.round((1-proyeccion[2].vacas/criaDatos.vacas)*100)}%. Revisá % preñez ({criaDatos.pctPreniez}%) y reposición ({criaDatos.pctReposicion}%).</p>
                        </div>
                      )}
                      {diff3 > criaDatos.vacas * 0.1 && (
                        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
                          <p className="font-black">📈 Rodeo en expansión</p>
                          <p>A 3 años crece un {Math.round((proyeccion[2].vacas/criaDatos.vacas-1)*100)}%. Verificá que EV/ha={proyeccion[2].evHa} no supere la receptividad del campo.</p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* ── Punto de equilibrio por actividad ───────────────────── */}
              {(() => {
                const fmt2 = (n) => Math.round(n).toLocaleString("es-AR");
                const pctFmt = (n) => (n * 100).toFixed(1) + "%";
                const peqCria = cabDestetados ? Math.ceil(sanidadCria / (cabDestetados * pesoDestete2)) : 0;
                const peqCriaPct = precioInvKg ? peqCria / precioInvKg : 0;
                const peqRec = cabRecriaSale && pesoRecria ? Math.ceil((costoReposicionTotal + sanidadRec) / (cabRecriaSale * pesoRecria)) : 0;
                const peqRecPct = precioNovKg ? peqRec / precioNovKg : 0;
                const costoTermTotal = costoFeedlotAnual + sanidadTerm;
                const peqTerm = cabTermSale && pesoTerm ? Math.ceil(costoTermTotal / (cabTermSale * pesoTerm)) : 0;
                const peqTermPct = precioNovKg ? peqTerm / precioNovKg : 0;
                const hiltonCabKgRes = cabHilton * hiltonKgRes;
                const peqHiltonUSD = hiltonCabKgRes ? Math.ceil((hiltonCostoTotal / dolarExp / (hiltonCabKgRes / 1000)) / (1 - retencion)) : 0;
                const peqHiltonPct = terminacionDatos.hiltonPrecioUSDton ? peqHiltonUSD / terminacionDatos.hiltonPrecioUSDton : 0;
                const ue481CabKgRes = cabUE481 * ue481KgRes;
                const peqUE481USD = ue481CabKgRes ? Math.ceil((ue481CostoTotal / dolarExp / (ue481CabKgRes / 1000)) / (1 - retencion)) : 0;
                const peqUE481Pct = terminacionDatos.ue481PrecioUSDton ? peqUE481USD / terminacionDatos.ue481PrecioUSDton : 0;
                const colorMap = {
                  emerald: { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-700", ok: "bg-emerald-100" },
                  blue:    { bg: "bg-blue-50",    border: "border-blue-200",    text: "text-blue-700",    ok: "bg-blue-100"    },
                  amber:   { bg: "bg-amber-50",   border: "border-amber-200",   text: "text-amber-700",   ok: "bg-amber-100"   },
                  purple:  { bg: "bg-purple-50",  border: "border-purple-200",  text: "text-purple-700",  ok: "bg-purple-100"  },
                  indigo:  { bg: "bg-indigo-50",  border: "border-indigo-200",  text: "text-indigo-700",  ok: "bg-indigo-100"  },
                };
                const items = [
                  { label: "Cria",        emoji: "🐄", sub: "Precio min. ternero destete",  valor: "$" + fmt2(peqCria) + "/kg",        comp: "Actual: $" + fmt2(precioInvKg) + "/kg",  pct: peqCriaPct,   color: "emerald", activo: cabDestetados > 0 },
                  { label: "Recria",      emoji: "🐂", sub: "Precio min. novillo invernada", valor: "$" + fmt2(peqRec) + "/kg",         comp: "Actual: $" + fmt2(precioNovKg) + "/kg",  pct: peqRecPct,    color: "blue",    activo: cabRecriaSale > 0 },
                  { label: "Terminacion", emoji: "🥩", sub: "Precio min. novillo gordo",     valor: "$" + fmt2(peqTerm) + "/kg",        comp: "Actual: $" + fmt2(precioNovKg) + "/kg",  pct: peqTermPct,   color: "amber",   activo: cabTermSale > 0 },
                  ...(cabHilton ? [{ label: "Hilton",  emoji: "🌎", sub: "Precio min. USD/ton res", valor: "U$S " + fmt2(peqHiltonUSD) + "/ton", comp: "Actual: U$S " + fmt2(terminacionDatos.hiltonPrecioUSDton ?? 0) + "/ton", pct: peqHiltonPct, color: "purple", activo: true }] : []),
                  ...(cabUE481 ? [{ label: "UE 481", emoji: "🏭", sub: "Precio min. USD/ton res",   valor: "U$S " + fmt2(peqUE481USD) + "/ton",  comp: "Actual: U$S " + fmt2(terminacionDatos.ue481PrecioUSDton ?? 0) + "/ton",  pct: peqUE481Pct,  color: "indigo", activo: true }] : []),
                ].filter(i => i.activo);
                return (
                  <div className="bg-white border-2 border-slate-200 rounded-3xl overflow-hidden shadow-lg">
                    <div className="h-1.5 bg-gradient-to-r from-orange-400 to-red-500" />
                    <div className="p-5 space-y-4">
                      <p className="text-xs font-black uppercase tracking-widest text-slate-600">Punto de equilibrio por actividad</p>
                      <p className="text-xs text-slate-400">Precio minimo para que cada actividad cubra sus costos directos</p>
                      <div className="space-y-3">
                        {items.map((item) => {
                          const c = colorMap[item.color] || colorMap.emerald;
                          const ok = item.pct < 1;
                          return (
                            <div key={item.label} className={"rounded-2xl border-2 p-4 " + c.bg + " " + c.border}>
                              <div className="flex items-center justify-between gap-2 mb-2">
                                <div>
                                  <p className={"text-sm font-black " + c.text}>{item.emoji} {item.label}</p>
                                  <p className="text-xs text-slate-500">{item.sub}</p>
                                </div>
                                <div className="text-right">
                                  <p className="font-mono font-black text-slate-800">{item.valor}</p>
                                  <p className="text-xs text-slate-400">{item.comp}</p>
                                </div>
                              </div>
                              <div className={"rounded-xl px-3 py-2 " + (ok ? c.ok : "bg-red-100")}>
                                <span className={"text-xs font-black " + (ok ? c.text : "text-red-700")}>
                                  {ok ? "Precio actual cubre " + pctFmt(1 - item.pct) + " mas del minimo" : "Precio actual esta " + pctFmt(item.pct - 1) + " por debajo del minimo"}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* ── Sensibilidad exportacion ─────────────────────────────── */}
              {(cabHilton > 0 || cabUE481 > 0) && (() => {
                const fmtM = (n) => (n >= 0 ? "+" : "") + "$" + Math.round(n / 1000000) + "M";
                const varPrecios = [-0.20, -0.10, -0.05, 0, 0.05, 0.10, 0.20];
                const varDolar   = [-0.15, -0.10, 0, 0.10, 0.15];
                const precioBaseH = terminacionDatos.hiltonPrecioUSDton ?? 8000;
                const precioBaseU = terminacionDatos.ue481PrecioUSDton ?? 7000;
                function margenExp(pricePct, dolarPct) {
                  const dol = dolarExp * (1 + dolarPct);
                  const pH  = precioBaseH * (1 + pricePct);
                  const pU  = precioBaseU * (1 + pricePct);
                  const mH  = cabHilton * hiltonKgRes * (pH / 1000) * (1 - retencion) * dol - hiltonCostoTotal;
                  const mU  = cabUE481  * ue481KgRes  * (pU / 1000) * (1 - retencion) * dol - ue481CostoTotal;
                  return mH + mU;
                }
                const cellCls = (m) => m > 50000000 ? "bg-emerald-200 text-emerald-900 font-black" : m > 0 ? "bg-emerald-100 text-emerald-800" : m > -20000000 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800 font-black";
                return (
                  <div className="bg-white border-2 border-slate-200 rounded-3xl overflow-hidden shadow-lg">
                    <div className="h-1.5 bg-gradient-to-r from-purple-400 to-indigo-500" />
                    <div className="p-5 space-y-4">
                      <p className="text-xs font-black uppercase tracking-widest text-slate-600">Sensibilidad exportacion — precio USD vs tipo de cambio</p>
                      <p className="text-xs text-slate-400">Margen de exportacion. Verde = ganancia, Rojo = perdida</p>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr>
                              <th className="bg-slate-100 px-2 py-2 text-left text-slate-500 font-black">USD/ton \ Dolar</th>
                              {varDolar.map(d => (
                                <th key={d} className={"px-2 py-2 text-center font-black " + (d === 0 ? "bg-slate-300 text-slate-800" : "bg-slate-100 text-slate-500")}>
                                  {d === 0 ? "Base" : (d > 0 ? "+" : "") + (d * 100).toFixed(0) + "%"}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {varPrecios.map((p) => (
                              <tr key={p}>
                                <td className={"px-2 py-2 font-black text-center " + (p === 0 ? "bg-slate-300 text-slate-800" : "bg-slate-100 text-slate-500")}>
                                  {p === 0 ? "Base" : (p > 0 ? "+" : "") + (p * 100).toFixed(0) + "%"}
                                </td>
                                {varDolar.map(d => {
                                  const m = margenExp(p, d);
                                  return <td key={d} className={"px-2 py-1.5 text-center rounded " + cellCls(m)}>{fmtM(m)}</td>;
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* ── Indicadores financieros profesionales ────────────── */}
              {(() => {
                const fmt2 = (n) => Math.round(n).toLocaleString("es-AR");
                const pctFmt = (n, dec=1) => n !== null ? (n * 100).toFixed(dec) + "%" : "—";
                const fmtM = (n) => "$" + fmt2(Math.round(n / 1000000)) + "M";

                // ── Valor de activos operativos ────────────────────────────
                const valorRodeoOp = totalStockCampo * (precioNovKg ?? 1800) * (pVacaDescarte ?? 380);
                const valorMejoras   = (campoStore.amorMejoras ?? 0) * 20;  // vida útil 20 años
                const valorMaquinaria= (campoStore.amorMaquinaria ?? 0) * 10; // vida útil 10 años
                const valorHaciendaR = (campoStore.amorHaciendaReproductora ?? 0) * 5; // vida útil 5 años
                const activosTotales = valorRodeoOp + valorMejoras + valorMaquinaria + valorHaciendaR;

                // ── Indicadores ───────────────────────────────────────────
                const margenEBITDA  = ingresosTotales ? ebitda / ingresosTotales : null;
                const margenEBIT    = ingresosTotales ? ebit   / ingresosTotales : null;
                const margenNetoP   = ingresosTotales ? margenNeto / ingresosTotales : null;
                const roa           = activosTotales  ? ebit   / activosTotales  : null;
                const roe           = valorRodeoOp    ? margenNeto / valorRodeoOp : null;
                const rotActivos    = activosTotales  ? ingresosTotales / activosTotales : null;

                const tasaAlt = (global.tasaOportunidadUSD ?? 5) / 100;

                const rotActivosLabel = rotActivos ? (rotActivos.toFixed(2) + "x") : "—";
                const indicadores = [
                  {
                    grupo: "Rentabilidad",
                    items: [
                      { label: "EBITDA", valor: fmtM(ebitda), sub: "Resultado antes de amort. e impuestos", pct: margenEBITDA, pctLabel: "del ingreso total", ok: ebitda > 0 },
                      { label: "EBIT", valor: fmtM(ebit), sub: "Resultado operativo antes de impuestos", pct: margenEBIT, pctLabel: "del ingreso total", ok: ebit > 0 },
                      { label: "Margen neto", valor: fmtM(margenNeto), sub: "Resultado después de todos los impuestos", pct: margenNetoP, pctLabel: "del ingreso total", ok: margenNeto > 0 },
                    ]
                  },
                  {
                    grupo: "Retorno sobre activos",
                    items: [
                      { label: "ROA", valor: pctFmt(roa), sub: "EBIT / Activos operativos · Rodeo + Mejoras + Maquinaria", pct: roa, pctLabel: "retorno anual", ok: roa !== null && roa > tasaAlt, vsAlt: tasaAlt },
                      { label: "ROE", valor: pctFmt(roe), sub: "Margen neto / Capital en hacienda", pct: roe, pctLabel: "retorno sobre capital en hacienda", ok: roe !== null && roe > tasaAlt, vsAlt: tasaAlt },
                    ]
                  },
                  {
                    grupo: "Eficiencia",
                    items: [
                      { label: "Rotación de activos", valor: rotActivosLabel, sub: "Ingresos / Activos, cuántas veces los activos generan ingresos", pct: null, ok: rotActivos !== null && rotActivos > 0.3 },
                      { label: "Activos operativos", valor: fmtM(activosTotales), sub: "Rodeo " + fmtM(valorRodeoOp) + " · Mejoras " + fmtM(valorMejoras) + " · Maq. " + fmtM(valorMaquinaria), pct: null, ok: true },
                    ]
                  },
                ];

                return (
                  <div className="bg-white border-2 border-slate-200 rounded-3xl overflow-hidden shadow-lg">
                    <div className="h-1.5 bg-gradient-to-r from-slate-600 to-slate-800" />
                    <div className="p-5 space-y-5">
                      <div>
                        <p className="text-xs font-black uppercase tracking-widest text-slate-600">📈 Indicadores financieros profesionales</p>
                        <p className="text-xs text-slate-400 mt-0.5">Métricas estándar de análisis financiero aplicadas a la ganadería</p>
                      </div>

                      {indicadores.map((grupo) => (
                        <div key={grupo.grupo} className="space-y-2">
                          <p className="text-xs font-black uppercase tracking-widest text-slate-500 border-b border-slate-200 pb-1">{grupo.grupo}</p>
                          <div className="space-y-2">
                            {grupo.items.map((item) => (
                              <div key={item.label} className={"rounded-2xl px-4 py-3 flex items-start justify-between gap-3 " + (item.ok ? "bg-emerald-50 border border-emerald-200" : "bg-red-50 border border-red-200")}>
                                <div className="flex-1">
                                  <div className="flex items-center gap-2">
                                    <p className="text-sm font-black text-slate-800">{item.label}</p>
                                    {item.vsAlt !== undefined && (
                                      <span className={"text-xs px-2 py-0.5 rounded-full font-bold " + (item.ok ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700")}>
                                        {item.ok ? "Supera tasa alternativa" : "Bajo tasa alternativa"}
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs text-slate-500 mt-0.5">{item.sub}</p>
                                </div>
                                <div className="text-right shrink-0">
                                  <p className={"font-mono font-black text-lg " + (item.ok ? "text-emerald-700" : "text-red-600")}>{item.valor}</p>
                                  {item.pct !== null && item.pctLabel && (
                                    <p className="text-xs text-slate-400">{pctFmt(item.pct)} {item.pctLabel}</p>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}

                      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-xs text-slate-600 space-y-1">
                        <p className="font-black text-slate-700">Cómo leer estos indicadores:</p>
                        <p><b>EBITDA:</b> Margen operativo bruto sin efectos contables. Sirve para comparar entre campos.</p>
                        <p><b>ROA:</b> Cuánto genera cada peso invertido en activos. Compará contra la tasa alternativa ({pctFmt(tasaAlt)}).</p>
                        <p><b>ROE:</b> Cuánto rinde el capital en hacienda. Si está por debajo de la tasa alternativa, conviene vender hacienda y poner el dinero en otro lado.</p>
                        <p><b>Rotación de activos:</b> Cuántas veces los activos se convierten en ingresos. Un valor bajo indica capital subaprovechado.</p>
                        <p className="text-slate-400 italic">Nota: Los activos excluyen el valor de la tierra, que es capital no operativo.</p>
                      </div>
                    </div>
                  </div>
                );
              })()}


              {/* ── Asesor Ganadero IA ── */}
              <AsesorIA
                color="emerald"
                titulo="Análisis del rendimiento de tu campo"
                placeholder="Ej: ¿Qué actividad me conviene potenciar? ¿Qué riesgos ves en mi estructura?"
                contexto={[
                  `Campo: ${hectareas} ha | Stock: ${totalCabAct} cab | ${hectareas ? (totalCabAct/hectareas).toFixed(1) : 0} cab/ha`,
                  `Margen bruto total: $${Math.round(margenBrutoTotal).toLocaleString("es-AR")} (${Math.round(margenBrutoTotal/(dolar||1)).toLocaleString("es-AR")} USD)`,
                  `Margen/ha: $${hectareas ? Math.round(margenBrutoTotal/hectareas).toLocaleString("es-AR") : 0}`,
                  `Cría: ${cabCria} cab | Margen: $${Math.round(margenBrutoCria).toLocaleString("es-AR")}`,
                  `Recría: ${cabRec} cab | Margen: $${Math.round(margenBrutoRec).toLocaleString("es-AR")}`,
                  `Terminación: ${cabTerm} cab | Margen: $${Math.round(margenBrutoTerm).toLocaleString("es-AR")}`,
                  `Rendimiento: ${kgHaAct} kg/ha | Precio novillo: $${precioNovKg.toLocaleString("es-AR")}/kg`,
                  `Costo estructura: $${Math.round(costoEstructuraAnual).toLocaleString("es-AR")}/año`,
                ].join("\n")}
              />

            </div>
          )}
  
          {seccion === "costos" && (
            <div className="space-y-5 sim-zoom-enter">
              <SaveUndoBar
                modificado={snapGastos !== null || snapCampo !== null}
                onGuardar={async () => { await guardarEstado(vacaStore.getState().__userEmail); setSnapGastos(null); setSnapCampo(null); }}
                onDeshacer={() => { deshacerGastos(); deshacerCampo(); }}
              />

              {/* Sanidad y nutrición */}
              <div className="bg-white border-2 border-rose-200 rounded-3xl overflow-hidden shadow-lg">
                <div className="h-1.5 bg-gradient-to-r from-rose-400 to-pink-400" />
                <div className="p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-black uppercase tracking-widest text-rose-700">💉 Sanidad y nutrición</p>
                    <div className="text-right">
                      <p className="text-xs text-slate-400">Total mes</p>
                      <p className="font-black text-rose-800 text-lg">{fmtMoney(sanidadMes)}</p>
                    </div>
                  </div>
                  <p className="text-xs text-slate-500">Vacunación (aftosa, brucelosis, IBR-DVB), desparasitación, minerales y sales por cabeza al año.</p>
                  <EditField label="Sanidad por cabeza al año" value={campoStore.sanidadPorCabAnio ?? 40000}
                    onChange={v => setCampoStore({ sanidadPorCabAnio: v })}
                    step={5000} prefix="$" hint={`${totalStockCampo} cab × $${(campoStore.sanidadPorCabAnio ?? 40000).toLocaleString("es-AR")} = ${fmtMoney(sanidadAnual)}/año`} />
                </div>
              </div>

              {/* Costo de oportunidad del capital */}
              <div className="bg-white border-2 border-indigo-200 rounded-3xl overflow-hidden shadow-lg">
                <div className="h-1.5 bg-gradient-to-r from-indigo-400 to-purple-400" />
                <div className="p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-black uppercase tracking-widest text-indigo-700">💰 Costo de oportunidad del capital</p>
                    <div className="text-right">
                      <p className="text-xs text-slate-400">Total mes</p>
                      <p className="font-black text-indigo-800 text-lg">{fmtMoney(costoOportunidadMes)}</p>
                    </div>
                  </div>
                  <p className="text-xs text-slate-500">El capital invertido en hacienda tiene un costo de oportunidad — qué dejarías de ganar si lo pusieras en una alternativa segura (LECAP, plazo fijo USD).</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <EditField label="Valor promedio por cabeza" value={global.valorCabPromedio ?? 1500000}
                      onChange={v => vacaStore.getState().setGlobal({ valorCabPromedio: v })}
                      step={100000} prefix="$" hint={`Valor rodeo: ${fmtMoney(valorRodeo)}`} />
                    <EditField label="Tasa anual USD (referencia)" value={global.tasaOportunidadUSD ?? 5}
                      onChange={v => vacaStore.getState().setGlobal({ tasaOportunidadUSD: v })}
                      step={0.5} suffix="%" hint={`${fmtMoney(costoOportunidadAnual)}/año perdidos vs alternativa`} />
                  </div>
                </div>
              </div>
              <div className="bg-white border-2 border-violet-200 rounded-3xl overflow-hidden shadow-lg">
                <div className="h-1.5 bg-gradient-to-r from-violet-400 to-purple-400" />
                <div className="p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-black uppercase tracking-widest text-violet-700">👷 Empleados</p>
                    <div className="text-right">
                      <p className="text-xs text-slate-400">Total mes</p>
                      <p className="font-black text-violet-800 text-lg">{fmtMoney(totalEmpleadosMes)}</p>
                      <p className="text-xs text-emerald-600">{usd(totalEmpleadosMes)}</p>
                    </div>
                  </div>
                  {empleados.map((emp, i) => (
                    <div key={i} className="section-violet rounded-2xl border-2 p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-black text-violet-800">{emp.rol}</p>
                        <div className="text-right">
                          <p className="text-xs text-slate-400">Costo total/mes</p>
                          <p className="font-mono font-black text-violet-700">{fmtMoney(costoMensualEmpleado(emp))}</p>
                          <p className="text-xs text-emerald-600">{usd(costoMensualEmpleado(emp))}</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <EditField label="Cantidad" value={emp.cantidad} onChange={setEmp(i,"cantidad")} minVal={1} />
                        <EditField label="Sueldo base / mes" value={emp.sueldo} onChange={setEmp(i,"sueldo")} step={50000} prefix="$" usdVal={usd(emp.sueldo)} />
                        <EditField label="Cargas sociales (%)" value={emp.cargasSociales} onChange={setEmp(i,"cargasSociales")} step={1} suffix="%" hint="30% a 65%" />
                        <EditField label="Premio / mes" value={emp.premio} onChange={setEmp(i,"premio")} step={50000} prefix="$" usdVal={usd(emp.premio)} />
                      </div>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={emp.aguinaldo} onChange={e=>setEmp(i,"aguinaldo")(e.target.checked)} />
                        <span className="text-xs text-slate-600 font-semibold">Incluir aguinaldo (SAC)</span>
                      </label>
                    </div>
                  ))}
                  <button onClick={() => setEmpleados(p => [...p, { rol:"Nuevo empleado", cantidad:1, sueldo:900000, aguinaldo:true, cargasSociales:45, premio:0 }])}
                    className="w-full py-2.5 rounded-xl border-2 border-dashed border-violet-300 text-violet-500 text-xs font-black uppercase tracking-widest hover:bg-violet-50 transition-colors">
                    + Agregar empleado
                  </button>
                </div>
              </div>
  
              {/* Maquinaria */}
              <div className="bg-white border-2 border-sky-200 rounded-3xl overflow-hidden shadow-lg">
                <div className="h-1.5 bg-gradient-to-r from-sky-400 to-cyan-400" />
                <div className="p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-black uppercase tracking-widest text-sky-700">🚜 Maquinaria</p>
                    <div className="text-right">
                      <p className="text-xs text-slate-400">Total mes</p>
                      <p className="font-black text-sky-800 text-lg">{fmtMoney(costoMaqMes)}</p>
                      <p className="text-xs text-emerald-600">{usd(costoMaqMes)}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <EditField label="Cantidad tractores" value={maquinaria.tractores} onChange={v=>setMaquinaria(p=>({...p,tractores:v}))} minVal={0} />
                    <EditField label="Mantenimiento / tractor / mes" value={maquinaria.mantenimientoMes} onChange={v=>setMaquinaria(p=>({...p,mantenimientoMes:v}))} step={10000} prefix="$" usdVal={usd(maquinaria.mantenimientoMes)} />
                  </div>
                </div>
              </div>
  
              {/* Rolados */}
              <div className="bg-white border-2 border-green-200 rounded-3xl overflow-hidden shadow-lg">
                <div className="h-1.5 bg-gradient-to-r from-green-400 to-emerald-400" />
                <div className="p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-black uppercase tracking-widest text-green-700">🌾 Rolados y pastura</p>
                    <div className="text-right">
                      <p className="text-xs text-slate-400">Costo anual</p>
                      <p className="font-black text-green-800 text-lg">{fmtMoney(costoRoladoAnual)}</p>
                      <p className="text-xs text-emerald-600">{usd(costoRoladoAnual)}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <EditField label="Hectáreas roladas" value={roladoState.hectareas} onChange={v=>setRolado(p=>({...p,hectareas:v}))} step={10} suffix=" ha" />
                    <EditField label="Litros gasoil / ha" value={roladoState.litrosGasoilHa} onChange={v=>setRolado(p=>({...p,litrosGasoilHa:v}))} step={5} suffix=" L/ha" hint="Entre 50 y 150 L/ha" />
                    <EditField label="Has. siembra / resiembra" value={roladoState.siembraHa} onChange={v=>setRolado(p=>({...p,siembraHa:v}))} step={10} suffix=" ha" />
                    <EditField label="Costo siembra / ha" value={roladoState.costoSiembraHa} onChange={v=>setRolado(p=>({...p,costoSiembraHa:v}))} step={1000} prefix="$" usdVal={usd(roladoState.costoSiembraHa)} />
                  </div>
                  <div className="bg-green-50 border border-green-200 rounded-xl p-3 grid grid-cols-3 gap-3 text-center">
                    <div><p className="text-xs text-green-600">Litros totales</p><p className="font-black text-green-900">{fmt(roladoState.hectareas*roladoState.litrosGasoilHa)} L</p></div>
                    <div><p className="text-xs text-green-600">Costo gasoil</p><p className="font-black text-green-900">{fmtMoney(costoGasoilRolado)}</p><p className="text-xs text-emerald-600">{usd(costoGasoilRolado)}</p></div>
                    <div><p className="text-xs text-green-600">Costo siembra</p><p className="font-black text-green-900">{fmtMoney(costoSiembra)}</p><p className="text-xs text-emerald-600">{usd(costoSiembra)}</p></div>
                  </div>
                </div>
              </div>
  
              {/* Viajes */}
              <div className="bg-white border-2 border-orange-200 rounded-3xl overflow-hidden shadow-lg">
                <div className="h-1.5 bg-gradient-to-r from-orange-400 to-red-400" />
                <div className="p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-black uppercase tracking-widest text-orange-700">🚗 Viajes al campo</p>
                    <div className="text-right">
                      <p className="text-xs text-slate-400">Total mes</p>
                      <p className="font-black text-orange-800 text-lg">{fmtMoney(costoViajesMes)}</p>
                      <p className="text-xs text-emerald-600">{usd(costoViajesMes)}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <EditField label="Viajes por mes" value={viajesState.viajesAlMes} onChange={v=>setViajes(p=>({...p,viajesAlMes:v}))} minVal={1} suffix=" v/mes" />
                    <EditField label="Km por viaje" value={viajesState.kmPorViaje} onChange={v=>setViajes(p=>({...p,kmPorViaje:v}))} step={10} suffix=" km" />
                    <EditField label="Consumo cada 100 km" value={viajesState.litrosCada100} onChange={v=>setViajes(p=>({...p,litrosCada100:v}))} step={1} suffix=" L" />
                  </div>
                  <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 grid grid-cols-3 gap-3 text-center">
                    <div><p className="text-xs text-orange-600">Km totales/mes</p><p className="font-black text-orange-900">{fmt(viajesState.viajesAlMes*viajesState.kmPorViaje)} km</p></div>
                    <div><p className="text-xs text-orange-600">Litros/mes</p><p className="font-black text-orange-900">{fmt(Math.round(litrosTotalesMes))} L</p></div>
                    <div><p className="text-xs text-orange-600">Costo gasoil/mes</p><p className="font-black text-orange-900">{fmtMoney(costoViajesMes)}</p><p className="text-xs text-emerald-600">{usd(costoViajesMes)}</p></div>
                  </div>
                </div>
              </div>
  
              {/* Resumen anual */}
              <div className="bg-white border-2 border-emerald-300 rounded-3xl p-5 shadow-xl section-lime">
                <p className="text-xs font-black uppercase tracking-widest text-emerald-700 mb-4">Resumen costos anuales</p>
                <div className="space-y-2 mb-4">
                  {[
                    ["👷 Empleados",           totalEmpleadosMes*12,        "violet"],
                    ["🚜 Maquinaria",           costoMaqMes*12,              "sky"],
                    ["🌾 Rolados/pastura",      costoRoladoAnual,            "green"],
                    ["🚗 Viajes",               costoViajesMes*12,           "orange"],
                    ["💉 Sanidad y nutrición",  sanidadAnual,                "rose"],
                  ].map(([l,v,c]) => (
                    <div key={l} className="flex items-center justify-between py-1.5 border-b border-slate-100">
                      <span className="text-sm text-slate-600">{l}</span>
                      <div className="text-right">
                        <span className="font-mono font-black text-slate-800">{fmtMoney(v)}</span>
                        <span className="text-xs text-emerald-600 ml-2">{usd(v)}</span>
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center justify-between py-1.5 border-b border-dashed border-indigo-200">
                    <span className="text-sm text-indigo-600">💰 Costo oportunidad capital</span>
                    <div className="text-right">
                      <span className="font-mono font-black text-indigo-700">{fmtMoney(costoOportunidadAnual)}</span>
                      <span className="text-xs text-indigo-400 ml-2 italic">no operativo</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between pt-2">
                  <span className="text-sm font-black text-emerald-800">Total operativo anual</span>
                  <div className="text-right">
                    <p className="font-black text-emerald-900 text-2xl">{fmtMoney(totalCostosMes * 12)}</p>
                    <p className="text-sm text-emerald-700 font-bold">{usd(totalCostosMes * 12)}</p>
                  </div>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-dashed border-indigo-200 mt-2">
                  <span className="text-sm font-black text-indigo-700">Total incl. oportunidad</span>
                  <div className="text-right">
                    <p className="font-black text-indigo-800 text-xl">{fmtMoney(totalCostosMes * 12 + costoOportunidadAnual)}</p>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div className="bg-white rounded-xl border border-emerald-200 p-3 text-center">
                    <p className="text-xs text-slate-400">Costo / cab / mes</p>
                    <p className="font-black text-slate-800 text-xl">${fmt(costoPorCabMes)}</p>
                    <p className="text-xs text-emerald-600">{usd(costoPorCabMes)}</p>
                  </div>
                  <div className="bg-white rounded-xl border border-emerald-200 p-3 text-center">
                    <p className="text-xs text-slate-400">Costo / cab / año</p>
                    <p className="font-black text-slate-800 text-xl">${fmt(costoPorCabMes*12)}</p>
                    <p className="text-xs text-emerald-600">{usd(costoPorCabMes*12)}</p>
                  </div>
                </div>
              </div>

              {/* Amortizaciones */}
              <div className="bg-white border-2 border-slate-200 rounded-3xl overflow-hidden shadow-lg">
                <div className="h-1.5 bg-gradient-to-r from-orange-400 to-amber-500" />
                <div className="p-5 space-y-4">
                  <p className="text-xs font-black uppercase tracking-widest text-orange-700">📉 Amortizaciones anuales</p>
                  <p className="text-xs text-slate-400">Pérdida de valor de activos. Bajan del margen bruto para llegar al EBIT.</p>
                  <EditField label="Mejoras (alambrados, aguadas, corrales)" value={campoStore.amorMejoras??0} onChange={v=>setCampoStore({amorMejoras:v})} step={50000} prefix="$" suffix="/año" hint="Vida útil 20 años → valor total ÷ 20" />
                  <EditField label="Hacienda reproductora (toros)" value={campoStore.amorHaciendaReproductora??0} onChange={v=>setCampoStore({amorHaciendaReproductora:v})} step={50000} prefix="$" suffix="/año" hint="Vida útil 5 años → (cab × precio) ÷ 5" />
                  <EditField label="Maquinaria e implementos" value={campoStore.amorMaquinaria??0} onChange={v=>setCampoStore({amorMaquinaria:v})} step={50000} prefix="$" suffix="/año" hint="Vida útil 10 años → valor total ÷ 10" />
                </div>
              </div>

              {/* Impuestos estimados */}
              <div className="bg-white border-2 border-slate-200 rounded-3xl overflow-hidden shadow-lg">
                <div className="h-1.5 bg-gradient-to-r from-red-400 to-rose-500" />
                <div className="p-5 space-y-4">
                  <p className="text-xs font-black uppercase tracking-widest text-red-700">🏛️ Impuestos estimados</p>
                  <p className="text-xs text-slate-400">Estimativos — consultar con tu contador.</p>
                  <EditField label="Ingresos Brutos (% sobre ventas)" value={campoStore.pctIIBB??3} onChange={v=>setCampoStore({pctIIBB:v})} step={0.5} suffix="%" hint="3-3.5% típico en Buenos Aires" />
                  <EditField label="Ganancias (% sobre utilidad neta)" value={campoStore.pctGanancias??35} onChange={v=>setCampoStore({pctGanancias:v})} step={5} suffix="%" hint="35% personas jurídicas / 15-35% físicas" />
                  <EditField label="Inmobiliario rural ($/año)" value={campoStore.inmobiliarioAnual??0} onChange={v=>setCampoStore({inmobiliarioAnual:v})} step={50000} prefix="$" suffix="/año" />
                  <EditField label="Tasas viales y sanitarias ($/año)" value={campoStore.tasasAnuales??0} onChange={v=>setCampoStore({tasasAnuales:v})} step={10000} prefix="$" suffix="/año" hint="SENASA, municipales, viales, etc." />
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3">⚠️ Los impuestos reales dependen de tu situación impositiva. Consultá con tu contador.</p>
                </div>
              </div>
            </div>
          )}
  
          {/* ══════════════════════════════════════════════════════════════
              COTIZACIONES
          ══════════════════════════════════════════════════════════════ */}
          {seccion === "config" && (
            <div className="sim-zoom-enter space-y-4">
              <SaveUndoBar
                modificado={snapGlobal !== null}
                onGuardar={async () => { await guardarEstado(vacaStore.getState().__userEmail); setSnapGlobal(null); }}
                onDeshacer={deshacerGlobal}
              />
              <div className="bg-white border-2 border-slate-200 rounded-3xl overflow-hidden shadow-lg max-w-lg">
                <div className="h-1.5 bg-gradient-to-r from-slate-400 to-slate-600" />
                <div className="p-5 space-y-5">
                  <p className="text-xs font-black uppercase tracking-widest text-slate-600">Variables de referencia global</p>
                  <EditField label="Precio novillo gordo ($/kg)" value={global.precioNovilloInmag ?? 1800}
                    onChange={v => { vacaStore.getState().setGlobal({ precioNovilloInmag: v }); }}
                    step={50} prefix="$" suffix="/kg"
                    hint="Usado en Recría, Terminación y proyecciones. Precio novillo pesado." />
                  <EditField label="Precio invernada / ternero ($/kg)" value={global.precioInvernada ?? 1600}
                    onChange={v => { vacaStore.getState().setGlobal({ precioInvernada: v }); }}
                    step={50} prefix="$" suffix="/kg"
                    hint="Usado en Cría (terneros al destete). Precio ternero destete / invernada liviana." />
                  <EditField label="Cotización del dólar ($/USD)" value={dolar} onChange={setDolar} step={10} prefix="$" hint="Dólar oficial — se usa para exportación de carne (liquidación al tipo de cambio oficial + 9% retenciones)" />
                  <EditField label="Precio del gasoil ($/L)" value={gasoil} onChange={setGasoil} step={10} prefix="$" usdVal={usd(gasoil)} hint="Se usa para calcular rolados y viajes" />
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2">
                    <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Ejemplo de conversiones</p>
                    <div className="flex justify-between text-sm"><span className="text-slate-500">$1.000.000</span><span className="font-bold text-emerald-700">{usd(1000000)}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-slate-500">$5.000.000</span><span className="font-bold text-emerald-700">{usd(5000000)}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-slate-500">$10.000.000</span><span className="font-bold text-emerald-700">{usd(10000000)}</span></div>
                  </div>
                </div>
              </div>
            </div>




          )}

          {seccion === "pastaje" && (
            <PastajeCampo
              pastaje={campoPastaje}
              setPastaje={setCampoPastaje}
              precioNovillo={precioNovilloGlobal}
              stockPropio={{ cria, recria, terminacion }}
              onToast={onToast || ((msg) => {})}
            />
          )}
        </div>
      </div>
    </div>
  </div>
  );
} // end MiCampo

function Dashboard({ userEmail, global, gastos, simulaciones, onNavigate, onLogout }) {
  const primerNombre = userEmail ? userEmail.split("@")[0] : null;
  const hora = new Date().getHours();
  const saludo = hora < 12 ? "Buenos días" : hora < 19 ? "Buenas tardes" : "Buenas noches";


  return (
    <div className="min-h-screen bg-white font-sans">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="px-6 pt-4 pb-6 md:px-12 md:pt-6 md:pb-8 max-w-6xl mx-auto">
        <div className="text-center mb-4 md:mb-6 dash-welcome">
          <div className="flex justify-center mb-3">
            <img
              src={`data:image/png;base64,${LOGO_B64}`}
              alt="SoyPekun"
              className="h-24 md:h-32 object-contain"
              style={{ maxWidth: "420px" }}
            />
          </div>
          {primerNombre && (
            <p className="text-slate-600 font-bold text-base md:text-lg mb-2">
              {saludo}, <span className="text-emerald-600 font-black">{primerNombre}</span> 👋
            </p>
          )}
          <p className="text-slate-400 font-bold uppercase text-xs tracking-[0.3em] mt-1">
            Gestión Ganadera Profesional
          </p>
          {simulaciones.length > 0 && (
            <span className="inline-block mt-4 text-xs font-bold bg-emerald-100 text-emerald-700 border border-emerald-200 px-4 py-1.5 rounded-full">
              {simulaciones.length} simulación{simulaciones.length !== 1 ? "es" : ""} guardada{simulaciones.length !== 1 ? "s" : ""}
            </span>
          )}
          {onLogout && (
            <div className="mt-3">
              <button onClick={onLogout} className="text-xs text-slate-400 hover:text-red-500 transition-colors font-semibold px-3 py-1 rounded-lg hover:bg-red-50">
                Cerrar sesión
              </button>
            </div>
          )}
        </div>

        {/* ── Subtitle ───────────────────────────────────────────────────── */}
        <p className="text-center text-slate-400 font-semibold text-xs mb-4 md:mb-5 uppercase tracking-widest">
          ¿A dónde querés ir hoy?
        </p>

        {/* ── 2 big cards ────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6 max-w-3xl mx-auto">

          {/* Mi Campo */}
          <div className="dash-card">
            <button onClick={() => onNavigate("campo")}
              className="card-campo rounded-[2rem] overflow-hidden hover:shadow-2xl hover:shadow-blue-900/50 hover:-translate-y-4 hover:scale-[1.02] transition-all duration-300 text-left group w-full relative">
              <div className="h-1.5 w-full card-strip-campo" />
              <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent pointer-events-none" />
              <div className="absolute top-0 right-0 w-40 h-40 rounded-full bg-white/5 -translate-y-16 translate-x-16 pointer-events-none" />
              <div className="relative p-6 md:p-8">
                <div className="bg-white/20 backdrop-blur-sm border border-white/30 group-hover:bg-white/30 w-14 h-14 rounded-xl flex items-center justify-center mb-4 transition-all duration-300 shadow-lg card-icon-float">
                  <MapIcon size={28} className="text-white" />
                </div>
                <h3 className="text-2xl font-black text-white mb-2 tracking-tight">Mi Campo</h3>
                <p className="text-blue-100 font-medium leading-relaxed text-sm mb-4">Stock de hacienda, costos de estructura y gestión de tu establecimiento.</p>
                <div className="flex flex-wrap gap-1.5 mb-5">
                  {["Stock hacienda", "Costos estructura", "Próximamente más"].map(s => (
                    <span key={s} className="text-xs font-bold text-blue-200 bg-white/10 border border-white/20 px-2.5 py-1 rounded-full">{s}</span>
                  ))}
                </div>
                <div className="bg-white/20 hover:bg-white/30 text-white border border-white/40 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all duration-200">
                  <span>Ir a Mi Campo</span>
                  <span className="transition-transform group-hover:translate-x-1">→</span>
                </div>
              </div>
            </button>
          </div>

          {/* Simulador */}
          <div className="dash-card">
            <button onClick={() => onNavigate("simulador-menu")}
              className="card-simulador rounded-[2rem] overflow-hidden hover:shadow-2xl hover:shadow-purple-900/50 hover:-translate-y-4 hover:scale-[1.02] transition-all duration-300 text-left group w-full relative">
              <div className="h-1.5 w-full card-strip-sim" />
              <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent pointer-events-none" />
              <div className="absolute top-0 right-0 w-40 h-40 rounded-full bg-white/5 -translate-y-16 translate-x-16 pointer-events-none" />
              <div className="relative p-6 md:p-8">
                <div className="bg-white/20 backdrop-blur-sm border border-white/30 group-hover:bg-white/30 w-14 h-14 rounded-xl flex items-center justify-center mb-4 transition-all duration-300 shadow-lg card-icon-bounce">
                  <BarChart2 size={28} className="text-white" />
                </div>
                <h3 className="text-2xl font-black text-white mb-2 tracking-tight">Simulador</h3>
                <p className="text-purple-100 font-medium leading-relaxed text-sm mb-4">Poder de Compra, Proyecto Vientres y Comparador de Invernada.</p>
                <div className="flex flex-wrap gap-1.5 mb-5">
                  {["Poder de Compra", "Proyecto Vientres", "Comp. Invernada"].map(s => (
                    <span key={s} className="text-xs font-bold text-purple-200 bg-white/10 border border-white/20 px-2.5 py-1 rounded-full">{s}</span>
                  ))}
                </div>
                <div className="bg-white/20 hover:bg-white/30 text-white border border-white/40 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all duration-200">
                  <span>Ir al Simulador</span>
                  <span className="transition-transform group-hover:translate-x-1">→</span>
                </div>
              </div>
            </button>
          </div>
        </div>

        {/* ── Parámetros globales ─────────────────────────────────────────── */}

        <p className="text-center text-slate-400 mt-5 text-xs font-medium">
          Los cálculos son estimativos · Consultá con tu asesor antes de invertir
        </p>
      </div>
    </div>
  );
}

// MAIN
// ═══════════════════════════════════════════════════════════════════════════
const TABS = [
  { id: "poder",     label: "Poder de Compra",  icon: "⇄",  sub: "Triangulación" },
  { id: "vientres",  label: "Proyecto Vientres", icon: "🐄", sub: "Cría & rentabilidad" },
  { id: "invernada", label: "Comparador",         icon: "⚖️", sub: "Invernada vs Feedlot" },
  { id: "chacra",    label: "Chacra Alimento",  icon: "🌽", sub: "Producir vs comprar" },
];

// ── Año ganadero helpers ─────────────────────────────────────────────────────
function getAnoGanaderoActual() {
  const hoy = new Date();
  const año = hoy.getMonth() >= 6 ? hoy.getFullYear() : hoy.getFullYear() - 1;
  return `${año}/${año+1}`;
}


// ═══════════════════════════════════════════════════════════════════════════
// COMPRA DE RECRÍA — Simulador de compra de terneros por lotes
// ═══════════════════════════════════════════════════════════════════════════
function CompraRecria({ onGuardar, onToast, onAgregarAlCampo }) {
  const global = useGlobal();
  const gastos = useGastos();
  const { useState, useCallback, useRef, useEffect } = React;
  const dolar = global?.dolar || 1420;
  const gasoil = global?.precioGasoilL || 1100;
  const inflacionBase = global?.inflacionMensual || 4;
  const [inflacionSim, setInflacionSim] = useState(null); // null = usa la global
  const inflacion = inflacionSim !== null ? inflacionSim : inflacionBase;

  const hoyStr = new Date().toISOString().slice(0, 10);
  const MESES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
  const fmt = n => n?.toLocaleString("es-AR") ?? "0";
  const fmtM = n => `$ ${Math.round(n).toLocaleString("es-AR")}`;
  const usd = n => `U$S ${Math.round(n / dolar).toLocaleString("es-AR")}`;

  // ── Estado de lotes ────────────────────────────────────────────────────────
  const nuevoLote = () => ({
    id: Date.now(),
    nombre: "Nuevo lote",
    categoria: "machos",           // machos | hembras
    cabezas: 50,
    pesoEntradaKg: 180,
    precioCompraKg: 2200,          // $/kg vivo
    mesesRecria: 10,
    gdp: 0.6,                      // kg/día
    fechaEntrada: hoyStr,
    // Costos
    fleteEntrada: 8000,            // $/cab
    comisionCompra: 3,             // %
    sanidad: 5000,                 // $/cab (único)
    suplementoMes: 3000,           // $/cab/mes
    pastajeMes: 0,                 // $/cab/mes (si es campo arrendado)
    fleteSalida: 8000,             // $/cab
    comisionVenta: 3,              // %
    // Venta
    modalidadVenta: "invernada",   // invernada | feedlot
    precioVentaKg: 2800,           // $/kg
    diasFeedlot: 60,
    gdpFeedlot: 1.1,
    costoFeedlotCab: 4500,         // $/cab/día
  });

  const [lotes, setLotes] = useState([{ ...nuevoLote(), nombre: "Lote 1", cabezas: 50, pesoEntradaKg: 185, precioCompraKg: 2200 }]);
  const [loteActivo, setLoteActivo] = useState(0);

  const setL = useCallback((idx, key) => val =>
    setLotes(prev => prev.map((l, i) => i === idx ? { ...l, [key]: val } : l)),
  []);

  // ── Cálculos por lote ──────────────────────────────────────────────────────
  const calcLote = (l, inf = inflacion) => {
    const pesoSalida    = Math.round(l.pesoEntradaKg + l.mesesRecria * 30 * l.gdp);
    const pesoVenta     = l.modalidadVenta === "feedlot"
      ? Math.round(pesoSalida + l.diasFeedlot * l.gdpFeedlot)
      : pesoSalida;
    const fechaSalida   = (() => {
      const d = new Date(l.fechaEntrada);
      d.setMonth(d.getMonth() + l.mesesRecria);
      return d;
    })();
    const fechaSalidaStr = `${MESES[fechaSalida.getMonth()]} ${fechaSalida.getFullYear()}`;
    const diasHasta30Jun = (() => {
      const hoy = new Date();
      const anio = hoy.getMonth() >= 6 ? hoy.getFullYear() + 1 : hoy.getFullYear();
      return Math.round((new Date(anio, 5, 30) - hoy) / 86400000);
    })();
    const pasaAnoSiguiente = l.mesesRecria * 30 > diasHasta30Jun;

    // Costos
    const costoCompra       = l.pesoEntradaKg * l.precioCompraKg * l.cabezas;
    const on = (key) => l[key + "On"] !== false; // default true unless explicitly false
    const costoFleteEntrada = on("fleteEntrada") ? l.fleteEntrada * l.cabezas : 0;
    const costoComisionC    = on("comisionCompra") ? costoCompra * l.comisionCompra / 100 : 0;
    const costoSanidad      = on("sanidad") ? l.sanidad * l.cabezas : 0;
    const costoSuplemento   = on("suplementoMes") ? l.suplementoMes * l.cabezas * l.mesesRecria : 0;
    const costoPastaje      = on("pastajeMes") ? l.pastajeMes * l.cabezas * l.mesesRecria : 0;
    const costoFeedlot      = l.modalidadVenta === "feedlot" ? l.costoFeedlotCab * l.cabezas * l.diasFeedlot : 0;

    const ingresoVenta      = pesoVenta * l.precioVentaKg * l.cabezas;
    const costoFleteSalida  = on("fleteSalida") ? l.fleteSalida * l.cabezas : 0;
    const costoComisionV    = on("comisionVenta") ? ingresoVenta * l.comisionVenta / 100 : 0;

    const costoTotal        = costoCompra + costoFleteEntrada + costoComisionC + costoSanidad
                            + costoSuplemento + costoPastaje + costoFeedlot + costoFleteSalida + costoComisionV;
    const margen            = ingresoVenta - costoTotal;

    // ── Inflación: precio mínimo para cubrirla ────────────────────────────────
    // Costo total sin comisión venta (eso depende del precio de venta)
    const costoSinComVenta  = costoTotal - costoComisionV;
    // Inflación acumulada sobre el costo de compra durante los meses de recría
    const inflAcum          = Math.pow(1 + inf / 100, l.mesesRecria) - 1;
    // Precio mínimo invernada: recuperar costo + inflación sobre la inversión
    // pesoSalida * pKg * cab * (1 - comVenta/100) = costoSinComVenta * (1 + inflAcum)
    const costoInflado      = costoSinComVenta * (1 + inflAcum);
    const precioMinInvernada = on("comisionVenta") && l.comisionVenta > 0
      ? Math.round(costoInflado / (pesoSalida * l.cabezas * (1 - l.comisionVenta / 100)))
      : Math.round(costoInflado / Math.max(1, pesoSalida * l.cabezas));
    // Precio mínimo gordo (feedlot): con más kg
    const diasFeedlotMin      = l.diasFeedlot ?? 60;
    const pesoGordo           = Math.round(pesoSalida + diasFeedlotMin * (l.gdpFeedlot ?? 1.1));
    const costoFeedlotMin     = l.costoFeedlotCab * l.cabezas * diasFeedlotMin;
    const costoTotalGordo   = costoInflado + costoFeedlotMin;
    const precioMinGordo    = on("comisionVenta") && l.comisionVenta > 0
      ? Math.round(costoTotalGordo / (pesoGordo * l.cabezas * (1 - l.comisionVenta / 100)))
      : Math.round(costoTotalGordo / Math.max(1, pesoGordo * l.cabezas));
    const inflAcumPct       = Math.round(inflAcum * 100 * 10) / 10;
    const margenPorCab      = l.cabezas > 0 ? Math.round(margen / l.cabezas) : 0;
    const roi               = costoCompra > 0 ? (margen / (costoTotal - costoComisionV - costoFleteSalida) * 100) : 0;

    // Punto de equilibrio: precio venta que hace margen=0
    // ingresoVenta - costoComisionV = costoTotal - costoComisionV - costoFleteSalida + costoFleteSalida
    // peqKg * pesoVenta * cabezas * (1 - comisionVenta/100) = costoTotal - ingresoVenta + costoCompra (sin comision venta)
    const costosSinVenta    = costoCompra + costoFleteEntrada + costoComisionC + costoSanidad + costoSuplemento + costoPastaje + costoFeedlot;
    const peqKg             = l.cabezas > 0 && pesoVenta > 0
      ? Math.round(costosSinVenta / (pesoVenta * l.cabezas * (1 - l.comisionVenta / 100)))
      : 0;

    const kgGanados         = pesoSalida - l.pesoEntradaKg;
    const eficienciaKg      = costosSinVenta > 0 ? Math.round(costosSinVenta / (kgGanados * l.cabezas)) : 0;

    return {
      pesoSalida, pesoVenta, fechaSalidaStr, pasaAnoSiguiente,
      costoCompra, costoFleteEntrada, costoComisionC, costoSanidad,
      costoSuplemento, costoPastaje, costoFeedlot, costoFleteSalida, costoComisionV,
      costoTotal, ingresoVenta, margen, margenPorCab, roi, peqKg, kgGanados, eficienciaKg,
      precioMinInvernada, precioMinGordo, inflAcumPct, pesoGordo,
    };
  };

  const lote   = lotes[loteActivo] || lotes[0];
  const calc   = calcLote(lote);

  // Totales de todos los lotes
  const totales = lotes.reduce((acc, l) => {
    const c = calcLote(l);
    return {
      cabezas:     acc.cabezas + l.cabezas,
      costoTotal:  acc.costoTotal + c.costoTotal,
      ingreso:     acc.ingreso + c.ingresoVenta,
      margen:      acc.margen + c.margen,
    };
  }, { cabezas: 0, costoTotal: 0, ingreso: 0, margen: 0 });

  // ── Mini EditField ─────────────────────────────────────────────────────────
  const EF = ({ label, value, onChange, step = 1, suffix = "", prefix = "", hint = "", minVal = 0, disabled = false }) => {
    const [editing, setEditing] = useState(false);
    const [raw, setRaw] = useState("");
    const decFn = useCallback(() => onChange(Math.max(minVal, Math.round((value - step) * 100) / 100)), [value, step, minVal, onChange]);
    const incFn = useCallback(() => onChange(Math.round((value + step) * 100) / 100), [value, step, onChange]);
    const decLP = useLongPress(decFn, 180);
    const incLP = useLongPress(incFn, 180);
    return (
      <div className={`space-y-1 ${disabled ? "opacity-40 pointer-events-none" : ""}`}>
        <span className="text-xs text-slate-500 font-semibold">{label}</span>
        <div className="flex items-center gap-1">
          <button {...decLP}
            className="w-8 h-8 rounded-lg bg-slate-800 text-white font-black text-sm flex items-center justify-center active:scale-95 touch-manipulation select-none">−</button>
          <div className="flex-1 relative">
            {prefix && !editing && <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 pointer-events-none">{prefix}</span>}
            <input
              type={editing ? "number" : "text"}
              inputMode="numeric"
              value={editing ? raw : (prefix ? value.toLocaleString("es-AR") : value.toLocaleString("es-AR") + (suffix ? "" : ""))}
              readOnly={!editing}
              onFocus={e => { setEditing(true); setRaw(String(value)); setTimeout(() => e.target.select(), 0); }}
              onChange={e => setRaw(e.target.value)}
              onBlur={() => {
                setEditing(false);
                const n = parseFloat(raw.replace(",", "."));
                if (!isNaN(n)) onChange(Math.max(minVal, Math.round(n * 100) / 100));
                setRaw("");
              }}
              onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
              className="w-full bg-slate-50 border-2 border-slate-200 rounded-xl py-1.5 text-center font-mono font-black text-sm text-slate-800 focus:outline-none focus:border-blue-400 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none cursor-text"
            />
            {suffix && !editing && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 pointer-events-none">{suffix}</span>}
          </div>
          <button {...incLP}
            className="w-8 h-8 rounded-lg bg-slate-800 text-white font-black text-sm flex items-center justify-center active:scale-95 touch-manipulation select-none">+</button>
        </div>
        {hint && <p className="text-xs text-slate-400 italic">{hint}</p>}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs font-black uppercase tracking-widest text-blue-600">🐂 Compra de Recría</p>
          <p className="text-sm text-slate-400 mt-0.5">Simulá terneros por lote — costos, GDP y rentabilidad</p>
        </div>
        <button onClick={() => { const l = { ...nuevoLote(), nombre: `Lote ${lotes.length + 1}` }; setLotes(p => [...p, l]); setLoteActivo(lotes.length); }}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-black text-xs px-4 py-2.5 rounded-xl transition-all active:scale-95">
          + Agregar lote
        </button>
      </div>

      {/* Tabs de lotes */}
      <div className="flex gap-2 flex-wrap">
        {lotes.map((l, i) => {
          const c = calcLote(l);
          return (
            <button key={l.id} onClick={() => setLoteActivo(i)}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-black transition-all ${loteActivo === i ? "bg-slate-800 text-white shadow-md" : "bg-white border-2 border-slate-200 text-slate-500 hover:border-slate-400"}`}>
              <span>{l.categoria === "machos" ? "♂" : "♀"}</span>
              <span>{l.nombre}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${c.margen >= 0 ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-600"}`}>
                {c.margen >= 0 ? "+" : ""}{Math.round(c.margen / 1000000 * 10) / 10}M
              </span>
              {lotes.length > 1 && (
                <span onClick={e => { e.stopPropagation(); setLotes(p => p.filter((_, j) => j !== i)); setLoteActivo(Math.max(0, i - 1)); }}
                  className="ml-1 text-slate-300 hover:text-red-400 transition-colors">✕</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Lote activo */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* ── Col izquierda: parámetros ── */}
        <div className="space-y-4">

          {/* Datos del lote */}
          <div className="bg-white border-2 border-blue-100 rounded-3xl p-5 space-y-4">
            <div className="flex items-center gap-3">
              <input value={lote.nombre}
                onChange={e => setL(loteActivo, "nombre")(e.target.value)}
                className="font-black text-slate-800 text-base bg-transparent border-b-2 border-dashed border-slate-200 focus:outline-none focus:border-blue-400 flex-1"/>
              <div className="flex gap-1">
                {[["machos","♂ Machos","blue"],["hembras","♀ Hembras","rose"]].map(([v,lb,c]) => (
                  <button key={v} onClick={() => setL(loteActivo, "categoria")(v)}
                    className={`text-xs px-3 py-1.5 rounded-xl font-black transition-all ${lote.categoria === v ? `bg-${c}-600 text-white` : "bg-slate-100 text-slate-500"}`}>
                    {lb}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <EF label="Cabezas" value={lote.cabezas} onChange={setL(loteActivo,"cabezas")} step={1} minVal={1}/>
              <EF label="Peso entrada" value={lote.pesoEntradaKg} onChange={setL(loteActivo,"pesoEntradaKg")} step={5} suffix=" kg"/>
              <EF label="Precio compra" value={lote.precioCompraKg} onChange={setL(loteActivo,"precioCompraKg")} step={50} prefix="$" suffix="/kg"/>


              <div className="space-y-1">
                <span className="text-xs text-slate-500 font-semibold">Fecha de entrada</span>
                <input type="date" value={lote.fechaEntrada}
                  onChange={e => setL(loteActivo,"fechaEntrada")(e.target.value)}
                  className="w-full bg-slate-50 border-2 border-slate-200 rounded-xl px-3 py-2 text-sm font-bold text-slate-800 focus:outline-none focus:border-blue-400"/>
              </div>
              <EF label="Meses de recría" value={lote.mesesRecria} onChange={setL(loteActivo,"mesesRecria")} step={1} suffix=" m" minVal={1}
                hint={`Sale: ${calc.fechaSalidaStr}`}/>
            </div>


          </div>

          {/* Costos con on/off */}
          <div className="bg-white border-2 border-slate-100 rounded-3xl p-5 space-y-4">
            <p className="text-xs font-black uppercase tracking-widest text-slate-500">💰 Gastos comerciales</p>
            <div className="space-y-3">
              {[
                { key:"fleteEntrada",  label:"Flete entrada",    suffix:"$/cab",   step:500,  isOn: lote.fleteEntradaOn  ?? true  },
                { key:"comisionCompra",label:"Comisión compra",  suffix:"%",       step:0.5,  isOn: lote.comisionCompraOn ?? true  },
                { key:"sanidad",       label:"Sanidad / vacunas",suffix:"$/cab",   step:500,  isOn: lote.sanidadOn       ?? true  },
                { key:"suplementoMes", label:"Suplemento/mes",   suffix:"$/cab/m", step:500,  isOn: lote.suplementoMesOn ?? false,
                  hint: lote.suplementoMesOn !== false ? `Total: ${fmtM(lote.suplementoMes * lote.mesesRecria * lote.cabezas)}` : "" },
                { key:"pastajeMes",    label:"Pastaje/mes",      suffix:"$/cab/m", step:500,  isOn: lote.pastajeMesOn    ?? false,
                  hint: "0 si es campo propio" },
                { key:"fleteSalida",   label:"Flete salida",     suffix:"$/cab",   step:500,  isOn: lote.fleteSalidaOn   ?? true  },
                { key:"comisionVenta", label:"Comisión venta",   suffix:"%",       step:0.5,  isOn: lote.comisionVentaOn ?? true  },
              ].map(({ key, label, suffix: sfx, step, isOn, hint }) => (
                <div key={key} className={`flex items-center gap-3 p-2.5 rounded-2xl transition-all ${isOn ? "bg-slate-50" : "bg-white"}`}>
                  {/* Toggle */}
                  <button onClick={() => setL(loteActivo, key + "On")(!isOn)}
                    className={`w-11 h-6 rounded-full transition-all shrink-0 relative ${isOn ? "bg-blue-500" : "bg-slate-200"}`}>
                    <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${isOn ? "left-5" : "left-0.5"}`}/>
                  </button>
                  {/* Field */}
                  <div className="flex-1">
                    <EF label={label} value={lote[key]} onChange={setL(loteActivo, key)}
                      step={step} suffix={` ${sfx}`} minVal={0} hint={hint || ""} disabled={!isOn}/>
                  </div>
                  {/* Monto activo */}
                  {isOn && (
                    <div className="text-right shrink-0 min-w-[72px]">
                      <p className="text-xs font-black text-blue-700">
                        {sfx === "%" 
                          ? fmtM(lote[key] / 100 * lote.precioCompraKg * lote.pesoEntradaKg * lote.cabezas)
                          : sfx === "$/cab/m"
                          ? fmtM(lote[key] * lote.cabezas * lote.mesesRecria)
                          : fmtM(lote[key] * lote.cabezas)}
                      </p>
                      <p className="text-xs text-slate-400">total</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>


        </div>

        {/* ── Col derecha: resultado ── */}
        <div className="space-y-4">

          {/* Costo total */}
          <div className="bg-slate-800 rounded-3xl p-5 space-y-3">
            <p className="text-xs font-black uppercase tracking-widest text-white/70">Inversión total — {lote.nombre}</p>
            <div className="flex items-end justify-between">
              <div>
                <p className="text-4xl font-black text-white">{fmtM(calc.costoTotal)}</p>
                <p className="text-sm text-white/70 mt-0.5">{fmtM(Math.round(calc.costoTotal/lote.cabezas))}/cab</p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-black text-white">{usd(calc.costoTotal)}</p>
                <p className="text-xs text-white/70">en dólares</p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[
                ["Costo compra", fmtM(calc.costoCompra)],
                ["Costo kg ganado", `$${fmt(calc.eficienciaKg)}`],
                ["Sale estimado", calc.fechaSalidaStr],
              ].map(([l,v]) => (
                <div key={l} className="bg-white/10 rounded-xl p-2 text-center">
                  <p className="text-xs text-white/70">{l}</p>
                  <p className="font-black text-white text-sm">{v}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Panel inflación */}
          <div className="bg-orange-50 border-2 border-orange-200 rounded-3xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-black uppercase tracking-widest text-orange-700">📈 Inflación — precio mínimo de venta</p>
              <button onClick={() => setInflacionSim(inflacionSim !== null ? null : inflacionBase)}
                className="text-xs text-orange-600 border border-orange-300 px-2.5 py-1 rounded-xl hover:bg-orange-100 transition-all">
                {inflacionSim !== null ? "Usar global" : "Personalizar"}
              </button>
            </div>

            {/* Slider inflación */}
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <button onClick={() => setInflacionSim(Math.max(0, Math.round((inflacion - 0.5) * 10) / 10))}
                  className="w-7 h-7 rounded-lg bg-orange-600 text-white font-black text-xs flex items-center justify-center active:scale-95">−</button>
                <input type="range" min="0" max="15" step="0.5" value={inflacion}
                  onChange={e => setInflacionSim(parseFloat(e.target.value))}
                  className="flex-1 accent-orange-500"/>
                <button onClick={() => setInflacionSim(Math.min(15, Math.round((inflacion + 0.5) * 10) / 10))}
                  className="w-7 h-7 rounded-lg bg-orange-600 text-white font-black text-xs flex items-center justify-center active:scale-95">+</button>
                <span className="font-mono font-black text-orange-800 text-lg w-16 text-right">{inflacion}%/m</span>
              </div>
              <div className="flex justify-between text-xs text-orange-600">
                <span>Entrada: <b>{new Date(lote.fechaEntrada).toLocaleDateString("es-AR", {month:"short", year:"numeric"})}</b></span>
                <span>Salida: <b>{calc.fechaSalidaStr}</b></span>
                <span>Acumulada: <b>{calc.inflAcumPct}%</b></span>
              </div>
            </div>

            {/* Precios mínimos */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white border-2 border-orange-200 rounded-2xl p-3 text-center">
                <p className="text-xs font-black text-orange-600 uppercase tracking-widest mb-1">🌿 Invernada</p>
                <p className="text-xs text-slate-400">{calc.pesoSalida} kg/cab</p>
                <p className="text-2xl font-black text-orange-800">${fmt(calc.precioMinInvernada)}</p>
                <p className="text-xs text-orange-600 font-semibold">/kg vivo</p>
                <p className="text-xs text-slate-400 mt-1">{fmtM(calc.precioMinInvernada * calc.pesoSalida * lote.cabezas)} total</p>
              </div>
              <div className="bg-white border-2 border-amber-200 rounded-2xl p-3 text-center">
                <p className="text-xs font-black text-amber-600 uppercase tracking-widest mb-1">🏭 Gordo (~{lote.diasFeedlot ?? 60}d)</p>
                <p className="text-xs text-slate-400">{calc.pesoGordo} kg/cab est.</p>
                <p className="text-2xl font-black text-amber-800">${fmt(calc.precioMinGordo)}</p>
                <p className="text-xs text-amber-600 font-semibold">/kg vivo</p>
                <p className="text-xs text-slate-400 mt-1">{fmtM(calc.precioMinGordo * calc.pesoGordo * lote.cabezas)} total</p>
              </div>
            </div>

            <p className="text-xs text-orange-500 italic text-center">
              Precios para recuperar la inversión total ajustada por inflación {inflacion}%/mes
            </p>
          </div>

          {/* Desglose de costos */}
          <div className="bg-white border-2 border-slate-100 rounded-3xl p-5 space-y-3">
            <p className="text-xs font-black uppercase tracking-widest text-slate-500">Desglose</p>
            <table className="w-full text-xs">
              <tbody>
                {[
                  ["Compra terneros",  calc.costoCompra, "text-slate-700"],
                  ["Flete entrada",    calc.costoFleteEntrada, "text-slate-600"],
                  ["Comisión compra",  calc.costoComisionC, "text-slate-600"],
                  ["Sanidad",          calc.costoSanidad, "text-slate-600"],
                  ["Suplemento total", calc.costoSuplemento, "text-slate-600"],
                  lote.pastajeMes > 0 ? ["Pastaje total", calc.costoPastaje, "text-slate-600"] : null,
                  lote.modalidadVenta === "feedlot" ? ["Feedlot total", calc.costoFeedlot, "text-amber-600"] : null,
                  ["Flete salida",     calc.costoFleteSalida, "text-slate-600"],
                  ["Comisión venta",   calc.costoComisionV, "text-slate-600"],
                ].filter(Boolean).map(([l,v,c]) => (
                  <tr key={l} className="border-b border-slate-50">
                    <td className="py-1.5 text-slate-500">{l}</td>
                    <td className={`text-right py-1.5 font-mono font-bold ${c}`}>{fmtM(v)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-slate-200">
                  <td className="py-2 font-black text-slate-700">Costo total</td>
                  <td className="text-right py-2 font-mono font-black text-slate-800">{fmtM(calc.costoTotal)}</td>
                </tr>
                <tr className="border-t-2 border-slate-300 bg-slate-50">
                  <td className="py-2 font-black text-slate-800">COSTO TOTAL</td>
                  <td className="text-right py-2 font-mono font-black text-slate-800 text-lg">{fmtM(calc.costoTotal)}</td>
                </tr>
                <tr>
                  <td className="py-1.5 text-slate-400 text-xs">En dólares</td>
                  <td className="text-right py-1.5 font-mono text-slate-500">{usd(calc.costoTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Botón agregar al campo */}
          <button
            onClick={() => {
              if (lote.categoria === "machos") {
                onAgregarAlCampo({ categoria: "terneros-compra-machos", cantidad: lote.cabezas });
              } else {
                onAgregarAlCampo({ categoria: "terneros-compra-hembras", cantidad: lote.cabezas });
              }
              onToast && onToast(`✅ ${lote.cabezas} ${lote.nombre} agregados a Recría en Mi Campo`, "success");
            }}
            className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white font-black text-sm px-5 py-4 rounded-2xl shadow-md transition-all active:scale-95 group">
            <RefreshCw size={16} className="group-hover:rotate-180 transition-transform duration-500"/>
            Cargar {lote.cabezas} {lote.categoria === "machos" ? "♂" : "♀"} {lote.nombre} → Mi Campo (Recría)
          </button>

          {/* Resumen todos los lotes */}
          {lotes.length > 1 && (
            <div className="bg-slate-50 border-2 border-slate-200 rounded-3xl p-4 space-y-3">
              <p className="text-xs font-black uppercase tracking-widest text-slate-500">📋 Resumen todos los lotes</p>
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-200">
                  {["Lote","Cab","Inversión","USD"].map(h => (
                    <th key={h} className={`py-1.5 text-xs font-black text-slate-400 uppercase ${h==="Lote"?"text-left":"text-right"}`}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {lotes.map((l, i) => {
                    const c = calcLote(l);
                    return (
                      <tr key={l.id} className={`border-b border-slate-100 cursor-pointer hover:bg-white transition-colors ${i === loteActivo ? "bg-white font-bold" : ""}`}
                        onClick={() => setLoteActivo(i)}>
                        <td className="py-2 text-slate-700">{l.categoria==="machos"?"♂":"♀"} {l.nombre}</td>
                        <td className="text-right py-2 font-mono text-slate-600">{l.cabezas}</td>
                        <td className="text-right py-2 font-mono font-bold text-slate-700">{fmtM(c.costoTotal)}</td>
                        <td className="text-right py-2 font-mono text-slate-500">{usd(c.costoTotal)}</td>
                      </tr>
                    );
                  })}
                  <tr className="border-t-2 border-slate-300 bg-white">
                    <td className="py-2.5 font-black text-slate-800">TOTAL</td>
                    <td className="text-right py-2.5 font-mono font-black text-slate-800">{totales.cabezas}</td>
                    <td className="text-right py-2.5 font-mono font-black text-slate-800 text-lg">{fmtM(totales.costoTotal)}</td>
                    <td className="text-right py-2.5 font-mono font-black text-slate-500">{usd(totales.costoTotal)}</td>
                  </tr>
                </tbody>
              </table>

              {/* Botón cargar todos */}
              <button
                onClick={() => {
                  lotes.forEach(l => {
                    onAgregarAlCampo({ categoria: l.categoria === "machos" ? "terneros-compra-machos" : "terneros-compra-hembras", cantidad: l.cabezas });
                  });
                  onToast && onToast(`✅ ${totales.cabezas} terneros de ${lotes.length} lotes agregados a Recría`, "success");
                }}
                className="w-full bg-slate-800 hover:bg-slate-700 text-white font-black text-sm px-4 py-3 rounded-xl transition-all active:scale-95">
                Cargar todos los lotes → Mi Campo
              </button>
            </div>
          )}
        </div>

      {/* Plan de pago diferido — sobre la compra de los terneros */}
      <PlanPago montoTotal={calc.costoCompra} inflacionMensual={inflacion} color="amber" />

      {/* Asesor IA — Compra Recría */}
      <AsesorIA
        color="amber"
        titulo="Análisis de la compra de recría"
        placeholder="Ej: ¿Conviene esta compra? ¿A qué precio mínimo tengo que vender? ¿Qué riesgos tengo?"
        contexto={(() => {
          const l = lotes[loteActivo] || lotes[0];
          if (!l) return "Sin datos de lote cargados";
          const c = calcLote(l);
          return [
            `Lote: ${l.nombre} | ${l.categoria === "machos" ? "Machos ♂" : "Hembras ♀"} | ${l.cabezas} cab`,
            `Peso ingreso: ${l.pesoIngreso} kg/cab | Precio compra: $${Number(l.precioCompraKg).toLocaleString("es-AR")}/kg`,
            `Inversión total: $${Math.round(c.costoTotal).toLocaleString("es-AR")}`,
            `Modalidad: ${l.modalidadVenta === "feedlot" ? "Feedlot" : "Invernada"} | Días feedlot: ${l.diasFeedlot ?? 60}`,
            `Precio venta estimado: $${Number(l.precioVentaKg).toLocaleString("es-AR")}/kg`,
            `Margen estimado: $${Math.round(c.margen).toLocaleString("es-AR")}`,
            `Precio mínimo invernada: $${Math.round(c.precioMinInvernada)}/kg`,
            `Precio mínimo gordo: $${Math.round(c.precioMinGordo)}/kg`,
          ].join("\n");
        })()}
      />

      {/* Guardar simulación */}
      <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
        <BotonExportarPDF color="amber"
          titulo="Compra de Recría — Análisis de Inversión"
          subtitulo={`${lotes.length} lote(s) · ${totales.cabezas} cab · Inversión ${fmtM(totales.costoTotal)}`}
          secciones={(() => {
            const c = calcLote(lotes[loteActivo]);
            const l = lotes[loteActivo];
            return [
              { grupo: "Resumen de todos los lotes" },
              { label: "Lotes simulados", value: `${lotes.length} lote(s)` },
              { label: "Total cabezas", value: `${totales.cabezas} cab` },
              { label: "Inversión total", value: fmtM(totales.costoTotal), destacado: true, color: "#b45309" },
              { label: "Inversión total (USD)", value: usd(totales.costoTotal) },

              { grupo: "Detalle por lote" },
              ...lotes.map(lt => {
                const cl = calcLote(lt);
                return { label: `${lt.categoria==="machos"?"♂":"♀"} ${lt.nombre} (${lt.cabezas} cab)`, value: fmtM(cl.costoTotal) };
              }),

              { grupo: `Lote activo: ${l.nombre}` },
              { label: "Categoría", value: l.categoria === "machos" ? "Machos ♂" : "Hembras ♀" },
              { label: "Cabezas", value: `${fmt(l.cabezas)} cab` },
              { label: "Peso ingreso", value: `${fmt(l.pesoIngreso)} kg/cab` },
              { label: "Precio compra", value: `$${fmt(l.precioCompraKg)}/kg` },
              { label: "Peso salida estimado", value: `${fmt(c.pesoSalida, 0)} kg` },
              { label: "Kg ganados/cab", value: `${fmt(c.kgGanados, 0)} kg` },

              { grupo: "Desglose de costos (lote activo)" },
              { label: "Compra terneros", value: fmtM(c.costoCompra) },
              { label: "Flete entrada", value: fmtM(c.costoFleteEntrada) },
              { label: "Comisión compra", value: fmtM(c.costoComisionC) },
              { label: "Sanidad", value: fmtM(c.costoSanidad) },
              { label: "Suplemento", value: fmtM(c.costoSuplemento) },
              { label: "Pastaje", value: fmtM(c.costoPastaje) },
              { label: "Feedlot", value: fmtM(c.costoFeedlot) },
              { label: "Flete salida", value: fmtM(c.costoFleteSalida) },
              { label: "Comisión venta", value: fmtM(c.costoComisionV) },
              { label: "Costo total", value: fmtM(c.costoTotal), destacado: true, color: "#b45309" },

              { grupo: "Resultado (lote activo)" },
              { label: "Ingreso por venta", value: fmtM(c.ingresoVenta) },
              { label: "Margen estimado", value: fmtM(c.margen), destacado: true, color: c.margen >= 0 ? "#065f46" : "#dc2626" },
              { label: "Margen/cabeza", value: fmtM(c.margenPorCab) },
              { label: "ROI", value: `${fmt(c.roi, 1)}%` },
              { label: "Precio venta de equilibrio", value: `$${fmt(c.peqKg)}/kg` },
              { label: "Precio mín. invernada", value: `$${fmt(c.precioMinInvernada)}/kg` },
              { label: "Precio mín. gordo", value: `$${fmt(c.precioMinGordo)}/kg` },
              { label: "Inflación acumulada", value: `${fmt(c.inflAcumPct, 1)}%` },
            ];
          })()}
        />
        <BotonGuardarSim color="amber"
          onGuardar={() => onGuardar && onGuardar({
            tipo: "compra-recria",
            label: `Compra recría — ${totales.cabezas} cab / ${fmtM(totales.costoTotal)}`,
            lotes: lotes.map(l => ({ ...l, calc: calcLote(l) })),
            totales,
            fecha: new Date().toISOString(),
          })}
        />
      </div>
      </div>
    </div>
  );
}

// ── Input especial para precio novillo: tipeo libre + botones long-press ────
function PrecioNovInput({ value, onChange }) {
  const [str, setStr] = useState(null); // null = mostrar prop, string = tipeo en curso

  const handleChange = (e) => setStr(e.target.value);
  const handleBlur = () => {
    const n = parseInt((str ?? "").replace(/\D/g, ""), 10);
    if (!isNaN(n) && n > 0) onChange(n);
    setStr(null);
  };
  const handleFocus = (e) => { setStr(String(value)); e.target.select(); };

  const step = 50;
  const incFn = useCallback(() => onChange(Math.round((value + step) / step) * step), [onChange, value]);
  const decFn = useCallback(() => onChange(Math.max(0, Math.round((value - step) / step) * step)), [onChange, value]);
  const incLP = useLongPress(incFn, 80);
  const decLP = useLongPress(decFn, 80);

  return (
    <div className="flex items-stretch gap-0 rounded-2xl border-2 border-slate-200 overflow-hidden shadow-sm">
      <button {...decLP}
        className="w-12 bg-slate-800 hover:bg-slate-900 text-white font-black text-xl flex items-center justify-center shrink-0 active:bg-slate-700 transition-colors touch-manipulation select-none">
        −
      </button>
      <div className="flex-1 relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 pointer-events-none font-bold">$</span>
        <input
          type="text"
          inputMode="numeric"
          value={str !== null ? str : value.toLocaleString("es-AR")}
          onChange={handleChange}
          onBlur={handleBlur}
          onFocus={handleFocus}
          className="w-full h-full py-3 pl-7 pr-10 text-center font-mono font-black text-lg text-slate-800 focus:outline-none bg-white"
          style={{ border: "none" }}
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 pointer-events-none">/kg</span>
      </div>
      <button {...incLP}
        className="w-12 bg-slate-800 hover:bg-slate-900 text-white font-black text-xl flex items-center justify-center shrink-0 active:bg-slate-700 transition-colors touch-manipulation select-none">
        +
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO: PASTAJE — Gestión de animales de terceros
// ═══════════════════════════════════════════════════════════════════════════
// Componente para sincronizar descartes a terminación
function SyncDescartesBtn({ criaDatos, setCriaActiva, setTermActiva, onToast }) {
  const [confirm, setConfirm] = React.useState(false);
  const vacaCut    = criaDatos.vacaCut    ?? 0;
  const vaqRechazo = criaDatos.vaqRechazo ?? 0;
  if (!confirm) return (
    <button onClick={() => setConfirm(true)}
      className="w-full py-2.5 rounded-2xl border-2 border-dashed border-amber-400 text-amber-700 font-black text-xs hover:bg-amber-50 transition-all flex items-center justify-center gap-2">
      🔄 Transferir descartes a Terminación
    </button>
  );
  return (
    <div className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-4 space-y-3">
      <p className="text-xs font-black text-amber-800">⚠️ Autorizar transferencia a Terminación</p>
      <div className="space-y-1 text-xs text-amber-700">
        {vacaCut > 0    && <p>• {vacaCut} Vaca CUT → <b>Vaca Engorde</b></p>}
        {vaqRechazo > 0 && <p>• {vaqRechazo} Vaq Rechazo → <b>Vaq Engorde</b></p>}
        <p className="text-amber-600 italic">Los animales se mantienen en tu campo — solo cambia su categoría contable.</p>
      </div>
      <div className="flex gap-2">
        <button onClick={() => {
          setTermActiva(p => ({ ...p, vacaEngorde: (p.vacaEngorde??0) + vacaCut, vaqEngorde: (p.vaqEngorde??0) + vaqRechazo }));
          setCriaActiva(p => ({ ...p, vacaCut: 0, vaqRechazo: 0 }));
          setConfirm(false);
          onToast("✅ Descartes transferidos a Terminación", "success");
        }} className="flex-1 py-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-xs font-black transition-all active:scale-95">
          Confirmar transferencia
        </button>
        <button onClick={() => setConfirm(false)}
          className="flex-1 py-2 rounded-xl bg-slate-100 text-slate-600 text-xs font-black transition-all active:scale-95">
          Cancelar
        </button>
      </div>
    </div>
  );
}

// Componente para destete parcial
function DesteteParcialBtn({ ternerosNoDestetados, pctMachos, onDestetar }) {
  const pctM = pctMachos ?? 50;
  const [machos,  setMachos]  = React.useState(0);
  const [hembras, setHembras] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  const total = (parseInt(machos)||0) + (parseInt(hembras)||0);

  const handleOpen = () => {
    // Pre-fill con la proyección basada en terneros al pie y % machos
    const tot = ternerosNoDestetados > 0 ? ternerosNoDestetados : 0;
    setMachos(Math.round(tot * pctM / 100));
    setHembras(tot - Math.round(tot * pctM / 100));
    setOpen(true);
  };

  if (!open) return (
    <button onClick={handleOpen}
      className="w-full py-2.5 rounded-2xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-black transition-all active:scale-95 flex items-center justify-center gap-2">
      🐄 Registrar destete
    </button>
  );

  return (
    <div className="bg-emerald-50 border-2 border-emerald-200 rounded-2xl p-4 space-y-4">
      <p className="text-xs font-black text-emerald-700 uppercase tracking-widest">Registrar destete</p>

      <div className="grid grid-cols-2 gap-3">
        {/* Machos */}
        <div className="bg-blue-50 border-2 border-blue-200 rounded-2xl p-3 space-y-2">
          <p className="text-xs font-black text-blue-700">♂ Machos</p>
          <div className="flex items-center gap-2">
            <button onClick={() => setMachos(m => Math.max(0, (parseInt(m)||0) - 1))}
              className="w-8 h-8 rounded-lg bg-blue-600 text-white font-black text-sm flex items-center justify-center active:scale-95">−</button>
            <input
              type="number" min="0"
              value={machos}
              onChange={e => setMachos(e.target.value)}
              className="flex-1 text-center text-xl font-black text-blue-800 bg-white border-2 border-blue-200 rounded-xl px-2 py-1 focus:outline-none focus:border-blue-400"
            />
            <button onClick={() => setMachos(m => (parseInt(m)||0) + 1)}
              className="w-8 h-8 rounded-lg bg-blue-600 text-white font-black text-sm flex items-center justify-center active:scale-95">+</button>
          </div>
          <p className="text-xs text-blue-500 text-center">→ recría</p>
        </div>

        {/* Hembras */}
        <div className="bg-rose-50 border-2 border-rose-200 rounded-2xl p-3 space-y-2">
          <p className="text-xs font-black text-rose-700">♀ Hembras</p>
          <div className="flex items-center gap-2">
            <button onClick={() => setHembras(h => Math.max(0, (parseInt(h)||0) - 1))}
              className="w-8 h-8 rounded-lg bg-rose-500 text-white font-black text-sm flex items-center justify-center active:scale-95">−</button>
            <input
              type="number" min="0"
              value={hembras}
              onChange={e => setHembras(e.target.value)}
              className="flex-1 text-center text-xl font-black text-rose-800 bg-white border-2 border-rose-200 rounded-xl px-2 py-1 focus:outline-none focus:border-rose-400"
            />
            <button onClick={() => setHembras(h => (parseInt(h)||0) + 1)}
              className="w-8 h-8 rounded-lg bg-rose-500 text-white font-black text-sm flex items-center justify-center active:scale-95">+</button>
          </div>
          <p className="text-xs text-rose-500 text-center">→ reposición / venta</p>
        </div>
      </div>

      {/* Total */}
      <div className={"rounded-xl px-3 py-2 text-center " + (total > 0 ? "bg-emerald-100" : "bg-slate-100")}>
        <span className="text-sm font-black text-slate-700">Total: {total} terneros</span>
        {ternerosNoDestetados > 0 && total !== ternerosNoDestetados && (
          <span className="text-xs text-amber-600 ml-2">(al pie: {ternerosNoDestetados})</span>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => {
            const m = parseInt(machos)||0;
            const h = parseInt(hembras)||0;
            if (m + h < 1) return;
            onDestetar(m + h, m, h);
            setOpen(false);
          }}
          disabled={total < 1}
          className="flex-1 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-200 disabled:text-slate-400 text-white text-sm font-black transition-all active:scale-95">
          ✓ Confirmar destete
        </button>
        <button onClick={() => setOpen(false)}
          className="px-4 py-2 rounded-xl bg-slate-100 text-slate-600 text-sm font-black active:scale-95">✕</button>
      </div>
    </div>
  );
}
function TropaEditorFields({ tropa, onSave }) {
  const defaultPeso = parseFloat(tropa.pesoEntradaKg ?? (tropa.cat === "terneras" || tropa.cat === "terneros" ? 180 : tropa.cat === "recria" ? 200 : 380)) || 0;
  const defaultGdp  = parseFloat(tropa.gdpEstimado  ?? (tropa.cat === "terneras" || tropa.cat === "terneros" ? 0.6  : tropa.cat === "recria" ? 0.5  : 0))   || 0;
  const [peso, setPeso] = React.useState(defaultPeso);
  const [gdp,  setGdp]  = React.useState(defaultGdp);
  const isGainCat = tropa.cat === "terneras" || tropa.cat === "terneros" || tropa.cat === "recria";
  const savePeso = (e) => { e.stopPropagation(); const v = parseFloat(peso); if (v > 0) onSave({ pesoEntradaKg: v }); };
  const saveGdp  = (e) => { e.stopPropagation(); const v = parseFloat(gdp);  if (v >= 0) onSave({ gdpEstimado: v }); };
  return (
    <div className="grid grid-cols-2 gap-2 pt-1 border-t border-slate-100" onClick={e => e.stopPropagation()}>
      <div className="bg-emerald-50 rounded-xl px-3 py-2">
        <p className="text-xs text-slate-500 font-bold mb-1">⚖️ Peso entrada (kg)</p>
        <input
          type="number" min="30" step="5"
          value={peso}
          onChange={e => setPeso(e.target.value)}
          onBlur={savePeso}
          onClick={e => e.stopPropagation()}
          className="w-full text-sm font-black text-emerald-800 bg-white border border-emerald-200 rounded-lg px-2 py-1 focus:outline-none focus:border-emerald-400"
        />
      </div>
      <div className="bg-violet-50 rounded-xl px-3 py-2">
        <p className="text-xs text-slate-500 font-bold mb-1">📈 GDP (kg/día)</p>
        <input
          type="number" min="0" step="0.05"
          value={gdp}
          onChange={e => setGdp(e.target.value)}
          onBlur={saveGdp}
          onClick={e => e.stopPropagation()}
          className="w-full text-sm font-black text-violet-800 bg-white border border-violet-200 rounded-lg px-2 py-1 focus:outline-none focus:border-violet-400"
        />
        <p className="text-xs text-slate-400 mt-1">{!isGainCat ? "0 = peso estable" : tropa.cat === "recria" ? "típico 0.5" : "típico 0.6"}</p>
      </div>
    </div>
  );
}

function PastajeCampo({ pastaje, setPastaje, precioNovillo = 2800, stockPropio, onToast }) {
  const [vista, setVista] = useState("tropas");
  const [modal, setModal] = useState(null);
  const [tropaEgreso, setTropaEgreso] = useState(null);
  const [tropaSuplemento, setTropaSuplemento] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmDeleteProp, setConfirmDeleteProp] = useState(null); // id del propietario a eliminar
  const [propSelec, setPropSelec] = useState(null); // elevado aquí para sobrevivir re-renders

  // ── Todo el estado de pastaje vive aquí, NUNCA sube al padre durante edición ──
  const [localPastaje, setLocalPastaje] = React.useState(() => pastaje ?? {});
  const localPastajeRef = React.useRef(localPastaje);

  // Sync DOWN from parent only on first mount
  React.useEffect(() => {
    setLocalPastaje(pastaje ?? {});
    localPastajeRef.current = pastaje ?? {};
  }, []); // eslint-disable-line

  // Update local ONLY — no propagation to parent during editing
  const updateLocal = React.useCallback((patch) => {
    setLocalPastaje(prev => {
      const next = { ...prev, ...patch };
      localPastajeRef.current = next;
      return next;
    });
  }, []);

  // Sync al padre — llamar solo desde el botón Guardar o al desmontar
  const syncToParent = React.useCallback(() => {
    setPastaje(localPastajeRef.current);
  }, [setPastaje]);

  // Sync al desmontar (cambian de sección)
  React.useEffect(() => {
    return () => {
      setPastaje(localPastajeRef.current);
    };
  }, [setPastaje]);

  const precioNov    = localPastaje?.precioNov ?? precioNovillo;
  const setPrecioNov = (v) => updateLocal({ precioNov: v });

  // ── Estados de VistaCobros ────────────────────────────────────────────────
  const hoy = new Date().toISOString().slice(0, 10);
  const [modoCobro,    setModoCobro]    = useState("semestral");
  const [fechaHasta,   setFechaHasta]   = useState(hoy);
  const [showLiquidar, setShowLiquidar] = useState(false);
  const [expandPag,    setExpandPag]    = useState(false);
  const [expandId,     setExpandId]     = useState(null);
  const [propCobro,    setPropCobro]    = useState(null);

  const tropas   = localPastaje?.tropas   ?? [];
  const periodos = localPastaje?.periodos ?? [];
  const precios  = localPastaje?.precios  ?? { vacas: 6, toros: 5.5, terneras: 5.5, terneros: 5.5, recria: 5.5 };
  const terceros = localPastaje?.terceros ?? [];

  const setTropas   = (fn) => updateLocal({ tropas:   typeof fn === "function" ? fn(tropas)   : fn });
  const setPeriodos = (fn) => updateLocal({ periodos: typeof fn === "function" ? fn(periodos) : fn });
  const setPrecios  = (p)  => updateLocal({ precios:  { ...precios, ...p } });
  const setTerceros = (fn) => updateLocal({ terceros: typeof fn === "function" ? fn(terceros) : fn });

  const CATS = [
    { id: "vacas",    label: "Vacas / Vaquillonas",       emoji: "🐄", color: "emerald" },
    { id: "toros",    label: "Toros",                      emoji: "🐂", color: "blue"    },
    { id: "terneros", label: "Terneros (machos)",           emoji: "🐃", color: "sky"     },
    { id: "terneras", label: "Terneras (hembras)",          emoji: "🐃", color: "amber"   },
    { id: "recria",   label: "Recría (novillos/terneros)", emoji: "🐑", color: "violet"  },
  ];
  const CAT_COLORS = {
    vacas:    { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-800", strip: "bg-emerald-500",  dot: "#10b981" },
    toros:    { bg: "bg-sky-50",     border: "border-sky-200",     text: "text-sky-800",     strip: "bg-sky-500",      dot: "#0ea5e9" },
    terneros: { bg: "bg-sky-50",     border: "border-sky-200",     text: "text-sky-800",     strip: "bg-sky-400",      dot: "#38bdf8" },
    terneras: { bg: "bg-amber-50",   border: "border-amber-200",   text: "text-amber-800",   strip: "bg-amber-400",    dot: "#f59e0b" },
    recria:   { bg: "bg-violet-50",  border: "border-violet-200",  text: "text-violet-800",  strip: "bg-violet-500",   dot: "#8b5cf6" },
  };

  const HOY_FIJO = new Date().toISOString().slice(0, 10);

  // Corregir fechaIngreso corruptas automáticamente al montar
  useEffect(() => {
    if (tropas.length === 0) return;
    const necesitaFix = tropas.some(t => !t.fechaIngreso || t.fechaIngreso === HOY_FIJO || t.fechaIngreso > "2026-04-21");
    if (!necesitaFix) return;
    const tropasCorregidas = tropas.map(t => ({
      ...t,
      fechaIngreso: (!t.fechaIngreso || t.fechaIngreso >= HOY_FIJO) ? "2026-04-21" : t.fechaIngreso,
      terceroId: t.terceroId ?? 1,
    }));
    setPastaje({ tropas: tropasCorregidas });
    setTimeout(() => {
      const email = vacaStore.getState().__userEmail;
      if (email) guardarEstado(email).catch(console.error);
    }, 500);
  }, [tropas.length]); // solo cuando cambia la cantidad de tropas

  const necesitaCorreccion = false; // ya no necesitamos el banner manual

  const diasEntre = (desde, hasta) => {
    const parseLocal = (s) => {
      const str = s || hoy; // hoy ya es new Date().toISOString().slice(0,10) — solo fecha
      const [y, m, d] = String(str).slice(0, 10).split("-").map(Number);
      return new Date(y, m - 1, d);
    };
    const d1 = parseLocal(desde);
    const d2 = parseLocal(hasta);
    // floor: el día de corte no cuenta (igual que planilla Excel)
    return Math.max(0, Math.floor((d2 - d1) / (1000 * 60 * 60 * 24)));
  };
  const kgDevengados = (tropa, hasta) => {
    const cab = tropa.cabActual ?? tropa.cab;
    if (cab <= 0) return 0;
    const kgMes = precios[tropa.cat] ?? 6;
    return cab * kgMes * (diasEntre(tropa.fechaIngreso, hasta) / 30);
  };
  const kgTotalesHoy = tropas.reduce((s, t) => s + kgDevengados(t, null), 0);
  const kgPendientes = periodos.filter(p => p.estado === "pendiente").reduce((s, p) => s + (p.kgTotal ?? 0), 0);
  const totalCabPastaje = tropas.reduce((s, t) => s + (t.cabActual ?? t.cab), 0);

  // ── Fecha de inicio del próximo período (el ultimoCobro más antiguo) ──────
  const fechaDesdeAuto = useMemo(() => {
    if (tropas.length === 0) return hoy;
    // Usar el ultimoCobro más antiguo, o si no hay, el fechaIngreso más antiguo
    const fechas = [...tropas].map(t => t.ultimoCobro || t.fechaIngreso).filter(Boolean).sort();
    const earliest = fechas[0] || hoy;
    // Si la fecha desde coincide con hoy (no tiene sentido), usar fechaIngreso más antigua
    if (earliest >= hoy) {
      const ingresos = [...tropas].map(t => t.fechaIngreso).filter(Boolean).sort();
      return ingresos[0] || hoy;
    }
    return earliest;
  }, [tropas]);

  // Fecha hasta efectiva: derivada del modo o libre si el usuario eligió "fecha"
  const calcFechaHastaAuto = (modo, desde) => {
    const d = new Date(desde);
    if (modo === "trimestral") d.setMonth(d.getMonth() + 3);
    else if (modo === "semestral") d.setMonth(d.getMonth() + 6);
    else if (modo === "anual") d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  };
  // La fecha hasta SIEMPRE es la que elige el usuario — nunca se calcula automático
  const fechaHastaEfectiva = fechaHasta;

  // ── Cálculo de suplemento de una tropa en un rango de fechas ─────────────
  // Retorna { kgSup, pesosSup, detallesMes } para el período [desde, hasta]
  // Cada mes tiene su propio kgDia. Itera día a día y suma el kgDia del mes correspondiente.
  const calcSuplemento = (tropa, desde, hasta) => {
    const sup = tropa.suplemento;
    if (!sup || !sup.activo || !sup.precioPorKg || sup.precioPorKg <= 0) return { kgSup: 0, pesosSup: 0, detallesMes: [] };
    const cab = tropa.cabActual ?? tropa.cab;
    if (cab <= 0) return { kgSup: 0, pesosSup: 0, detallesMes: [] };

    const dInicio = new Date(desde);
    const dFin    = new Date(hasta || new Date());

    // kgDiaPorMes: objeto { 1: 2.5, 2: 0, 3: 1.8, ... } — si el mes no está o es 0 no suma
    const kgDiaPorMes = sup.kgDiaPorMes ?? {};

    // Acumular por mes para el detalle
    const acumMes = {}; // { "2026-04": { dias, kgTotal } }

    let d = new Date(dInicio);
    while (d < dFin) {
      const m  = d.getMonth() + 1;           // 1-12
      const kg = kgDiaPorMes[m] ?? 0;
      if (kg > 0) {
        const key = `${d.getFullYear()}-${String(m).padStart(2,"0")}`;
        if (!acumMes[key]) acumMes[key] = { mes: m, anio: d.getFullYear(), label: MESES_LABELS[m-1], kgDia: kg, dias: 0, kgTotal: 0 };
        acumMes[key].dias++;
        acumMes[key].kgTotal += kg;
      }
      d.setDate(d.getDate() + 1);
    }

    const detallesMes = Object.values(acumMes);
    const kgSup    = Math.round(detallesMes.reduce((s, x) => s + cab * x.kgTotal, 0) * 10) / 10;
    const pesosSup = Math.round(kgSup * sup.precioPorKg);
    const diasConSup = detallesMes.reduce((s, x) => s + x.dias, 0);
    return { kgSup, pesosSup, diasConSup, detallesMes };
  };

  const fmtN    = (n) => Math.round(n).toLocaleString("es-AR");
  const fmtPesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");
  const fmtK1   = fmtPesos; // alias para no romper usos existentes
  const fmtFecha = (f) => {
    if (!f) return "—";
    const [y, m, d] = f.split("-");
    return `${d}/${m}/${y.slice(2)}`;
  };
  const toast = onToast || ((msg) => console.log(msg));

  // ── Modal Wrapper ─────────────────────────────────────────────────────────
  const ModalWrapper = ({ titulo, children, onClose, onGuardar }) => (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      style={{ background: "rgba(15,23,42,0.6)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-t-3xl sm:rounded-3xl w-full sm:max-w-lg p-5 space-y-5 shadow-2xl max-h-[90vh] overflow-y-auto sim-zoom-enter">
        <div className="flex items-center justify-between">
          <h3 className="font-black text-slate-800 text-base">{titulo}</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 font-black transition-colors">✕</button>
        </div>
        {children}
        <div className="flex gap-3 pt-2">
          <button onClick={onClose} className="flex-1 py-3 rounded-2xl border-2 border-slate-200 text-slate-600 font-black text-sm hover:bg-slate-50 transition-all">Cancelar</button>
          <button onClick={onGuardar} className="flex-1 py-3 rounded-2xl bg-emerald-500 hover:bg-emerald-600 text-white font-black text-sm shadow-md transition-all active:scale-95">Guardar</button>
        </div>
      </div>
    </div>
  );

  // ── Modal Nueva Tropa ─────────────────────────────────────────────────────
  const ModalNuevaTropa = ({ onClose }) => {
    const GDP_DEFAULTS  = { terneros: 0.6, terneras: 0.6, recria: 0.5, vacas: 0.3, toros: 0.4 };
    const PESO_DEFAULTS = { terneros: 180, terneras: 180, recria: 200, vacas: 380, toros: 450 };
    const [form, setForm] = useState({ cat: "vacas", cab: 10, origen: "", terceroId: terceros[0]?.id ?? "", fechaIngreso: new Date().toISOString().slice(0, 10), servicio: "ninguno", pesoEntradaKg: 380, gdpEstimado: 0.3, tropaOrigenId: "", tropaOrigenNombre: "" });
    const set = (k) => (e) => {
      const val = e.target ? e.target.value : e;
      setForm(p => {
        const next = { ...p, [k]: val };
        if (k === "cat") {
          next.pesoEntradaKg = PESO_DEFAULTS[val] ?? 200;
          next.gdpEstimado   = GDP_DEFAULTS[val]  ?? 0.5;
        }
        if (k === "tropaOrigenId") {
          const madre = tropas.find(t => String(t.id) === String(val));
          next.tropaOrigenNombre = madre ? madre.origen : "";
          // Auto-fill origen with mother tropa name
          if (madre) next.origen = madre.origen;
        }
        return next;
      });
    };
    const guardar = () => {
      if (!form.origen.trim() || form.cab <= 0) { toast("Completá origen y cabezas", "warn"); return; }
      if (!form.terceroId) { toast("Seleccioná un propietario", "warn"); return; }
      setTropas(prev => [...prev, { ...form, cab: Number(form.cab), cabActual: Number(form.cab), terceroId: Number(form.terceroId), pesoEntradaKg: parseFloat(form.pesoEntradaKg) || 0, gdpEstimado: parseFloat(form.gdpEstimado) || 0, id: Date.now() }]);
      toast(`✅ Tropa ${form.origen} (${form.cab} cab) agregada`, "success");
      onClose();
    };
    return (
      <ModalWrapper titulo="Nueva tropa de pastaje" onClose={onClose} onGuardar={guardar}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Origen / descripción</label>
            <input value={form.origen} onChange={set("origen")} placeholder="Ej: Londero, Marca líquida, Compra…"
              className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400" />
          </div>
          <div className="sm:col-span-2">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Propietario (tercero)</label>
            <select value={form.terceroId} onChange={set("terceroId")}
              className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400">
              <option value="">— Seleccioná propietario —</option>
              {terceros.map(t => <option key={t.id} value={t.id}>{t.nombre}</option>)}
            </select>
            {terceros.length === 0 && <p className="text-xs text-amber-600 mt-1">⚠ Primero agregá un propietario en la pestaña Tropas</p>}
          </div>
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Categoría</label>
            <select value={form.cat} onChange={set("cat")} className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400">
              {CATS.map(c => <option key={c.id} value={c.id}>{c.emoji} {c.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Cabezas</label>
            <input type="number" min="1" value={form.cab} onChange={set("cab")} className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400" />
          </div>
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Fecha ingreso</label>
            <input type="date" value={form.fechaIngreso} onChange={set("fechaIngreso")} className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400" />
          </div>
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Servicio</label>
            <select value={form.servicio} onChange={set("servicio")} className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400">
              <option value="ninguno">Sin servicio</option>
              <option value="verano">Servicio verano</option>
              <option value="otoño">Servicio otoño</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Peso entrada (kg/cab)</label>
            <input type="number" min="50" value={form.pesoEntradaKg} onChange={set("pesoEntradaKg")} className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400" />
            <p className="text-xs text-slate-400 mt-1">Terneros: 180 kg · Recría: 200 kg</p>
          </div>
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">GDP estimado (kg/día)</label>
            <input type="number" min="0.1" step="0.05" value={form.gdpEstimado} onChange={set("gdpEstimado")} className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400" />
            <p className="text-xs text-slate-400 mt-1">Terneros: 0.6 · Recría: 0.5 · Vacas: 0.3</p>
          </div>
          {tropas.length > 0 && (
            <div className="sm:col-span-2">
              <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Cría de tropa existente (opcional)</label>
              <select value={form.tropaOrigenId} onChange={set("tropaOrigenId")} className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400">
                <option value="">— Sin vínculo (tropa independiente) —</option>
                {tropas.map(t => <option key={t.id} value={t.id}>{t.origen} ({t.cabActual ?? t.cab} cab)</option>)}
              </select>
              <p className="text-xs text-slate-400 mt-1">Si estos animales son crías de otra tropa, vinculálos para trazabilidad. Si la tropa madre se vende, esta tropa queda registrada igual.</p>
            </div>
          )}
        </div>
      </ModalWrapper>
    );
  };

  // ── Modal Egreso — solo movimiento de stock, sin cobro ───────────────────
  // El cobro se liquida siempre por período (trimestre/semestre/año/fecha).
  // El egreso registra el cambio de cabezas y el tramo que "cerró" para esa
  // cantidad, de modo que la liquidación futura lo tome correctamente.
  const ModalEgreso = ({ tropa, onClose }) => {
    const cabActual = tropa.cabActual ?? tropa.cab;
    const [form, setForm] = useState({
      cantidad: cabActual,
      fechaEgreso: new Date().toISOString().slice(0, 10),
      motivo: "venta",
      obs: "",
    });
    const set = (k) => (e) => setForm(p => ({ ...p, [k]: e.target ? e.target.value : e }));
    const cab = Math.min(Number(form.cantidad) || 0, cabActual);
    // Días desde el último corte de cobro (o desde ingreso si nunca se cobró)
    const ultimoCobro = (tropa.ultimoCobro) || tropa.fechaIngreso;
    const diasDesdeCorte = diasEntre(ultimoCobro, form.fechaEgreso);
    const diasTotales    = diasEntre(tropa.fechaIngreso, form.fechaEgreso);
    const kgMes = precios[tropa.cat] ?? 6;
    // kg del tramo que se cierra (desde último corte hasta egreso)
    const kgTramo = cab * kgMes * (diasDesdeCorte / 30);

    const guardar = () => {
      if (cab <= 0) { toast("Ingresá la cantidad que sale", "warn"); return; }
      // Registrar el movimiento de stock en la tropa:
      // - bajamos cabezas
      // - guardamos el tramo cerrado para que la próxima liquidación no lo duplique
      const tramoEgreso = {
        fecha: form.fechaEgreso,
        cab,
        desdeCorte: ultimoCobro,
        dias: diasDesdeCorte,
        kgTramo: Math.round(kgTramo * 10) / 10,
        motivo: form.motivo,
        obs: form.obs,
      };
      setTropas(prev => prev.map(t =>
        t.id === tropa.id
          ? {
              ...t,
              cabActual: (t.cabActual ?? t.cab) - cab,
              tramosEgreso: [...(t.tramosEgreso || []), tramoEgreso],
            }
          : t
      ));
      // También lo registramos en periodos como evento visible en la pestaña Eventos
      setPeriodos(prev => [...prev, {
        id: Date.now(), tipo: "evento", subtipo: "egreso",
        tropaOrigen: tropa.origen, cat: tropa.cat,
        cab, fecha: form.fechaEgreso, motivo: form.motivo, obs: form.obs,
        diasEstadia: diasTotales,
        kgTramoInfo: Math.round(kgTramo * 10) / 10,
        estado: "registrado",
      }]);
      toast(`✅ Egreso registrado: ${cab} cab de ${tropa.origen} al ${fmtFecha(form.fechaEgreso)}`, "success");
      onClose();
    };

    return (
      <ModalWrapper titulo={`Egreso de stock — ${tropa.origen}`} onClose={onClose} onGuardar={guardar}>
        <div className="rounded-2xl bg-blue-50 border-2 border-blue-200 px-4 py-3 text-xs text-blue-700 font-semibold mb-1">
          ℹ️ Esto solo actualiza el stock. El cobro se hace desde la pestaña <b>Cobros</b> al cerrar el período.
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Cabezas que salen</label>
            <input type="number" min="1" max={cabActual} value={form.cantidad} onChange={set("cantidad")}
              className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400" />
            <p className="text-xs text-slate-400 mt-1">Máx: {cabActual} cab</p>
          </div>
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Fecha de salida</label>
            <input type="date" value={form.fechaEgreso} onChange={set("fechaEgreso")}
              className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400" />
          </div>
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Motivo</label>
            <select value={form.motivo} onChange={set("motivo")}
              className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400">
              <option value="venta">Venta / terminación</option>
              <option value="descarte">Descarte</option>
              <option value="mortandad">Mortandad</option>
              <option value="retiro">Retiro dueño</option>
              <option value="otro">Otro</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Observaciones</label>
            <input value={form.obs} onChange={set("obs")} placeholder="Opcional"
              className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400" />
          </div>
        </div>
        {/* Info del tramo que queda descolgado hasta el próximo cobro */}
        <div className="rounded-2xl bg-slate-50 border-2 border-slate-200 p-4 space-y-2">
          <p className="text-xs font-black uppercase tracking-widest text-slate-500">Tramo acumulado por estas cabezas</p>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-white rounded-xl p-2 border border-slate-200">
              <p className="text-xs text-slate-400">Días en campo</p>
              <p className="font-black text-slate-800 text-sm">{diasTotales} días</p>
            </div>
            <div className="bg-white rounded-xl p-2 border border-slate-200">
              <p className="text-xs text-slate-400">Desde último cobro</p>
              <p className="font-black text-slate-700 text-sm">{diasDesdeCorte} días</p>
            </div>
            <div className="bg-white rounded-xl p-2 border border-slate-200">
              <p className="text-xs text-slate-400">kg aprox. del tramo</p>
              <p className="font-black text-amber-700 text-sm">{fmtN(Math.round(kgTramo))} kg</p>
            </div>
          </div>
          <p className="text-xs text-slate-400 italic">
            Se liquidará junto con el próximo cobro del período. {cab} cab × {kgMes} kg/mes × {diasDesdeCorte} días ÷ 30
          </p>
        </div>
      </ModalWrapper>
    );
  };

  // ── Modal Evento ──────────────────────────────────────────────────────────
  const ModalEvento = ({ onClose }) => {
    const [form, setForm] = useState({ tipo: "servicio-verano", tropaId: tropas[0]?.id ?? "", fecha: new Date().toISOString().slice(0, 10), cab: 0, obs: "" });
    const set = (k) => (e) => setForm(p => ({ ...p, [k]: e.target ? e.target.value : e }));
    const tropaSelec = tropas.find(t => String(t.id) === String(form.tropaId));
    const guardar = () => {
      const evento = { id: Date.now(), ...form, cab: Number(form.cab), tropaOrigen: tropaSelec?.origen || "—", cat: tropaSelec?.cat || "vacas", tipo: form.tipo, estado: "registrado" };
      setPeriodos(prev => [...prev, { ...evento, tipo: "evento" }]);
      if (form.tipo === "mortandad" && tropaSelec && Number(form.cab) > 0) {
        setTropas(prev => prev.map(t => t.id === tropaSelec.id ? { ...t, cabActual: Math.max(0, (t.cabActual ?? t.cab) - Number(form.cab)) } : t));
      }
      toast(`✅ Evento registrado: ${form.tipo} — ${tropaSelec?.origen}`, "success");
      onClose();
    };
    return (
      <ModalWrapper titulo="Registrar evento" onClose={onClose} onGuardar={guardar}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Tipo de evento</label>
            <select value={form.tipo} onChange={set("tipo")} className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400">
              <option value="servicio-verano">Servicio verano</option>
              <option value="servicio-otoño">Servicio otoño</option>
              <option value="destete">Destete</option>
              <option value="mortandad">Mortandad</option>
              <option value="otro">Otro</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Tropa</label>
            <select value={form.tropaId} onChange={set("tropaId")} className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400">
              {tropas.filter(t => (t.cabActual ?? t.cab) > 0).map(t => <option key={t.id} value={t.id}>{t.origen} ({t.cabActual ?? t.cab} cab)</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Fecha</label>
            <input type="date" value={form.fecha} onChange={set("fecha")} className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400" />
          </div>
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">{form.tipo === "mortandad" ? "Bajas" : "Cabezas involucradas"}</label>
            <input type="number" min="0" value={form.cab} onChange={set("cab")} className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400" />
          </div>
          <div className="sm:col-span-2">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Observaciones</label>
            <input value={form.obs} onChange={set("obs")} placeholder="Opcional" className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400" />
          </div>
        </div>
      </ModalWrapper>
    );
  };

  // ── Modal Suplemento ─────────────────────────────────────────────────────
  const MESES_LABELS = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
  const ModalSuplemento = ({ tropa, onClose }) => {
    const supInicial = tropa.suplemento ?? {
      activo: false, precioPorKg: 0,
      kgDiaPorMes: {},
      usarFechas: false, fechaDesde: "", fechaHasta: "",
    };
    const [sup, setSup] = useState(supInicial);
    const setS = (k) => (v) => setSup(p => ({ ...p, [k]: v }));

    // kg/día de un mes en particular
    const setKgMes = (m, val) => setSup(p => ({
      ...p,
      kgDiaPorMes: { ...p.kgDiaPorMes, [m]: parseFloat(val) || 0 },
    }));

    const cab = tropa.cabActual ?? tropa.cab;

    // Atajos: poner el mismo valor a un rango de meses
    const setRango = (meses, val) => setSup(p => {
      const nuevo = { ...p.kgDiaPorMes };
      meses.forEach(m => { nuevo[m] = val; });
      return { ...p, kgDiaPorMes: nuevo };
    });

    // Preview total por mes
    const previewMeses = MESES_LABELS.map((lbl, i) => {
      const m   = i + 1;
      const kg  = sup.kgDiaPorMes?.[m] ?? 0;
      const diasMes = new Date(2026, m, 0).getDate(); // días en ese mes
      return { m, lbl, kg, kgTotal: kg * diasMes * cab, pesos: kg * diasMes * cab * (sup.precioPorKg || 0) };
    });
    const kgAnual   = previewMeses.reduce((s, x) => s + x.kgTotal, 0);
    const pesosAnual = previewMeses.reduce((s, x) => s + x.pesos, 0);

    const guardar = () => {
      const tieneConsumo = Object.values(sup.kgDiaPorMes ?? {}).some(v => v > 0);
      setTropas(prev => prev.map(t =>
        t.id === tropa.id
          ? { ...t, suplemento: { ...sup, activo: tieneConsumo && sup.precioPorKg > 0 } }
          : t
      ));
      toast(`✅ Suplemento de ${tropa.origen} actualizado`, "success");
      onClose();
    };

    return (
      <ModalWrapper titulo={`💊 Suplemento — ${tropa.origen}`} onClose={onClose} onGuardar={guardar}>
        <div className="space-y-5">

          {/* Precio del suplemento */}
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Precio del suplemento ($/kg)</label>
            <input type="number" step="10" min="0" value={sup.precioPorKg}
              onChange={e => setS("precioPorKg")(parseFloat(e.target.value) || 0)}
              className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm font-mono font-black text-center focus:outline-none focus:border-amber-400" />
          </div>

          {/* Grilla de consumo por mes */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Consumo por mes (kg/animal/día)</p>
            </div>
            <p className="text-xs text-slate-400 mb-3">Dejá en 0 los meses que no consume</p>

            <div className="space-y-1.5">
              {MESES_LABELS.map((lbl, i) => {
                const m      = i + 1;
                const kg     = sup.kgDiaPorMes?.[m] ?? 0;
                const activo = kg > 0;
                const kgMesTotal = kg * new Date(2026, m, 0).getDate() * cab;
                return (
                  <div key={m} className={`flex items-center gap-3 rounded-xl px-3 py-2 border transition-all ${activo ? "bg-amber-50 border-amber-200" : "bg-slate-50 border-slate-200"}`}>
                    <span className={`text-xs font-black w-8 ${activo ? "text-amber-700" : "text-slate-400"}`}>{lbl}</span>
                    <input
                      type="number" step="0.1" min="0" value={kg === 0 ? "" : kg}
                      placeholder="0"
                      onChange={e => setKgMes(m, e.target.value)}
                      className={`w-20 border rounded-lg px-2 py-1 text-sm font-mono font-black text-center focus:outline-none transition-all ${activo ? "border-amber-300 bg-white text-amber-800 focus:border-amber-500" : "border-slate-200 bg-white text-slate-500 focus:border-slate-400"}`}
                    />
                    <span className="text-xs text-slate-400">kg/ani/día</span>
                    {activo && sup.precioPorKg > 0 && (
                      <div className="ml-auto text-right">
                        <span className="text-xs text-amber-600 font-bold">{fmtN(Math.round(kgMesTotal))} kg</span>
                        <span className="text-xs text-slate-400 ml-2">{fmtPesos(kgMesTotal * sup.precioPorKg)}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Atajos */}
            <div className="flex gap-2 mt-3 flex-wrap">
              <button onClick={() => setRango([1,2,3,4,5,6,7,8,9,10,11,12], 0)}
                className="text-xs font-bold px-3 py-1.5 rounded-xl bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200 transition-all">
                Limpiar todo
              </button>
              <button onClick={() => setRango([4,5,6,7,8,9], sup.kgDiaPorMes?.[4] || 2)}
                className="text-xs font-bold px-3 py-1.5 rounded-xl bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition-all">
                Otoño-inv (Abr→Sep)
              </button>
              <button onClick={() => setRango([10,11,12,1,2,3], sup.kgDiaPorMes?.[10] || 1)}
                className="text-xs font-bold px-3 py-1.5 rounded-xl bg-sky-50 text-sky-700 border border-sky-200 hover:bg-sky-100 transition-all">
                Primavera-ver
              </button>
            </div>
          </div>

          {/* Resumen anual */}
          {kgAnual > 0 && (
            <div className="bg-amber-50 border-2 border-amber-200 rounded-2xl p-3.5">
              <p className="text-xs font-black uppercase tracking-widest text-amber-700 mb-2">Proyección anual · {cab} cab</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-white rounded-xl border border-amber-100 p-2.5 text-center">
                  <p className="text-xs text-amber-500">kg totales/año</p>
                  <p className="font-black text-amber-800 text-lg">{fmtN(Math.round(kgAnual))} kg</p>
                </div>
                <div className="bg-white rounded-xl border border-amber-100 p-2.5 text-center">
                  <p className="text-xs text-amber-500">$ totales/año</p>
                  <p className="font-black text-amber-800 text-lg">{fmtPesos(pesosAnual)}</p>
                </div>
              </div>
              {/* Barra visual por mes */}
              <div className="mt-3 flex items-end gap-1 h-12">
                {previewMeses.map(x => {
                  const maxKg = Math.max(...previewMeses.map(p => p.kgTotal), 1);
                  const h = Math.round((x.kgTotal / maxKg) * 100);
                  return (
                    <div key={x.m} className="flex-1 flex flex-col items-center gap-0.5" title={`${x.lbl}: ${fmtN(Math.round(x.kgTotal))} kg`}>
                      <div className="w-full rounded-t-sm transition-all" style={{ height: `${h}%`, background: h > 0 ? "#d97706" : "#e2e8f0", minHeight: h > 0 ? 3 : 0 }} />
                      <span className="text-[9px] text-slate-400">{x.lbl.slice(0,1)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </ModalWrapper>
    );
  };

  // ── Modal Tercero ─────────────────────────────────────────────────────────
  const ModalTercero = ({ onClose }) => {
    const [nombre, setNombre] = useState("");
    const guardar = () => {
      if (!nombre.trim()) return;
      setTerceros(prev => [...prev, { id: Date.now(), nombre: nombre.trim() }]);
      toast(`✅ Tercero "${nombre}" agregado`, "success");
      onClose();
    };
    return (
      <ModalWrapper titulo="Agregar tercero" onClose={onClose} onGuardar={guardar}>
        <div>
          <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Nombre del tercero</label>
          <input value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Ej: García, Estancia Don Juan…"
            className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-400"
            autoFocus onKeyDown={e => e.key === "Enter" && guardar()} />
        </div>
      </ModalWrapper>
    );
  };

  // ── Tabs ──────────────────────────────────────────────────────────────────
  const TABS = [
    { id: "tropas",  label: "Tropas",  emoji: "🐄" },
    { id: "eventos", label: "Eventos", emoji: "📋" },
    { id: "cobros",  label: "Cobros",  emoji: "💰" },
    { id: "resumen", label: "Resumen", emoji: "📊" },
  ];
  // ── Vista Tropas ──────────────────────────────────────────────────────────
  // ── Vista Tropas ──────────────────────────────────────────────────────────
  const VistaTropas = () => {
    const svcLabel = { verano: "Serv. verano", "otoño": "Serv. otoño" };
    const svcColor = { verano: "bg-sky-100 text-sky-700 border-sky-200", "otoño": "bg-amber-100 text-amber-700 border-amber-200" };

    // ── DETALLE propietario ────────────────────────────────────────────────
    if (propSelec !== null) {
      const prop = terceros.find(t => t.id === propSelec);
      if (!prop) { setPropSelec(null); return null; }
      // Tropas sin terceroId se consideran del primer propietario (migración automática)
      const tropasDelProp = tropas.filter(t => {
        const tid = t.terceroId ?? terceros[0]?.id;
        return tid === prop.id && (t.cabActual ?? t.cab) > 0;
      });
      const cabTotal = tropasDelProp.reduce((s, t) => s + (t.cabActual ?? t.cab), 0);
      const kgTotal  = tropasDelProp.reduce((s, t) => s + kgDevengados(t, null), 0);
      return (
        <div className="space-y-4">
          <button onClick={() => setPropSelec(null)}
            className="flex items-center gap-2 text-slate-500 hover:text-slate-800 text-xs font-bold uppercase tracking-widest transition-colors">
            ← Volver a propietarios
          </button>
          <div className="bg-emerald-700 rounded-3xl p-4 text-white shadow-lg">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-white/20 font-black text-lg flex items-center justify-center">
                {prop.nombre.slice(0,2).toUpperCase()}
              </div>
              <div className="flex-1">
                <p className="font-black text-xl">👤 {prop.nombre}</p>
                <p className="text-emerald-200 text-xs">{cabTotal} cab · {fmtN(Math.round(kgTotal))} kg nov devengados</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-emerald-300">Total devengado</p>
                <p className="font-black text-2xl">{fmtPesos(kgTotal * precioNov)}</p>
              </div>
            </div>
          </div>
          {CATS.filter(c => tropasDelProp.some(t => t.cat === c.id)).map(cat => {
            const col = CAT_COLORS[cat.id];
            const tropasDeEstacat = tropasDelProp.filter(t => t.cat === cat.id);
            return (
              <div key={cat.id} className={`rounded-3xl border-2 overflow-hidden shadow-sm ${col.border} ${col.bg}`}>
                <div className={`h-1.5 ${col.strip}`} />
                <div className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xl">{cat.emoji}</span>
                      <span className={`text-xs font-black uppercase tracking-widest ${col.text}`}>{cat.label}</span>
                    </div>
                    <span className={`text-sm font-black ${col.text}`}>{tropasDeEstacat.reduce((s,t) => s+(t.cabActual??t.cab),0)} cab</span>
                  </div>
                  <div className="space-y-2">
                    {tropasDeEstacat.map(t => {
                      const cabAct = t.cabActual ?? t.cab;
                      const kgHoy  = kgDevengados(t, null);
                      return (
                        <div key={t.id} className="bg-white/80 rounded-2xl border border-white p-3 flex flex-col gap-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1">
                              <p className="font-black text-slate-800 text-sm">{t.origen}</p>
                              <div className="flex flex-wrap gap-1.5 mt-1">
                                <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full border border-slate-200 font-semibold">{cabAct} cab</span>
                                {/* Fecha de ingreso editable */}
                                <label className="text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full border border-slate-200 cursor-pointer hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 transition-all flex items-center gap-1" title="Tocá para editar la fecha de ingreso">
                                  ✏️ desde {fmtFecha(t.fechaIngreso)}
                                  <input type="date" value={t.fechaIngreso ?? ""} onChange={e => {
                                    const nueva = e.target.value;
                                    if (!nueva) return;
                                    setTropas(prev => prev.map(x => x.id === t.id ? { ...x, fechaIngreso: nueva } : x));
                                    toast(`✅ Fecha de ${t.origen} actualizada a ${fmtFecha(nueva)}`, "success");
                                  }} className="sr-only" />
                                </label>
                                {svcLabel[t.servicio] && <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${svcColor[t.servicio]}`}>{svcLabel[t.servicio]}</span>}
                                {t.cab !== cabAct && <span className="text-xs bg-red-50 text-red-600 px-2 py-0.5 rounded-full border border-red-200 font-semibold">orig {t.cab} → {cabAct}</span>}
                                {t.tropaOrigenNombre && (
                                  <span className="text-xs bg-orange-50 text-orange-700 px-2 py-0.5 rounded-full border border-orange-200 font-semibold">
                                    🔗 cría de {t.tropaOrigenNombre}
                                  </span>
                                )}
                                {t.suplemento?.activo && (
                                  <span className="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full border border-amber-200 font-semibold">
                                    💊 {Object.values(t.suplemento.kgDiaPorMes ?? {}).filter(v => v > 0).length} meses · {fmtPesos(t.suplemento.precioPorKg)}/kg
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="text-right">
                              <p className="text-xs text-slate-400">pastaje dev.</p>
                              <p className="font-black text-emerald-700 text-sm">{fmtN(Math.round(kgHoy))} kg</p>
                              <p className="text-xs text-slate-400">{fmtPesos(kgHoy * precioNov)}</p>
                            </div>
                          </div>
                          {/* ── Peso entrada y GDP editables ── */}
                          {(t.cat === "terneras" || t.cat === "terneros" || t.cat === "recria" || t.cat === "vacas" || t.cat === "toros") && (
                            <TropaEditorFields
                              tropa={t}
                              onSave={fields => setTropas(prev => prev.map(x => x.id === t.id ? { ...x, ...fields } : x))}
                            />
                          )}
                          <div className="flex gap-2 pt-1 border-t border-slate-100">
                            <button onClick={() => setTropaSuplemento(t)}
                              className={`flex-1 text-xs font-black py-1.5 rounded-xl border transition-all active:scale-95 ${t.suplemento?.activo ? "bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100" : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"}`}>
                              💊 Suplemento
                            </button>
                            <button onClick={() => setTropaEgreso(t)}
                              className="flex-1 text-xs font-black py-1.5 rounded-xl bg-orange-50 border border-orange-200 text-orange-700 hover:bg-orange-100 transition-all active:scale-95">
                              ↑ Egreso
                            </button>
                            <button onClick={() => setConfirmDelete(confirmDelete === t.id ? null : t.id)}
                              className="px-3 text-xs font-black py-1.5 rounded-xl bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 transition-all active:scale-95">✕</button>
                          </div>
                          {confirmDelete === t.id && (
                            <div className="flex gap-2 mt-1">
                              <span className="flex-1 text-xs text-red-600 font-semibold py-1.5 px-2">¿Eliminar {t.origen}?</span>
                              <button onClick={() => { setTropas(prev => prev.filter(x => x.id !== t.id)); setConfirmDelete(null); toast("🗑 Tropa " + t.origen + " eliminada", "warn"); }}
                                className="px-3 text-xs font-black py-1.5 rounded-xl bg-red-500 text-white hover:bg-red-600 transition-all active:scale-95">Sí, eliminar</button>
                              <button onClick={() => setConfirmDelete(null)}
                                className="px-3 text-xs font-black py-1.5 rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200 transition-all active:scale-95">Cancelar</button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
          {tropasDelProp.length === 0 && (
            <div className="text-center py-10 text-slate-400"><p className="text-3xl mb-2">🐄</p><p className="text-sm">Sin tropas asignadas a {prop.nombre}</p></div>
          )}
          <button onClick={() => setModal("tropa")}
            className="w-full py-3 rounded-2xl border-2 border-dashed border-emerald-300 text-emerald-700 font-black text-sm hover:bg-emerald-50 hover:border-emerald-400 transition-all">
            + Agregar tropa a {prop.nombre}
          </button>
        </div>
      );
    }

    // ── LISTA propietarios ─────────────────────────────────────────────────
    return (
      <div className="space-y-4">
        {/* Tarjetas propietarios */}
        {terceros.map(prop => {
          const tropasDelProp = tropas.filter(t => (t.terceroId ?? terceros[0]?.id) === prop.id);
          const cabTotal = tropasDelProp.reduce((s, t) => s + (t.cabActual ?? t.cab), 0);
          const kgTotal  = tropasDelProp.reduce((s, t) => s + kgDevengados(t, null), 0);
          return (
            <button key={prop.id} onClick={() => setPropSelec(prop.id)}
              className="w-full text-left bg-white rounded-3xl border-2 border-emerald-200 hover:border-emerald-400 hover:shadow-md p-4 transition-all group">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-emerald-700 text-white font-black text-lg flex items-center justify-center group-hover:scale-105 transition-transform">
                  {prop.nombre.slice(0,2).toUpperCase()}
                </div>
                <div className="flex-1">
                  <p className="font-black text-slate-800 text-base">👤 {prop.nombre}</p>
                  <p className="text-xs text-slate-500">{cabTotal} cab · {tropasDelProp.length} tropas</p>
                  <p className="text-xs text-emerald-600 font-semibold">{fmtN(Math.round(kgTotal))} kg nov devengados</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-slate-400">devengado</p>
                  <p className="font-black text-emerald-700 text-lg">{fmtPesos(kgTotal * precioNov)}</p>
                  <p className="text-xs text-slate-400 group-hover:text-emerald-600 transition-colors">Ver tropas →</p>
                </div>
              </div>
            </button>
          );
        })}

        {terceros.length === 0 && (
          <div className="text-center py-10 text-slate-400">
            <p className="text-3xl mb-2">👤</p>
            <p className="text-sm">Sin propietarios. Agregá uno primero.</p>
          </div>
        )}

        <button onClick={() => setModal("tercero")}
          className="w-full py-3 rounded-2xl border-2 border-dashed border-slate-300 text-slate-500 font-black text-sm hover:bg-slate-50 transition-all">
          + Agregar propietario
        </button>

        {stockPropio && (
          <div className="rounded-3xl border-2 border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-black uppercase tracking-widest text-slate-500 mb-3">📦 Stock propio (referencia)</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {[
                ["Vacas propias", stockPropio.cria?.vacas ?? 0, "text-emerald-700"],
                ["Vaquillonas", stockPropio.cria?.vaquillonas ?? 0, "text-emerald-600"],
                ["Terneros al pie", stockPropio.cria?.ternerosNoDestetados ?? 0, "text-amber-700"],
                ["Toros propios", stockPropio.cria?.toros ?? 0, "text-sky-700"],
                ["Recría propia", (stockPropio.recria?.ternerosLiquidaMachos ?? 0) + (stockPropio.recria?.novillos ?? 0), "text-violet-700"],
                ["Terminación", (stockPropio.terminacion?.novillosCampo ?? 0) + (stockPropio.terminacion?.novillosFeedlot ?? 0), "text-orange-700"],
              ].map(([lbl, val, col]) => (
                <div key={lbl} className="bg-white rounded-xl border border-slate-200 p-2.5 text-center">
                  <p className="text-xs text-slate-400">{lbl}</p>
                  <p className={"font-black text-base " + col}>{val} cab</p>
                </div>
              ))}
            </div>
            <div className="mt-3 pt-3 border-t border-slate-200 flex justify-between text-sm font-black">
              <span className="text-slate-600">Total campo completo</span>
              <span className="text-slate-800">
                {totalCabPastaje + ((stockPropio.cria?.vacas ?? 0) + (stockPropio.cria?.vaquillonas ?? 0) + (stockPropio.cria?.ternerosNoDestetados ?? 0) + (stockPropio.cria?.toros ?? 0) + (stockPropio.recria?.ternerosLiquidaMachos ?? 0) + (stockPropio.recria?.novillos ?? 0) + (stockPropio.terminacion?.novillosCampo ?? 0) + (stockPropio.terminacion?.novillosFeedlot ?? 0))} cab
              </span>
            </div>
          </div>
        )}
      </div>
    );
  };


  // ── Vista Eventos ─────────────────────────────────────────────────────────
  const VistaEventos = () => {
    const eventos = periodos
      .filter(p => p.tipo === "evento" || p.tipo === "egreso")
      .sort((a, b) => new Date(b.fecha || b.fechaEgreso) - new Date(a.fecha || a.fechaEgreso));
    const TIPO_CFG = {
      "servicio-verano": { color: "bg-sky-100 text-sky-700",        dot: "#0ea5e9", label: "Serv. verano" },
      "servicio-otoño":  { color: "bg-amber-100 text-amber-700",    dot: "#f59e0b", label: "Serv. otoño"  },
      destete:           { color: "bg-emerald-100 text-emerald-700", dot: "#10b981", label: "Destete"      },
      mortandad:         { color: "bg-red-100 text-red-700",         dot: "#ef4444", label: "Mortandad"    },
      egreso:            { color: "bg-orange-100 text-orange-700",   dot: "#f97316", label: "Egreso"       },
      otro:              { color: "bg-slate-100 text-slate-600",     dot: "#94a3b8", label: "Evento"       },
    };
    return (
      <div className="space-y-3">
        <div className="flex justify-end">
          <button onClick={() => setModal("evento")}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 text-white font-black text-xs shadow-md hover:bg-emerald-700 transition-all active:scale-95">
            + Nuevo evento
          </button>
        </div>
        {eventos.length === 0 && (
          <div className="text-center py-10 text-slate-400"><p className="text-3xl mb-2">📋</p><p className="text-sm">Sin eventos registrados aún</p></div>
        )}
        {eventos.map(ev => {
          const cfg = TIPO_CFG[ev.tipo] ?? TIPO_CFG.otro;
          const fecha = ev.fecha || ev.fechaEgreso;
          return (
            <div key={ev.id} className="bg-white rounded-2xl border border-slate-200 p-3.5 flex gap-3 shadow-sm">
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: cfg.dot, marginTop: 4, flexShrink: 0 }} />
              <div className="flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${cfg.color}`}>{cfg.label}</span>
                    <p className="font-black text-slate-800 text-sm mt-1">{ev.tropaOrigen}</p>
                  </div>
                  <span className="text-xs text-slate-400 whitespace-nowrap">{fmtFecha(fecha)}</span>
                </div>
                {ev.cab > 0 && <p className="text-xs text-slate-500 mt-1">{ev.cab} cab</p>}
                {ev.tipo === "egreso" && (
                  <div className="mt-1.5 flex gap-3 text-xs">
                    <span className="text-emerald-700 font-bold">{fmtN(ev.kgDevengados)} kg nov</span>
                    <span className="text-slate-500">${fmtK1(ev.pesosDevengados)} · {ev.diasEstadia} días</span>
                  </div>
                )}
                {ev.obs && <p className="text-xs text-slate-400 italic mt-1">{ev.obs}</p>}
              </div>
              <button onClick={() => { if (!window.confirm("¿Eliminar este evento?")) return; setPeriodos(prev => prev.filter(p => p.id !== ev.id)); }}
                className="text-xs text-slate-300 hover:text-red-500 font-black transition-colors self-start mt-1">✕</button>
            </div>
          );
        })}
      </div>
    );
  };

  // ── Vista Cobros ──────────────────────────────────────────────────────────
  // Lógica: el cobro siempre es por período (trim/sem/anual/fecha libre).
  // Al liquidar un período se calcula por tropa:
  //   cab_actuales × kg/mes × días_en_período ÷ 30
  //   + tramos de egresos que cayeron dentro del período (pro-rateados)
  // El último corte de cobro queda guardado en cada tropa como "ultimoCobro".
  const VistaCobros = () => {
    // propCobro elevado a PastajeCampo — se inicializa al primer propietario si está null
    const propCobroActivo = propCobro ?? terceros[0]?.id ?? null;

    // Tropas del propietario seleccionado
    // Si ninguna tropa tiene terceroId (datos viejos), mostrar todas bajo el primer propietario
    const algunaTieneId = tropas.some(t => t.terceroId != null);
    const tropasDelProp = algunaTieneId
      // eslint-disable-next-line eqeqeq
      ? tropas.filter(t => (t.terceroId != null ? t.terceroId : terceros[0]?.id) == propCobroActivo)
      : (propCobroActivo == terceros[0]?.id ? tropas : []);

    const calcLiquidacion = (fHasta) => {
      return tropasDelProp.map(tropa => {
        // Si fechaIngreso es >= fHasta (dato corrupto), usar fechaDesdeAuto
        const rawDesde = tropa.ultimoCobro || tropa.fechaIngreso || fechaDesdeAuto;
        const desde = rawDesde >= fHasta ? fechaDesdeAuto : rawDesde;
        const kgMes = precios[tropa.cat] ?? 6;
        const cabActual = tropa.cabActual ?? tropa.cab;
        const tramosEgreso = tropa.tramosEgreso || [];

        // Tramos de egresos que cayeron dentro de [desde, fHasta].
        // Cada tramo ya tiene guardado su kgTramo = cab × kgMes × diasDesdeCorte ÷ 30
        // (calculado al momento del egreso, con los días exactos que estuvo esa cantidad).
        const tramosEnPeriodo = tramosEgreso.filter(te =>
          te.fecha >= desde && te.fecha <= fHasta
        );
        const kgTramos = tramosEnPeriodo.reduce((s, te) => s + (te.kgTramo ?? 0), 0);

        // Las cabezas actuales (las que NO egresaron) cobran desde el punto correcto hasta fHasta.
        // Si hubo egresos en el período, el punto de partida de las restantes es el último egreso
        // (porque su tramo ya fue contado en kgTramos). Si no hubo egresos, arrancan desde `desde`.
        const ultimoEgresoEnPeriodo = tramosEnPeriodo.length > 0
          ? tramosEnPeriodo.slice().sort((a, b) => a.fecha > b.fecha ? 1 : -1).at(-1).fecha
          : desde;
        const diasRestantes = diasEntre(ultimoEgresoEnPeriodo, fHasta);
        const kgRestantes = cabActual > 0 ? cabActual * kgMes * (diasRestantes / 30) : 0;

        const kgTotal = Math.round((kgTramos + kgRestantes) * 10) / 10;
        const diasTotalesPeriodo = diasEntre(desde, fHasta);


        // ── Suplemento ──────────────────────────────────────────────────────
        const { kgSup, pesosSup, diasConSup, detallesMes } = calcSuplemento(tropa, desde, fHasta);

        return {
          tropaId: tropa.id,
          origen: tropa.origen,
          cat: tropa.cat,
          cabIniciales: tropa.cab,
          cabActual,
          desde,
          hasta: fHasta,
          diasTotalesPeriodo,
          tramosEnPeriodo,
          kgTramos: Math.round(kgTramos * 10) / 10,
          kgRestantes: Math.round(kgRestantes * 10) / 10,
          kgTotal,
          pesos: Math.round(kgTotal * precioNov),
          // suplemento discriminado
          kgSup:    Math.round(kgSup * 10) / 10,
          pesosSup: Math.round(pesosSup),
          diasConSup: diasConSup ?? 0,
          detallesMes: detallesMes ?? [],
          supActivo: (tropa.suplemento?.activo) ?? false,
          supKgDia: tropa.suplemento?.kgDia ?? 0,
          supPrecio: tropa.suplemento?.precioPorKg ?? 0,
          // total general = pastaje + suplemento
          totalPesos: Math.round(kgTotal * precioNov) + Math.round(pesosSup),
        };
      }).filter(l => l.kgTotal > 0 || l.kgSup > 0);
    };

    const preview       = calcLiquidacion(fechaHastaEfectiva);
    const kgPreview     = preview.reduce((s, l) => s + l.kgTotal, 0);
    const pesosPreview  = preview.reduce((s, l) => s + l.pesos, 0);
    const supPreview    = preview.reduce((s, l) => s + l.pesosSup, 0);
    const totalPreview  = pesosPreview + supPreview;

    // Cobros ya cerrados — filtrados por propietario
    // eslint-disable-next-line eqeqeq
    const cobrados   = periodos.filter(p => p.tipo === "cobro-periodo" && (p.propietarioId != null ? p.propietarioId : terceros[0]?.id) == propCobroActivo);
    const pendientes = cobrados.filter(p => p.estado === "pendiente");
    const pagados    = cobrados.filter(p => p.estado === "pagado");
    const kgPend = pendientes.reduce((s, p) => s + (p.kgTotal ?? 0), 0);
    const kgPag  = pagados.reduce((s, p) => s + (p.kgTotal ?? 0), 0);

    const confirmarLiquidacion = () => {
      if (preview.length === 0) { toast("No hay kg a liquidar en este período", "warn"); return; }
      // Crear el registro de cobro
      const nuevoCobro = {
        id: Date.now(), tipo: "cobro-periodo",
        propietarioId: propCobroActivo,
        modo: modoCobro, fechaDesde: fechaDesdeAuto, fechaHasta: fechaHastaEfectiva,
        lineas: preview,
        kgTotal: Math.round(kgPreview * 10) / 10,
        precioNov, pesos: pesosPreview,
        pesosSup: supPreview,
        totalPesos: totalPreview,
        estado: "pendiente",
        fechaCreacion: hoy,
      };
      setPeriodos(prev => [...prev, nuevoCobro]);
      // Actualizar ultimoCobro en cada tropa: guardar el día SIGUIENTE al corte
      // para que el próximo período arranque desde ahí sin solapar el último día
      const fechaSiguiente = (() => {
        const [y, m, d] = fechaHastaEfectiva.split("-").map(Number);
        const dt = new Date(y, m - 1, d + 1);
        return dt.toISOString().slice(0, 10);
      })();
      setTropas(prev => prev.map(t => {
        const linea = preview.find(l => l.tropaId === t.id);
        if (!linea) return t;
        return {
          ...t,
          ultimoCobro: fechaSiguiente,
          tramosEgreso: (t.tramosEgreso || []).filter(te => te.fecha > fechaHastaEfectiva),
        };
      }));
      setShowLiquidar(false);
      toast(`✅ Liquidación: ${fmtN(Math.round(kgPreview))} kg pastaje + ${fmtPesos(supPreview)} suplemento = ${fmtPesos(totalPreview)} total`, "success");
    };


    const marcarPagado = (id) => {
      setPeriodos(prev => prev.map(p => p.id === id ? { ...p, estado: "pagado", fechaPago: hoy } : p));
      toast("✅ Cobro marcado como pagado", "success");
    };

    const MODO_LABELS = { trimestral: "Trimestral", semestral: "Semestral", anual: "Anual", fecha: "Fecha específica" };

    // ── Generador de imagen PNG del cobro ─────────────────────────────────────
    const generarImagenCobro = (cobro) => {
      const canvas = document.createElement("canvas");
      const W = 800, padding = 40;
      const lineas = cobro.lineas ?? [];
      const tieneSuplemento = (cobro.pesosSup ?? 0) > 0;
      const H = 320 + lineas.length * 72 + (tieneSuplemento ? 160 : 120);
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d");

      const doDownload = () => {
        const link = document.createElement("a");
        link.download = `pastaje_${cobro.fechaHasta}.png`;
        link.href = canvas.toDataURL("image/png");
        link.click();
        toast("📥 Imagen descargada", "success");
      };

      const dibujar = (logoImg) => {
        // ── Fondo general ────────────────────────────────────────────────
        ctx.fillStyle = "#f8fafc";
        ctx.fillRect(0, 0, W, H);

        // ── Header blanco con logo (altura 90) ───────────────────────────
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, W, 90);

        // Línea divisoria sutil
        ctx.strokeStyle = "#e2e8f0";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, 90); ctx.lineTo(W, 90); ctx.stroke();

        // Logo centrado verticalmente en la franja blanca
        if (logoImg) {
          const logoH = 58, logoW = logoH * (logoImg.naturalWidth / logoImg.naturalHeight);
          ctx.drawImage(logoImg, padding, 16, logoW, logoH);
        }

        // Texto derecha del header
        ctx.textAlign = "right";
        ctx.fillStyle = "#064e3b";
        ctx.font = "bold 13px system-ui, sans-serif";
        ctx.fillText("GESTIÓN GANADERA PROFESIONAL", W - padding, 40);
        ctx.fillStyle = "#94a3b8";
        ctx.font = "11px system-ui, sans-serif";
        ctx.fillText("soypekun.vercel.app", W - padding, 58);
        ctx.fillStyle = "#475569";
        ctx.font = "11px system-ui, sans-serif";
        ctx.fillText(`Generado: ${fmtFecha(cobro.fechaCreacion ?? cobro.fechaHasta)}`, W - padding, 76);
        ctx.textAlign = "left";

        // ── Banda verde — título ──────────────────────────────────────────
        ctx.fillStyle = "#064e3b";
        ctx.fillRect(0, 90, W, 70);

        // Título
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 24px system-ui, sans-serif";
        ctx.fillText("Liquidación de Pastaje", padding, 128);

        // Fecha corte
        ctx.fillStyle = "#6ee7b7";
        ctx.font = "14px system-ui, sans-serif";
        ctx.fillText(`Corte al ${fmtFecha(cobro.fechaHasta)}`, padding, 150);

        // Propietario
        const prop = terceros.find(t => t.id == cobro.propietarioId);
        if (prop) {
          ctx.fillStyle = "#a7f3d0";
          ctx.textAlign = "right";
          ctx.font = "bold 14px system-ui, sans-serif";
          ctx.fillText(`👤 ${prop.nombre}`, W - padding, 128);
          ctx.textAlign = "left";
        }

        // ── Info de configuración ─────────────────────────────────────────
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 160, W, 36);
        ctx.fillStyle = "#334155";
        ctx.font = "13px system-ui, sans-serif";
        ctx.fillText(`Índice novillo: $${fmtN(cobro.precioNov)}/kg`, padding, 183);

        // ── Tabla header ──────────────────────────────────────────────────
        ctx.fillStyle = "#1e293b";
        ctx.fillRect(0, 196, W, 28);
        ctx.fillStyle = "#94a3b8";
        ctx.font = "bold 11px system-ui, sans-serif";
        ctx.fillText("TROPA / ORIGEN", padding + 8, 215);
        ctx.textAlign = "right";
        ctx.fillText("KG NOV", W - padding - 120, 215);
        ctx.fillText("MONTO", W - padding - 8, 215);
        ctx.textAlign = "left";

        // ── Filas de tropas ───────────────────────────────────────────────
        let y = 224;
        lineas.forEach((l, i) => {
          ctx.fillStyle = i % 2 === 0 ? "#f8fafc" : "#ffffff";
          ctx.fillRect(0, y, W, 68);

          // Borde izquierdo de color
          ctx.fillStyle = "#10b981";
          ctx.fillRect(0, y, 3, 68);

          ctx.fillStyle = "#0f172a";
          ctx.font = "bold 15px system-ui, sans-serif";
          ctx.fillText(l.origen, padding + 8, y + 20);

          ctx.fillStyle = "#64748b";
          ctx.font = "12px system-ui, sans-serif";
          ctx.fillText(`${l.cabActual} cab · ${l.diasTotalesPeriodo} días · desde ${fmtFecha(l.desde)}`, padding + 8, y + 38);

          if (l.tramosEnPeriodo?.length > 0) {
            ctx.fillStyle = "#ea580c";
            ctx.font = "11px system-ui, sans-serif";
            ctx.fillText("↑ " + l.tramosEnPeriodo.map(te => `Egreso ${fmtFecha(te.fecha)}: ${te.cab} cab`).join("  "), padding + 8, y + 56);
          }

          // Columna kg
          ctx.fillStyle = "#065f46";
          ctx.font = "bold 14px system-ui, sans-serif";
          ctx.textAlign = "right";
          ctx.fillText(`${fmtN(l.kgTotal)} kg`, W - padding - 120, y + 22);

          if (l.supActivo && l.kgSup > 0) {
            ctx.fillStyle = "#b45309";
            ctx.font = "11px system-ui, sans-serif";
            ctx.fillText(`+${fmtN(l.kgSup)} sup`, W - padding - 120, y + 40);
          }

          // Columna monto
          ctx.fillStyle = "#0f172a";
          ctx.font = "bold 15px system-ui, sans-serif";
          ctx.fillText(fmtPesos(l.pesos), W - padding - 8, y + 22);

          if (l.supActivo && l.kgSup > 0) {
            ctx.fillStyle = "#b45309";
            ctx.font = "11px system-ui, sans-serif";
            ctx.fillText(fmtPesos(l.pesosSup), W - padding - 8, y + 40);
          }

          ctx.textAlign = "left";
          y += 68;
        });

        // ── Separador ─────────────────────────────────────────────────────
        ctx.strokeStyle = "#cbd5e1";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        y += 2;

        // ── Total — fondo degradado ───────────────────────────────────────
        const totalH = tieneSuplemento ? 90 : 72;
        const grad = ctx.createLinearGradient(0, y, W, y);
        grad.addColorStop(0, "#064e3b");
        grad.addColorStop(1, "#065f46");
        ctx.fillStyle = grad;
        ctx.fillRect(0, y, W, totalH);

        // Borde superior
        ctx.strokeStyle = "#10b981";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();

        ctx.fillStyle = "#a7f3d0";
        ctx.font = "bold 12px system-ui, sans-serif";
        ctx.fillText("TOTAL PERÍODO", padding, y + 22);

        ctx.fillStyle = "#d1fae5";
        ctx.font = "16px system-ui, sans-serif";
        ctx.fillText(`${fmtN(cobro.kgTotal)} kg nov pastaje`, padding, y + 44);

        if (tieneSuplemento) {
          ctx.fillStyle = "#fcd34d";
          ctx.font = "13px system-ui, sans-serif";
          ctx.fillText(`+ ${fmtPesos(cobro.pesosSup)} suplemento`, padding, y + 66);
        }

        // Monto total — grande a la derecha
        ctx.textAlign = "right";
        ctx.font = "bold 34px system-ui, sans-serif";
        ctx.fillStyle = "#6ee7b7";
        ctx.fillText(fmtPesos(cobro.totalPesos ?? cobro.pesos), W - padding, y + (tieneSuplemento ? 52 : 46));
        ctx.textAlign = "left";

        // ── Footer ────────────────────────────────────────────────────────
        ctx.fillStyle = "#94a3b8";
        ctx.font = "11px system-ui, sans-serif";
        ctx.fillText("SoyPekun · Gestión Ganadera Profesional · soypekun.vercel.app", padding, H - 12);

        doDownload();
      };

      // Cargar logo y dibujar
      const logoImg = new Image();
      logoImg.onload = () => dibujar(logoImg);
      logoImg.onerror = () => dibujar(null);
      logoImg.src = `data:image/png;base64,${LOGO_B64}`;
    }; // end generarImagenCobro

    const CobRow = ({ c }) => {
      const expand = expandId === c.id;
      return (
        <div className={`rounded-2xl border-2 space-y-2 overflow-hidden ${c.estado === "pagado" ? "border-emerald-200" : "border-amber-200"}`}>
          {/* Header */}
          <div className={`p-3.5 ${c.estado === "pagado" ? "bg-emerald-50" : "bg-amber-50"}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap mb-1.5">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${c.estado === "pagado" ? "bg-emerald-100 text-emerald-700 border-emerald-200" : "bg-amber-100 text-amber-700 border-amber-200"}`}>
                    {c.estado === "pagado" ? "✓ Cobrado" : "⏳ Pendiente"}
                  </span>
                  {c.propietarioId && (() => { const p = terceros.find(x => x.id === c.propietarioId); return p ? <span className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full border border-slate-200 font-bold">👤 {p.nombre}</span> : null; })()}
                  <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full border border-slate-200 font-bold">{MODO_LABELS[c.modo] ?? c.modo ?? "—"}</span>
                </div>
                <p className="text-xs text-slate-500">{fmtFecha(c.fechaDesde)} → {fmtFecha(c.fechaHasta)}</p>
                <p className="text-xs text-slate-400 mt-0.5">{c.lineas?.length ?? 0} tropas · nov ${fmtN(c.precioNov)}/kg</p>
                {c.estado === "pagado" && c.fechaPago && <p className="text-xs text-emerald-600 mt-0.5">pagado {fmtFecha(c.fechaPago)}</p>}
              </div>
              <div className="text-right shrink-0">
                <p className="font-black text-slate-800 text-xl">{fmtPesos(c.totalPesos ?? c.pesos)}</p>
                <p className="text-xs text-slate-400">{fmtN(c.kgTotal)} kg pastaje</p>
                {c.pesosSup > 0 && <p className="text-xs text-amber-600 font-bold">+ {fmtPesos(c.pesosSup)} sup.</p>}
              </div>
            </div>
            <div className="flex gap-2 mt-2">
              <button onClick={() => setExpandId(expand ? null : c.id)}
                className="flex-1 text-xs font-bold py-1.5 rounded-xl border border-slate-200 bg-white/80 text-slate-600 hover:bg-white transition-all">
                {expand ? "▾ Ocultar detalle" : "▸ Ver por tropa"}
              </button>
              <button onClick={() => generarImagenCobro(c)}
                className="px-4 text-xs font-black py-1.5 rounded-xl bg-sky-50 border border-sky-200 text-sky-700 hover:bg-sky-100 transition-all active:scale-95">
                📥 Imagen
              </button>
              {c.estado === "pendiente" && (
                <button onClick={() => marcarPagado(c.id)}
                  className="flex-1 text-xs font-black py-1.5 rounded-xl bg-emerald-500 text-white hover:bg-emerald-600 transition-all active:scale-95">
                  Marcar cobrado ✓
                </button>
              )}
              <button onClick={() => {
                if (!window.confirm("¿Eliminar este cobro? Esta acción no se puede deshacer.")) return;
                setPeriodos(prev => prev.filter(p => p.id !== c.id));
                toast("🗑 Cobro eliminado", "warn");
              }}
                className="px-3 text-xs font-black py-1.5 rounded-xl bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 transition-all active:scale-95">
                ✕
              </button>
            </div>
          </div>
          {/* Detalle por tropa */}
          {expand && c.lineas && (
            <div className="px-3.5 pb-3.5 space-y-1.5">
              <p className="text-xs font-black uppercase tracking-widest text-slate-400 mb-2">Detalle por tropa</p>
              {c.lineas.map((l, i) => {
                const col = CAT_COLORS[l.cat] ?? CAT_COLORS.vacas;
                return (
                  <div key={i} className={`rounded-xl border overflow-hidden ${col.bg} ${col.border}`}>
                    <div className="p-2.5">
                      <div className="flex items-center justify-between">
                        <span className={`font-black text-sm ${col.text}`}>{l.origen}</span>
                        <span className={`font-black text-sm ${col.text}`}>{fmtN(l.kgTotal)} kg pastaje · {fmtPesos(l.pesos)}</span>
                      </div>
                      <div className="flex gap-3 mt-1 text-xs text-slate-500 flex-wrap">
                        <span>{l.cabActual} cab</span>
                        <span>{fmtFecha(l.desde)} → {fmtFecha(l.hasta)}</span>
                        <span>{l.diasTotalesPeriodo} días</span>
                        {l.tramosEnPeriodo?.length > 0 && (
                          <span className="text-orange-600 font-semibold">+ {l.tramosEnPeriodo.length} egreso(s)</span>
                        )}
                      </div>
                      {l.tramosEnPeriodo?.length > 0 && (
                        <div className="mt-1 space-y-0.5">
                          {l.tramosEnPeriodo.map((te, j) => (
                            <p key={j} className="text-xs text-orange-600 italic">
                              Egreso {fmtFecha(te.fecha)}: {te.cab} cab × {te.dias}d = {fmtN(te.kgTramo)} kg
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                    {l.supActivo && l.kgSup > 0 && (
                      <div className="bg-amber-50 border-t border-amber-200 px-2.5 py-2">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-black text-amber-700">💊 Suplemento · {l.diasConSup} días</span>
                          <span className="font-black text-sm text-amber-700">{fmtPesos(l.pesosSup)}</span>
                        </div>
                        {l.detallesMes?.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {l.detallesMes.map((dm, j) => (
                              <span key={j} className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full border border-amber-200">
                                {dm.label}: {dm.kgDia}kg/d × {dm.dias}d
                              </span>
                            ))}
                          </div>
                        )}
                        <p className="text-xs text-amber-500 mt-1">{fmtN(l.kgSup)} kg × {fmtPesos(l.supPrecio)}/kg</p>
                      </div>
                    )}
                    {l.supActivo && l.kgSup > 0 && (
                      <div className="bg-slate-100 border-t border-slate-200 px-2.5 py-1.5 flex justify-between">
                        <span className="text-xs font-black text-slate-600">Total tropa</span>
                        <span className="font-black text-sm text-slate-800">{fmtPesos(l.totalPesos)}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    };

    return (
      <div className="space-y-4">

        {/* Selector de propietario */}
        {terceros.length > 0 && (
          <div className="bg-white rounded-2xl border-2 border-slate-200 p-4">
            <p className="text-xs font-black uppercase tracking-widest text-slate-500 mb-3">Propietario a cobrar</p>
            <div className="flex flex-wrap gap-2">
              {terceros.map(t => (
                <button key={t.id} onClick={() => setPropCobro(t.id)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl font-black text-sm transition-all border-2 ${propCobroActivo === t.id ? "bg-emerald-700 text-white border-emerald-700 shadow-md" : "bg-white text-slate-600 border-slate-200 hover:border-emerald-300"}`}>
                  <span className="w-6 h-6 rounded-full bg-current/20 flex items-center justify-center text-xs">
                    {t.nombre.slice(0,2).toUpperCase()}
                  </span>
                  {t.nombre}
                </button>
              ))}
            </div>
            {propCobroActivo && (() => {
              const prop = terceros.find(x => x.id === propCobroActivo);
              const cabProp = tropasDelProp.reduce((s, t) => s + (t.cabActual ?? t.cab), 0);
              return prop ? <p className="text-xs text-slate-400 mt-2">{prop.nombre} · {cabProp} cab en campo · {tropasDelProp.length} tropas</p> : null;
            })()}
          </div>
        )}
        <div className="bg-white rounded-2xl border-2 border-slate-200 p-4 space-y-4">
          <p className="text-xs font-black uppercase tracking-widest text-slate-500">Configuración de cobro</p>
          {/* Precio novillo — input libre con botones long-press */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-bold text-slate-400">Índice novillo arrendamiento ($/kg)</p>
              <button onClick={() => { guardarEstado(vacaStore.getState().__userEmail); toast("✅ Precio guardado", "success"); }}
                className="text-xs font-black px-3 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 transition-all active:scale-95">
                ☁ Guardar
              </button>
            </div>
            <PrecioNovInput value={precioNov} onChange={setPrecioNov} />
            {/* Total en vivo */}
            {kgPreview > 0 && (
              <div className="mt-2 flex items-center justify-between bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
                <span className="text-xs text-emerald-700 font-bold">{fmtN(Math.round(kgPreview))} kg nov</span>
                <span className="text-base font-black text-emerald-800">{fmtPesos(totalPreview)}</span>
              </div>
            )}
          </div>
          {/* Precios por categoría */}
          <div>
            <p className="text-xs font-bold text-slate-400 mb-2">Pastaje por categoría (kg nov/animal/mes)</p>
            <div className="grid grid-cols-2 gap-2">
              {CATS.map(c => {
                const col = CAT_COLORS[c.id];
                return (
                  <div key={c.id} className={`rounded-xl border p-2 ${col.bg} ${col.border} flex items-center gap-2`}>
                    <span className="text-base">{c.emoji}</span>
                    <input type="number" step="0.5" min="0" value={precios[c.id]}
                      onChange={e => setPrecios({ [c.id]: parseFloat(e.target.value) || 0 })}
                      className={`w-16 border rounded-lg px-2 py-1 text-sm font-mono font-black text-center focus:outline-none bg-white/80 ${col.border}`} />
                    <span className="text-xs text-slate-400 whitespace-nowrap">kg/mes</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* KPIs actuales */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-amber-50 border-2 border-amber-200 rounded-2xl p-3 text-center">
            <p className="text-xs font-black uppercase tracking-widest text-amber-700 mb-1">Por cobrar</p>
            <p className="text-2xl font-black text-amber-800">{fmtN(Math.round(kgPend))} kg</p>
            <p className="text-sm text-amber-600">${fmtK1(kgPend * precioNov)}</p>
          </div>
          <div className="bg-emerald-50 border-2 border-emerald-200 rounded-2xl p-3 text-center">
            <p className="text-xs font-black uppercase tracking-widest text-emerald-700 mb-1">Cobrado</p>
            <p className="text-2xl font-black text-emerald-800">{fmtN(Math.round(kgPag))} kg</p>
            <p className="text-sm text-emerald-600">${fmtK1(kgPag * precioNov)}</p>
          </div>
        </div>

        {/* Botón para abrir liquidador */}
        <button onClick={() => setShowLiquidar(p => !p)}
          className="w-full py-3.5 rounded-2xl bg-slate-800 hover:bg-slate-700 text-white font-black text-sm shadow-md transition-all active:scale-95 flex items-center justify-center gap-2">
          <span>💰</span> {showLiquidar ? "Cerrar liquidador" : "Generar nuevo cobro de período"}
        </button>

        {/* Panel liquidador */}
        {showLiquidar && (
          <div className="rounded-3xl border-2 border-slate-800 bg-slate-50 p-4 space-y-4 sim-zoom-enter">
            <p className="text-xs font-black uppercase tracking-widest text-slate-700">Liquidar período</p>

            {/* Fecha de corte — la única que importa */}
            <div className="bg-white rounded-2xl border-2 border-slate-800 p-4 space-y-3">
              <div>
                <p className="text-xs font-black text-slate-700 uppercase tracking-widest mb-1">Fecha de corte del cobro</p>
                <p className="text-xs text-slate-400 mb-2">Elegí hasta qué fecha querés liquidar. Los animales que egresaron antes de esta fecha cobran sus días exactos hasta la salida.</p>
                <input type="date" value={fechaHasta} onChange={e => setFechaHasta(e.target.value)}
                  className="w-full border-2 border-slate-800 rounded-xl px-3 py-3 text-base font-mono font-black text-center focus:outline-none" />
                <div className="flex gap-2 mt-2">
                  {[
                    { label: "Hoy", dias: 0 },
                    { label: "Ayer", dias: -1 },
                    { label: "Hace 7 días", dias: -7 },
                  ].map(({ label, dias }) => {
                    const d = new Date(); d.setDate(d.getDate() + dias);
                    const f = d.toISOString().slice(0, 10);
                    return (
                      <button key={label} onClick={() => setFechaHasta(f)}
                        className={`flex-1 text-xs font-black py-1.5 rounded-xl border-2 transition-all ${fechaHasta === f ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"}`}>
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Preview de la liquidación */}
            {preview.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-black uppercase tracking-widest text-slate-500">Preview por tropa</p>
                {preview.map((l, i) => {
                  const col = CAT_COLORS[l.cat] ?? CAT_COLORS.vacas;
                  return (
                    <div key={i} className={`rounded-xl border ${col.bg} ${col.border} overflow-hidden`}>
                      <div className="p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1">
                            <p className={`font-black text-sm ${col.text}`}>{l.origen}</p>
                            <p className="text-xs text-slate-500 mt-0.5">
                              desde {fmtFecha(l.desde)} · {l.diasTotalesPeriodo} días
                              {l.tramosEnPeriodo?.length > 0 && <span className="text-orange-600 font-semibold ml-1">+ {l.tramosEnPeriodo.length} egreso(s)</span>}
                            </p>
                            {l.tramosEnPeriodo?.length > 0 && (
                              <p className="text-xs text-orange-600 italic mt-0.5">
                                {l.tramosEnPeriodo.map(te => `${te.cab} cab egr. ${fmtFecha(te.fecha)} (${te.dias}d)`).join(" · ")}
                              </p>
                            )}
                            {l.cabActual > 0 && (
                              <p className="text-xs text-slate-400 italic mt-0.5">
                                {l.cabActual} cab en campo × {diasEntre(l.tramosEnPeriodo?.length > 0 ? l.tramosEnPeriodo.slice().sort((a,b)=>a.fecha>b.fecha?1:-1).at(-1).fecha : l.desde, l.hasta)} días
                              </p>
                            )}
                          </div>
                          <div className="text-right shrink-0">
                            <p className={`font-black text-sm ${col.text}`}>{fmtN(l.kgTotal)} kg pastaje</p>
                            <p className="text-slate-600 font-bold text-sm">{fmtPesos(l.pesos)}</p>
                          </div>
                        </div>
                      </div>
                      {/* Suplemento discriminado */}
                      {l.supActivo && l.kgSup > 0 && (
                        <div className="bg-amber-50 border-t border-amber-200 px-3 py-2">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-black text-amber-700">💊 Suplemento · {l.diasConSup} días</span>
                            <span className="font-black text-sm text-amber-700">{fmtPesos(l.pesosSup)}</span>
                          </div>
                          {l.detallesMes?.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {l.detallesMes.map((dm, j) => (
                                <span key={j} className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full border border-amber-200">
                                  {dm.label}: {dm.kgDia} kg/día × {dm.dias}d
                                </span>
                              ))}
                            </div>
                          )}
                          <p className="text-xs text-amber-600 mt-1">{fmtN(l.kgSup)} kg × {fmtPesos(l.supPrecio)}/kg</p>
                        </div>
                      )}
                      {/* Total por tropa */}
                      {l.supActivo && l.kgSup > 0 && (
                        <div className="bg-slate-100 border-t border-slate-200 px-3 py-1.5 flex items-center justify-between">
                          <span className="text-xs font-black text-slate-600">Total tropa</span>
                          <span className="font-black text-sm text-slate-800">{fmtPesos(l.totalPesos)}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
                {/* Total */}
                <div className="bg-slate-800 text-white rounded-2xl p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-black uppercase tracking-widest text-white/60">Total período</p>
                      <p className="text-xs text-white/50">corte al {fmtFecha(fechaHastaEfectiva)}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-black">{fmtPesos(totalPreview)}</p>
                    </div>
                  </div>
                  <div className="border-t border-white/20 pt-2 grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-white/10 rounded-xl p-2">
                      <p className="text-white/60">Pastaje ({fmtN(Math.round(kgPreview))} kg nov)</p>
                      <p className="font-black text-white">{fmtPesos(pesosPreview)}</p>
                    </div>
                    {supPreview > 0 && (
                      <div className="bg-amber-500/30 rounded-xl p-2">
                        <p className="text-amber-200">💊 Suplemento</p>
                        <p className="font-black text-amber-100">{fmtPesos(supPreview)}</p>
                      </div>
                    )}
                  </div>
                </div>
                <button onClick={confirmarLiquidacion}
                  className="w-full py-3.5 rounded-2xl bg-emerald-500 hover:bg-emerald-600 text-white font-black text-sm shadow-md transition-all active:scale-95">
                  Confirmar y generar cobro ✓
                </button>
              </div>
            ) : (
              <div className="text-center py-6 text-slate-400">
                <p className="text-2xl mb-1">🔍</p>
                <p className="text-sm">Sin kg a liquidar en este período</p>
              </div>
            )}
          </div>
        )}

        {/* Cobros pendientes */}
        {pendientes.length > 0 && (
          <div className="space-y-3">
            <p className="text-xs font-black uppercase tracking-widest text-slate-500">Por cobrar ({pendientes.length})</p>
            {pendientes.map(c => <CobRow key={c.id} c={c} />)}
          </div>
        )}

        {/* Historial pagados */}
        {pagados.length > 0 && (
          <div className="bg-white rounded-2xl border-2 border-slate-200 p-4">
            <button onClick={() => setExpandPag(p => !p)} className="flex items-center justify-between w-full">
              <div className="flex items-center gap-2">
                <span className="text-lg">📜</span>
                <span className="text-xs font-black uppercase tracking-widest text-slate-600">Historial de cobros</span>
                <span className="text-xs bg-emerald-100 text-emerald-700 font-black px-2 py-0.5 rounded-full">{pagados.length}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-400">{fmtPesos(pagados.reduce((s,p) => s + (p.totalPesos ?? p.pesos ?? 0), 0))} cobrado total</span>
                <span className="text-xs text-slate-400">{expandPag ? "▾" : "▸"}</span>
              </div>
            </button>
            {expandPag && (
              <div className="mt-3 space-y-2">
                {pagados.sort((a,b) => new Date(b.fechaCreacion) - new Date(a.fechaCreacion)).map(c => <CobRow key={c.id} c={c} />)}
                <button onClick={() => {
                  const prop = terceros.find(t => t.id == propCobroActivo);
                  exportarPDF(
                    "Historial pastaje — " + (prop?.nombre ?? "Propietario"),
                    [
                      { label: "Propietario", value: prop?.nombre ?? "-" },
                      { label: "Total cobrado", value: fmtPesos(pagados.reduce((s,p) => s + (p.totalPesos ?? p.pesos ?? 0), 0)) },
                      { label: "─────────────", value: "─────────────" },
                      ...pagados.sort((a,b) => new Date(b.fechaCreacion) - new Date(a.fechaCreacion)).map(c => ({
                        label: fmtFecha(c.fechaCreacion ?? c.fecha) + (c.modo ? " (" + c.modo + ")" : ""),
                        value: fmtPesos(c.totalPesos ?? c.pesos ?? 0)
                      })),
                    ]
                  );
                }} className="w-full py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold text-xs transition-all">
                  🖨️ Exportar historial completo PDF
                </button>
              </div>
            )}
          </div>
        )}

        {cobrados.length === 0 && !showLiquidar && (
          <div className="text-center py-8 text-slate-400">
            <p className="text-3xl mb-2">💰</p>
            <p className="text-sm">Abrí el liquidador para generar el primer cobro</p>
          </div>
        )}
      </div>
    );
  };

  // ── Vista Resumen ─────────────────────────────────────────────────────────
  const VistaResumen = () => {
    const porOrigen = (() => {
      const map = {};
      tropas.forEach(t => {
        if (!map[t.origen]) map[t.origen] = { origen: t.origen, cat: t.cat, cab: 0, kgDev: 0 };
        map[t.origen].cab    += t.cabActual ?? t.cab;
        map[t.origen].kgDev += kgDevengados(t, null);
      });
      return Object.values(map).sort((a, b) => b.kgDev - a.kgDev);
    })();

    const totalCab = tropas.reduce((s, t) => s + (t.cabActual ?? t.cab), 0);
    const totalKgDev = porOrigen.reduce((s, o) => s + o.kgDev, 0);
    const kgCobPend = periodos.filter(p => p.tipo === "egreso" && p.estado === "pendiente").reduce((s, p) => s + (p.kgTotal ?? 0), 0);
    const stockProp = stockPropio
      ? (stockPropio.cria?.vacas ?? 0) + (stockPropio.cria?.vaquillonas ?? 0) +
        (stockPropio.cria?.ternerosNoDestetados ?? 0) + (stockPropio.cria?.toros ?? 0) +
        (stockPropio.recria?.ternerosLiquidaMachos ?? 0) + (stockPropio.recria?.novillos ?? 0) +
        (stockPropio.terminacion?.novillosCampo ?? 0) + (stockPropio.terminacion?.novillosFeedlot ?? 0)
      : 0;
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          {[
            { lbl: "Cab. pastaje",    val: totalCab,                          suf: "cab",    col: "text-slate-800" },
            { lbl: "Campo total",     val: totalCab + stockProp,               suf: "cab",    col: "text-slate-800" },
            { lbl: "Devengado hoy",   val: fmtN(Math.round(totalKgDev)),       suf: "kg nov", col: "text-emerald-700" },
            { lbl: "Por cobrar",      val: fmtN(Math.round(kgCobPend)),        suf: "kg nov", col: "text-amber-700" },
          ].map(k => (
            <div key={k.lbl} className="bg-white border-2 border-slate-200 rounded-2xl p-3.5 text-center kpi-pop">
              <p className="text-xs text-slate-400 uppercase tracking-widest font-bold">{k.lbl}</p>
              <p className={`text-2xl font-black ${k.col} mt-0.5`}>{k.val}</p>
              <p className="text-xs text-slate-400">{k.suf}</p>
            </div>
          ))}
        </div>
        <div className="bg-white rounded-2xl border-2 border-slate-200 p-4">
          <p className="text-xs font-black uppercase tracking-widest text-slate-500 mb-3">Por categoría</p>
          <div className="space-y-2">
            {CATS.map(c => {
              const cab = tropas.filter(t => t.cat === c.id).reduce((s, t) => s + (t.cabActual ?? t.cab), 0);
              const kg  = tropas.filter(t => t.cat === c.id).reduce((s, t) => s + kgDevengados(t, null), 0);
              if (cab === 0) return null;
              const col = CAT_COLORS[c.id];
              return (
                <div key={c.id} className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 ${col.bg} ${col.border}`}>
                  <span>{c.emoji}</span>
                  <span className={`flex-1 text-sm font-bold ${col.text}`}>{c.label}</span>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${col.border} ${col.bg} ${col.text}`}>{cab} cab</span>
                  <span className={`font-black text-sm ${col.text}`}>{fmtN(Math.round(kg))} kg</span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="bg-white rounded-2xl border-2 border-slate-200 p-4">
          <p className="text-xs font-black uppercase tracking-widest text-slate-500 mb-3">Por origen / tercero</p>
          <div className="space-y-2">
            {porOrigen.map(o => {
              const col = CAT_COLORS[o.cat] ?? CAT_COLORS.vacas;
              return (
                <div key={o.origen} className="flex items-center gap-3 py-2 border-b border-slate-100 last:border-0">
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: col.dot, flexShrink: 0 }} />
                  <span className="flex-1 text-sm text-slate-700 font-semibold">{o.origen}</span>
                  <span className="text-xs text-slate-400 font-semibold">{o.cab} cab</span>
                  <span className="font-black text-sm text-emerald-700">{fmtN(Math.round(o.kgDev))} kg</span>
                  <span className="text-xs text-slate-400">${fmtK1(o.kgDev * precioNov)}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-3 pt-2 border-t-2 border-slate-200 flex justify-between">
            <span className="font-black text-slate-700">Total devengado hoy</span>
            <div className="text-right">
              <span className="font-black text-emerald-700">{fmtN(Math.round(totalKgDev))} kg nov</span>
              <span className="text-slate-400 text-xs ml-2">${fmtK1(totalKgDev * precioNov)}</span>
            </div>
          </div>
        </div>
        {/* Gestión de terceros */}
        <div className="bg-white rounded-2xl border-2 border-slate-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-black uppercase tracking-widest text-slate-500">Propietarios</p>
            <button onClick={() => setModal("tercero")}
              className="text-xs font-black text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-xl hover:bg-emerald-100 transition-all">
              + Agregar
            </button>
          </div>
          {terceros.length === 0 && <p className="text-xs text-slate-400 italic">Sin propietarios cargados</p>}
          <div className="space-y-1.5">
            {terceros.map(t => {
              const tropasDelTercero = tropas.filter(tr => tr.terceroId === t.id);
              const cabTotal = tropasDelTercero.reduce((s, tr) => s + (tr.cabActual ?? tr.cab), 0);
              return (
                <div key={t.id} className="border-b border-slate-100 last:border-0">
                  <div className="flex items-center gap-2 py-1.5">
                    <div className="w-7 h-7 rounded-full bg-slate-800 text-white font-black text-xs flex items-center justify-center">{t.nombre.slice(0, 2).toUpperCase()}</div>
                    <div className="flex-1">
                      <span className="text-sm font-semibold text-slate-700">{t.nombre}</span>
                      {cabTotal > 0 && <span className="text-xs text-slate-400 ml-2">{cabTotal} cab</span>}
                      {tropasDelTercero.length > 0 && <span className="text-xs text-amber-600 ml-2">{tropasDelTercero.length} tropas</span>}
                    </div>
                    <button onClick={() => setConfirmDeleteProp(t.id)}
                      className="text-xs text-slate-300 hover:text-red-500 font-black transition-colors px-1">✕</button>
                  </div>
                  {confirmDeleteProp === t.id && (
                    <div className="mb-2 mx-1 bg-red-50 border-2 border-red-200 rounded-2xl p-3 space-y-2">
                      <p className="text-xs font-black text-red-700">⚠️ ¿Eliminar a {t.nombre}?</p>
                      <p className="text-xs text-red-600">
                        Esto eliminará el propietario y sus <b>{tropasDelTercero.length} tropas</b> con toda su información de pastaje y cobros. <b>Esta acción no se puede deshacer.</b>
                      </p>
                      <div className="flex gap-2">
                        <button onClick={() => {
                          setTerceros(prev => prev.filter(x => x.id !== t.id));
                          setTropas(prev => prev.filter(x => x.terceroId !== t.id));
                          setConfirmDeleteProp(null);
                          if (propSelec === t.id) setPropSelec(null);
                        }} className="flex-1 py-2 rounded-xl bg-red-500 hover:bg-red-600 text-white text-xs font-black transition-all active:scale-95">
                          Sí, eliminar todo
                        </button>
                        <button onClick={() => setConfirmDeleteProp(null)}
                          className="flex-1 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-black transition-all active:scale-95">
                          Cancelar
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Exportar resumen */}
        <button onClick={() => {
          const fecha = new Date().toLocaleDateString("es-AR", { dateStyle: "long" });
          exportarPDF(
            "Resumen Pastaje — " + fecha,
            [
              { label: "Fecha",           value: fecha },
              { label: "Cab. en pastaje", value: totalCab + " cab" },
              { label: "Devengado hoy",   value: fmtN(Math.round(totalKgDev)) + " kg nov · $" + fmtK1(totalKgDev * precioNov) },
              { label: "Por cobrar",      value: fmtN(Math.round(kgCobPend)) + " kg nov" },
              { label: "─ Por categoría ─", value: "─" },
              ...CATS.map(c => {
                const cab = tropas.filter(t => t.cat === c.id).reduce((s, t) => s + (t.cabActual ?? t.cab), 0);
                const kg  = tropas.filter(t => t.cat === c.id).reduce((s, t) => s + kgDevengados(t, null), 0);
                if (!cab) return null;
                return { label: c.emoji + " " + c.label, value: cab + " cab · " + fmtN(Math.round(kg)) + " kg" };
              }).filter(Boolean),
              { label: "─ Por origen ─", value: "─" },
              ...porOrigen.map(o => ({
                label: o.origen + " (" + o.cab + " cab)",
                value: fmtN(Math.round(o.kgDev)) + " kg · $" + fmtK1(o.kgDev * precioNov)
              })),
              { label: "─ Tropas activas ─", value: "─" },
              ...tropas.map(t => ({
                label: t.origen + " (" + (t.cabActual ?? t.cab) + " cab · desde " + (t.fechaIngreso ?? "-") + ")",
                value: fmtN(Math.round(kgDevengados(t, null))) + " kg devengados"
              })),
            ]
          );
        }} className="w-full py-3 rounded-2xl bg-slate-800 hover:bg-slate-900 text-white font-black text-sm transition-all active:scale-95 flex items-center justify-center gap-2">
          🖨️ Exportar resumen del campo PDF
        </button>
      </div>
    );
  };

  // ── Render principal ──────────────────────────────────────────────────────
  return (
    <div className="space-y-4 section-enter">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-black text-slate-800 text-xl tracking-tight">🤝 Pastaje</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            {totalCabPastaje} cab · devengado: <span className="font-bold text-emerald-700">{fmtN(Math.round(kgTotalesHoy))} kg nov</span>
            {kgPendientes > 0 && <> · <span className="text-amber-600 font-bold">{fmtN(Math.round(kgPendientes))} kg por cobrar</span></>}
          </p>
        </div>
        <button onClick={syncToParent}
          className="text-xs font-black px-3 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl transition-all active:scale-95 shadow-sm">
          💾 Guardar
        </button>
      </div>
      <div className="flex gap-2 flex-wrap">
        {TABS.map(({ id, label, emoji }) => (
          <button key={id} onClick={() => setVista(id)}
            className={`flex items-center gap-1.5 px-3 sm:px-4 py-2 rounded-xl font-black text-xs tracking-wide transition-all whitespace-nowrap
              ${vista === id ? "bg-emerald-600 text-white shadow-md" : "bg-white border border-slate-200 text-slate-500 hover:border-emerald-300 hover:text-emerald-700"}`}>
            <span>{emoji}</span><span>{label}</span>
          </button>
        ))}
      </div>
      <div key={vista}>
        {/* Banner de corrección de fechas */}
        {necesitaCorreccion && (
          <div className="mx-4 mb-3 bg-amber-50 border-2 border-amber-300 rounded-2xl p-3 flex items-center gap-3">
            <span className="text-lg">⚠️</span>
            <div className="flex-1">
              <p className="text-xs font-black text-amber-800">Fechas de ingreso incorrectas detectadas</p>
              <p className="text-xs text-amber-600">Las tropas tienen fecha de hoy en lugar del 21/04/2026.</p>
            </div>
            <button onClick={corregirFechas}
              className="text-xs font-black px-3 py-2 bg-amber-500 text-white rounded-xl hover:bg-amber-600 transition-all active:scale-95 shrink-0">
              🔧 Corregir
            </button>
          </div>
        )}
        {vista === "tropas"  && VistaTropas()}
        {vista === "eventos" && <VistaEventos />}
        {vista === "cobros"  && <VistaCobros />}
        {vista === "resumen" && <VistaResumen />}
      </div>
      {modal === "tropa"   && <ModalNuevaTropa   onClose={() => setModal(null)} />}
      {modal === "evento"  && <ModalEvento        onClose={() => setModal(null)} />}
      {modal === "tercero" && <ModalTercero        onClose={() => setModal(null)} />}
      {tropaEgreso         && <ModalEgreso tropa={tropaEgreso} onClose={() => setTropaEgreso(null)} />}
      {tropaSuplemento     && <ModalSuplemento tropa={tropaSuplemento} onClose={() => setTropaSuplemento(null)} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ESTRATEGIA COMERCIAL
// ═══════════════════════════════════════════════════════════════════════════
function EstrategiaComercial({ userEmail, onLogout }) {
  const [vistaActual, setVistaActual]   = useState("inicio");
  const [activeTab,   setActiveTab]     = useState("vientres");
  const [syncData,    setSyncData]      = useState(null);
  const [descarteData, setDescarteData] = useState(null);
  // Simulaciones desde el store (persisten en Firestore vía autosave)
  const simulaciones = useStore(vacaStore, s => s.simulaciones);
  const setSimulaciones = (updater) => {
    const actual = vacaStore.getState().simulaciones;
    const nuevo = typeof updater === "function" ? updater(actual) : updater;
    vacaStore.setState({ simulaciones: nuevo });
  };
  const [guardando,    setGuardando]    = useState(false);
  const [ultimoGuardado, setUltimoGuardado] = useState(null);
  const { toasts, push: pushToast } = useToast();

  // ── Optimización mobile robusta ──────────────────────────────────────────
  // 1) Garantiza el <meta viewport>.
  // 2) Detecta si es un dispositivo TÁCTIL (celular/tablet) por hardware y le
  //    pone la clase .is-mobile al <html>. El tamaño grande se aplica con esa
  //    clase (ver GLOBAL_STYLE), así NO depende del ancho de pantalla ni se
  //    rompe con el modo "Sitio para computadoras" del navegador.
  useEffect(() => {
    let meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "viewport");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", "width=device-width, initial-scale=1, viewport-fit=cover");

    const esTactil =
      (navigator.maxTouchPoints || 0) > 0 ||
      "ontouchstart" in window ||
      (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    // El tamaño grande aplica SOLO en pantallas chicas (celular), no en desktop
    // tactil. Usamos screen.width ademas de innerWidth para que un celular en
    // "modo escritorio" (que reporta innerWidth ancho) igual cuente como chico.
    const aplicarMobil = () => {
      const anchoChico = Math.min(
        window.innerWidth || 9999,
        (window.screen && window.screen.width) || 9999
      ) <= 860;
      document.documentElement.classList.toggle("is-mobile", esTactil && anchoChico);
    };
    aplicarMobil();
    window.addEventListener("resize", aplicarMobil);
    return () => window.removeEventListener("resize", aplicarMobil);
  }, []);

  // ── Cargar estado de Firestore al iniciar — ahora se hace en App ─────────

  // ── Auto-guardar cuando el store cambia (debounce 2s) ────────────────────
  useEffect(() => {
    if (!userEmail) return;
    vacaStore.setState({ __userEmail: userEmail });
    let timer;
    const unsub = vacaStore.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          await guardarEstado(userEmail);
          const ahora = new Date();
          setUltimoGuardado(`${ahora.getHours()}:${String(ahora.getMinutes()).padStart(2,"0")}`);
        } catch(e) {
          console.warn("Auto-save falló:", e.message);
        }
      }, 2000);
    });
    return () => { unsub(); clearTimeout(timer); };
  }, [userEmail]);

  // ── Guardar estado en Firestore ───────────────────────────────────────────
  const handleGuardar = async () => {
    setGuardando(true);
    try {
      console.log("🔵 Guardando para:", userEmail, "| auth:", auth.currentUser?.email);
      await guardarEstado(userEmail);
      const ahora = new Date();
      setUltimoGuardado(`${ahora.getHours()}:${String(ahora.getMinutes()).padStart(2,"0")}`);
      pushToast("✅ Datos guardados en la nube", "success");
      console.log("✅ Guardado OK");
    } catch (err) {
      console.error("❌ Error guardando:", err.code, err.message);
      pushToast(`❌ Error: ${err.code || err.message}`, "warn");
    } finally {
      setGuardando(false);
    }
  };

  // ── Año ganadero ──────────────────────────────────────────────────────────
  const anoGanaderoActual = useStore(vacaStore, s => s.anoGanaderoActual);
  const historialAnos     = useStore(vacaStore, s => s.historialAnos);

  // ── Stock compartido con Mi Campo — LEE DEL STORE GLOBAL ─────────────────
  const campoCria           = useStore(vacaStore, s => s.campoCria);
  const campoRecria         = useStore(vacaStore, s => s.campoRecria);
  const campoTerminacion    = useStore(vacaStore, s => s.campoTerminacion);
  const campoPastaje        = useStore(vacaStore, s => s.campoPastaje);
  const movimientos         = useStore(vacaStore, s => s.movimientos) ?? [];
  const setCampoCria        = (p) => vacaStore.getState().setCampoCria(p);
  const setCampoRecria      = (p) => vacaStore.getState().setCampoRecria(p);
  const setCampoTerminacion = (p) => vacaStore.getState().setCampoTerminacion(p);
  const setCampoPastaje     = (p) => vacaStore.getState().setCampoPastaje(p);
  const setMovimientos      = (fn) => vacaStore.getState().setMovimientos(fn);

  // ── Agregar al campo desde simulador — usa el store ─────────────────────
  const handleAgregarAlCampo = (datos) => {
    vacaStore.getState().agregarAlCampo(datos);
    const labels = {
      "terneros-compra-machos":  "terneros machos compra → Recría",
      "terneros-compra-hembras": "terneras compra → Recría",
      "vacas":                   "vacas → Cría",
      "vaquillonas":             "vaquillonas → Cría",
      "novillos-campo":          "novillos → Terminación campo",
      "novillos-feedlot":        "novillos → Terminación feedlot",
    };
    pushToast(`✅ ${datos.cantidad} ${labels[datos.categoria] || datos.categoria}`, "success");
  };

  // ── Cerrar año ganadero ───────────────────────────────────────────────────
  const handleCerrarAno = () => {
    // PILAR 2: usa la action del store que hace el envejecimiento biológico real
    const snap = vacaStore.getState().cerrarAnoGanadero();
    const r = snap.resumen;
    pushToast(
      `✅ Año ${snap.ano} cerrado → ${r.totalDest} terneros · ${r.vacasDescarte} vacas descarte · ${r.hembrasRepos} vaquillonas reposición`,
      "success"
    );
  };

  const CATEGORIAS = {
    poder:         { label: "Poder de Compra",     emoji: "⇄" },
    vientres:      { label: "Proyecto Vientres",   emoji: "🐄" },
    invernada:     { label: "Comparador Invernada", emoji: "⚖️" },
    "recria-compra": { label: "Compra de Recría",  emoji: "🐂" },
  };

  const agregarSimulacion = (sim) => {
    const cat = CATEGORIAS[sim.tab] || { label: sim.tab, emoji: "📋" };
    setSimulaciones((prev) => [{
      ...sim,
      id: Date.now(),
      fecha: new Date().toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }),
      categoriaLabel: cat.label,
      categoriaEmoji: cat.emoji,
    }, ...prev]);
  };
  const borrarSimulacion = (id) => { setSimulaciones((prev) => prev.filter((s) => s.id !== id)); pushToast("Simulación eliminada", "warn"); };
  const borrarTodas = () => { setSimulaciones([]); pushToast("Historial borrado", "warn"); };

  // Cotizaciones — del store global, sincronizadas con todos los simuladores
  const global    = useStore(vacaStore, s => s.global);
  const setGlobal = (p) => vacaStore.getState().setGlobal(p);

  const gastos    = useStore(vacaStore, s => s.gastos);
  const setGastos = (p) => vacaStore.getState().setGastos(p);

  // Navigate from dashboard
  const handleNavigate = (tabId) => {
    if (tabId === "campo") {
      setVistaActual("campo");
    } else if (tabId === "recria-compra") {
      setActiveTab("recria-compra");
      setVistaActual("simuladores");
    } else if (tabId === "simulador-menu") {
      setVistaActual("simulador-menu");
    } else {
      setActiveTab(tabId);
      setVistaActual("simuladores");
    }
  };

  // Sync from Mi Campo to specific simulator
  const handleSincronizar = (datos) => {
    // Special action: pasar terneros destetados a recría
    if (datos._accion === "pasar-destete-recria") {
      // Machos → recría para venta
      // Hembras venta → recría para venta (ternerosLiquidaHembras)
      // Hembras reposición → cría como futuras vaquillonas
      setCampoRecria(p => ({
        ...p,
        ternerosLiquidaMachos: p.ternerosLiquidaMachos + datos.machos,
        ternerosLiquidaHembras: p.ternerosLiquidaHembras + (datos.hembrasVenta || 0),
      }));
      if (datos.hembrasReposicion > 0) {
        setCampoCria(p => ({ ...p, vaquillonas: p.vaquillonas + datos.hembrasReposicion }));
      }
      setCampoCria(p => ({ ...p, ternerosNoDestetados: 0 }));
      const total = datos.machos + (datos.hembrasVenta||0) + (datos.hembrasReposicion||0);
      pushToast(`✅ ${total} terneros destetados — ${datos.machos}M · ${datos.hembrasVenta||0}H venta · ${datos.hembrasReposicion||0}H reposición`, "success");
      return;
    }
    if (datos._accion === "deshacer-destete") {
      setCampoRecria(p => ({
        ...p,
        ternerosLiquidaMachos: Math.max(0, p.ternerosLiquidaMachos - datos.machos),
        ternerosLiquidaHembras: Math.max(0, p.ternerosLiquidaHembras - datos.hembras),
      }));
      pushToast(`↩ Destete deshecho — terneros removidos de Recría`, "warn");
      return;
    }
    setSyncData(datos);
    // Route directly to the target simulator
    if (datos.target === "poder") {
      setActiveTab("poder");
      setVistaActual("simuladores");
      pushToast("Cargando Poder de Compra con tus novillos ✓", "success");
    } else if (datos.target === "vientres") {
      setActiveTab("vientres");
      setVistaActual("simuladores");
      pushToast("Cargando Proyecto Vientres con tu rodeo ✓", "success");
    } else if (datos.target === "invernada") {
      setActiveTab("invernada");
      setVistaActual("simuladores");
      pushToast("Cargando Comparador con tus novillos ✓", "success");
    } else {
      setVistaActual("simulador-menu");
      pushToast("Datos sincronizados al simulador ✓", "success");
    }
  };

  const handleDescarte = (data) => {
    setDescarteData(data);
    setActiveTab("invernada");
  };

  // ── Render dashboard ─────────────────────────────────────────────────────
  if (vistaActual === "inicio") {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: GLOBAL_STYLE }} />
        <ToastContainer toasts={toasts} />
        <Dashboard
          userEmail={userEmail}
          global={global}
          gastos={gastos}
          simulaciones={simulaciones}
          onNavigate={handleNavigate}
          onLogout={onLogout}
        />
      </>
    );
  }

  // ── Render Mi Campo ───────────────────────────────────────────────────────
  if (vistaActual === "campo") {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: GLOBAL_STYLE }} />
        <ToastContainer toasts={toasts} />
        <MiCampo
          onVolver={() => setVistaActual("inicio")}
          onSincronizar={handleSincronizar}
          cria={campoCria} setCria={setCampoCria}
          recria={campoRecria} setRecria={setCampoRecria}
          terminacion={campoTerminacion} setTerminacion={setCampoTerminacion}
          anoGanadero={anoGanaderoActual}
          historialAnos={historialAnos}
          onCerrarAno={handleCerrarAno}
          campoPastaje={campoPastaje}
          setCampoPastaje={setCampoPastaje}
          precioNovilloGlobal={global.precioNovilloInmag}
          movimientos={movimientos}
          setMovimientos={setMovimientos}
          onToast={pushToast}
        />
      </>
    );
  }

  // ── Render Simulador Menu ─────────────────────────────────────────────────
  if (vistaActual === "simulador-menu") {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: GLOBAL_STYLE }} />
        <ToastContainer toasts={toasts} />
        <SimuladorMenu
          onVolver={() => setVistaActual("inicio")}
          onNavigate={(tabId) => { setActiveTab(tabId); setVistaActual("simuladores"); }}
          simulaciones={simulaciones}
          syncData={syncData}
        />
      </>
    );
  }

  // ── Render simulators ────────────────────────────────────────────────────
  const tabInfo = {
    poder:     { label: "Poder de Compra",   icon: "⇄",  color: "from-sky-500 to-cyan-500",     badge: "bg-sky-500" },
    vientres:  { label: "Proyecto Vientres", icon: "🐄", color: "from-violet-500 to-purple-600", badge: "bg-violet-500" },
    invernada: { label: "Comp. Invernada",   icon: "⚖️", color: "from-emerald-500 to-teal-500",  badge: "bg-emerald-600" },
    chacra:    { label: "Chacra Alimento",  icon: "🌽", color: "from-lime-500 to-green-600",   badge: "bg-lime-600" },
  };
  const current = tabInfo[activeTab] || tabInfo.poder;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_STYLE }} />
      <ToastContainer toasts={toasts} />

      <div className="app-bg text-slate-800 font-sans antialiased min-h-screen">

        {/* ── Sticky top nav ───────────────────────────────────────────── */}
        <nav className="sticky top-0 z-50 bg-white border-b-2 border-slate-100 shadow-md simulator-enter">
          {/* Colored accent strip */}
          <div className={`h-1 w-full bg-gradient-to-r ${current.color}`} />

          <div className="max-w-[1100px] mx-auto px-3 sm:px-6 lg:px-8 py-2.5 flex items-center justify-between gap-3">

            {/* Back button → vuelve al menú de simuladores */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setVistaActual("simulador-menu")}
                className="flex items-center gap-2.5 bg-gradient-to-r from-slate-800 to-slate-700 hover:from-slate-700 hover:to-slate-600 text-white font-black text-xs sm:text-sm px-4 py-2.5 rounded-2xl shadow-md hover:shadow-lg transition-all active:scale-95 group"
                style={{transition:"all 0.2s cubic-bezier(0.34,1.56,0.64,1)"}}
              >
                <ArrowLeft size={18} className="transition-transform group-hover:-translate-x-1" />
                <span>Simuladores</span>
              </button>
              <button
                onClick={() => setVistaActual("campo")}
                className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs px-3 py-2.5 rounded-2xl shadow-md transition-all active:scale-95"
                title="Ir a Mi Campo"
              >
                <span>🐄</span>
                <span className="hidden sm:inline">Mi Campo</span>
              </button>
            </div>

            {/* Logo + module badge — center */}
            <div className="flex items-center gap-2.5 flex-1 justify-center min-w-0">
              <img
                src={`data:image/png;base64,${LOGO_B64}`}
                alt="SoyPekun"
                className="h-11 sm:h-14 object-contain shrink-0"
                style={{ maxWidth: "160px" }}
              />
              <div className={`${current.badge} text-white font-black text-xs px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-sm shrink-0`}>
                <span>{current.icon}</span>
                <span className="hidden sm:inline">{current.label}</span>
              </div>
            </div>

            {/* Guardar + simulaciones badge — right */}
            <div className="shrink-0 flex items-center gap-2">
              {simulaciones.length > 0 && (
                <span className="text-xs font-bold bg-emerald-100 text-emerald-700 border-2 border-emerald-200 px-3 py-1.5 rounded-full badge-pulse hidden sm:inline-flex items-center gap-1">
                  {simulaciones.length} 💾
                </span>
              )}
              <button
                onClick={handleGuardar}
                disabled={guardando}
                title={ultimoGuardado ? `Último guardado: ${ultimoGuardado}` : "Guardar en la nube"}
                className={`flex items-center gap-1.5 text-xs font-black px-3 py-2 rounded-xl border-2 transition-all active:scale-95
                  ${guardando
                    ? "bg-slate-100 border-slate-200 text-slate-400 cursor-wait"
                    : "bg-emerald-50 border-emerald-300 text-emerald-700 hover:bg-emerald-100 hover:border-emerald-400 shadow-sm"
                  }`}
              >
                {guardando ? (
                  <><span className="animate-spin">⟳</span><span className="hidden sm:inline">Guardando…</span></>
                ) : (
                  <><span>☁</span><span className="hidden sm:inline">{ultimoGuardado ? ultimoGuardado : "Guardar"}</span></>
                )}
              </button>
            </div>
          </div>
        </nav>

        <div className="w-full max-w-[1100px] mx-auto px-2 sm:px-6 lg:px-8 py-4 md:py-6">

          {/* Global panel */}
          <GlobalPanel />

          {/* Simulator content — no tabs */}
          {syncData && (
            <div className="mb-4 rounded-2xl border-2 border-emerald-200 bg-gradient-to-r from-emerald-50 to-teal-50 px-4 py-3 flex items-center gap-3 simulator-enter">
              <div className="w-7 h-7 rounded-xl bg-emerald-500 flex items-center justify-center text-white shrink-0">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
              </div>
              <div className="flex-1">
                <p className="text-xs font-black uppercase tracking-widest text-emerald-700">Datos cargados desde Mi Campo</p>
                <p className="text-xs text-emerald-600 mt-0.5">{syncData.descripcion}</p>
              </div>
              <button onClick={() => setSyncData(null)} className="text-xs text-emerald-500 hover:text-red-500 font-bold transition-colors">✕ Limpiar</button>
            </div>
          )}
          <div key={activeTab + (syncData ? "-sync" : "")} className="bg-white border-2 border-slate-100 rounded-3xl p-3 sm:p-5 md:p-8 shadow-xl sim-zoom-enter">
            {activeTab === "poder"
              ? <PoderDeCompra onGuardar={agregarSimulacion} onToast={pushToast}
                  initialVenta={syncData?.target === "poder" ? syncData.venta : undefined}
                  onAgregarAlCampo={handleAgregarAlCampo} />
              : activeTab === "vientres"
              ? <ProyectoVientres onDescarte={handleDescarte} onGuardar={agregarSimulacion} onToast={pushToast}
                  initialInputs={syncData?.target === "vientres" ? syncData.inputs : undefined}
                  onAgregarAlCampo={handleAgregarAlCampo} />
              : activeTab === "recria-compra"
              ? <CompraRecria onGuardar={agregarSimulacion} onToast={pushToast}
                  onAgregarAlCampo={handleAgregarAlCampo} />
              : activeTab === "chacra"
              ? <ChacraAlimento onGuardar={agregarSimulacion} onToast={pushToast}
                  onAgregarAlCampo={handleAgregarAlCampo} />
              : <ComparadorInvernada descarteData={descarteData} onGuardar={agregarSimulacion} onToast={pushToast}
                  initialBase={syncData?.target === "invernada" ? syncData.base : undefined}
                  onAgregarAlCampo={handleAgregarAlCampo} />
            }
          </div>

          {/* Historial de simulaciones */}
          <SimulacionesPanel simulaciones={simulaciones} onBorrar={borrarSimulacion} onBorrarTodas={borrarTodas} />

          <p className="text-center text-xs text-slate-400 mt-8 pb-4">
            Los cálculos son estimativos · Consultá con tu asesor antes de tomar decisiones de inversión.
          </p>
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// APP — Wrapper con autenticación Firebase
// ═══════════════════════════════════════════════════════════════════════════
export default function App() {
  const [user,         setUser]         = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [datosListos,  setDatosListos]  = useState(false);
  const [cargaError,   setCargaError]   = useState(false);
  const [isOnline,     setIsOnline]     = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [syncPending,  setSyncPending]  = useState(() => loadQueue().length > 0);
  const [syncing,      setSyncing]      = useState(false);

  // ── Detectar cambios de conexión ─────────────────────────────────────────
  useEffect(() => {
    const goOnline = async () => {
      setIsOnline(true);
      if (loadQueue().length > 0) {
        setSyncing(true);
        await flushQueue();
        setSyncPending(loadQueue().length > 0);
        setSyncing(false);
      }
    };
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online",  goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online",  goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // ── Escuchar cambios de auth ──────────────────────────────────────────────
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        // Cargar datos de Firestore antes de mostrar la app
        setCargaError(false);
        let ok = false;
        try {
          ok = await cargarEstado(u.email);
        } catch(e) {
          console.warn("No se pudo cargar de Firestore:", e.message);
        }
        if (ok) {
          // Carga exitosa (o usuario nuevo) → recién acá habilitamos la app y el autosave.
          setDatosListos(true);
        } else {
          // Carga fallida: NO entramos a la app con el estado en cero.
          // Junto al guard de guardarEstado, esto evita pisar los datos reales.
          setCargaError(true);
        }
      } else {
        setDatosListos(false);
        setCargaError(false);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  const handleLogout = () => signOut(auth);

  // ── Error de carga ──────────────────────────────────────────────────────────
  // La carga de Firestore falló (sin conexión estable y sin copia local propia).
  // Mostramos error con reintento en vez de entrar con el campo en cero, para que
  // el usuario no crea que perdió sus datos ni los pise con un guardado.
  if (user && cargaError) {
    return (
      <div style={{
        minHeight:"100vh", background:"linear-gradient(160deg,#F4EEE1 0%,#EAE1D0 55%,#E3D2B0 100%)",
        display:"flex", alignItems:"center", justifyContent:"center",
        flexDirection:"column", gap:"16px", padding:"24px", textAlign:"center",
      }}>
        <p style={{color:"#2E2A20", fontSize:"18px", fontWeight:800, maxWidth:"320px"}}>
          No pudimos cargar tus datos
        </p>
        <p style={{color:"#6E6450", fontSize:"14px", maxWidth:"320px"}}>
          Tu información está a salvo en la nube. Revisá tu conexión y reintentá — no se guardó nada en cero.
        </p>
        <button onClick={() => window.location.reload()} style={{
          padding:"12px 24px", borderRadius:"10px", border:"none",
          background:"#2F7D4F", color:"#fff", fontSize:"15px", fontWeight:"bold", cursor:"pointer",
        }}>
          Reintentar
        </button>
        <button onClick={() => signOut(auth)} style={{
          border:"none", background:"none", color:"#6E6450",
          fontSize:"13px", textDecoration:"underline", cursor:"pointer",
        }}>
          Cerrar sesión
        </button>
      </div>
    );
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading || (user && !datosListos)) {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: `
          @keyframes appSpin { to { transform: rotate(360deg); } }
          .app-spinner { animation: appSpin 0.8s linear infinite; }
        ` }} />
        <div style={{
          minHeight:"100vh", background:"linear-gradient(160deg,#F4EEE1 0%,#EAE1D0 55%,#E3D2B0 100%)",
          display:"flex", alignItems:"center", justifyContent:"center",
          flexDirection:"column", gap:"16px",
        }}>
          <img src={`data:image/png;base64,${LOGO_B64}`} alt="SoyPekun"
            style={{ height:"120px", objectFit:"contain" }} />
          <div className="app-spinner" style={{
            width:"32px", height:"32px",
            border:"3px solid rgba(47,125,79,0.22)",
            borderTopColor:"#2F7D4F", borderRadius:"50%",
          }} />
          <p style={{color:"#7C6F58", fontSize:"13px"}}>Cargando datos...</p>
        </div>
      </>
    );
  }

  // ── No autenticado → Login ────────────────────────────────────────────────
  if (!user) {
    return <LoginScreen />;
  }

  // ── Autenticado → App principal ───────────────────────────────────────────
  return (
    <>
      {/* ── Banner de estado de conexión ───────────────────────── */}
      {(!isOnline || syncPending || syncing) && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999,
          padding: "10px 16px",
          background: syncing ? "#1e40af" : syncPending ? "#d97706" : "#374151",
          color: "#fff", fontSize: "13px", fontWeight: "700",
          display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
          boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
          textAlign: "center",
        }}>
          {syncing ? (
            <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>🔄</span> Sincronizando datos con el servidor...</>
          ) : syncPending ? (
            <><span>📤</span> Tenés cambios pendientes — se subirán cuando haya internet</>
          ) : (
            <><span>📴</span> Sin conexión — trabajás en modo offline. Los cambios se guardan localmente.</>
          )}
        </div>
      )}
      <div style={{ paddingTop: (!isOnline || syncPending || syncing) ? "36px" : "0" }}>
        <EstrategiaComercial
          userEmail={user.email}
          onLogout={handleLogout}
          isOnline={isOnline}
          syncPending={syncPending}
        />
      </div>
    </>
  );
}
