import { useState, useMemo, useEffect, useRef } from "react";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, LineChart, Line } from "recharts";

function useWindowWidth() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 430);
  useEffect(() => {
    const fn = () => setW(window.innerWidth);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);
  return w;
}

const LOGO_SRC = null;


// --- PALETA -------------------------------------------------------------------
const C = {
  bg:      "#f0ece0",
  card:    "#faf8f3",
  cardAlt: "#f0ece0",
  border:  "#ddd8cc",
  t1:      "#1a1208",
  t2:      "#4a3f30",
  t3:      "#8a7a68",
  green:   "#16a34a", greenL:  "#dcfce7",
  blue:    "#2563eb", blueL:   "#dbeafe",
  amber:   "#d97706", amberL:  "#fef3c7",
  purple:  "#7c3aed", purpleL: "#ede9fe",
  teal:    "#0d9488", tealL:   "#ccfbf1",
  red:     "#dc2626", redL:    "#fee2e2",
  orange:  "#ea580c", orangeL: "#ffedd5",
};

const PROVINCES = [
  "Buenos Aires","Catamarca","Chaco","Chubut","Córdoba","Corrientes",
  "Entre Ríos","Formosa","Jujuy","La Pampa","La Rioja","Mendoza","Misiones","Neuquén","Río Negro","Salta","San Juan","San Luis","Santa Cruz","Santa Fe","Santiago del Estero","Tierra del Fuego","Tucumán","CABA"];
const RAZAS = ["Brangus","Wagyu","Angus","Hereford","Braford","Cruza"];

const fmt  = n => { const a = Math.abs(n); const s = a >= 1e6 ? `${(a/1e6).toFixed(2)}M` : a >= 1e3 ? `${(a/1e3).toFixed(0)}K` : `${Math.round(a).toLocaleString("es-AR")}`; return (n<0?"-$":"$")+s; };
const fmtN = n => Math.round(n).toLocaleString("es-AR");
const fmtKg = n => `${Math.round(n).toLocaleString("es-AR")} kg`;

// --- MOTORES DE CÁLCULO -------------------------------------------------------

function calcGastos(g) {
  const bruto = g.sueldo_encargado + g.sueldo_peon1 + g.sueldo_peon2;
  const cargas = bruto * (g.cargas_sociales / 100);
  const neto_mensual = bruto + cargas;
  const aguinaldo = neto_mensual * 2;          // SAC: 2 medios aguinaldos = 1 sueldo extra (jun + dic)
  const premios = (g.premios_anio || 0);
  const sueldos_anio = neto_mensual * 12 + aguinaldo + premios;
  const rolado_anio = g.hectareas_rolado * g.costo_rolado_ha;
  const mant_anio = (g.mant_infra + g.mant_equipos + g.mant_alambrados) * 12;
  const km_viaje = g.km_ida * 2;
  const litros = km_viaje * g.consumo_l100km / 100;
  const viajes_anio = g.viajes_mes * 12;
  const viajes_anio_dol = (litros * g.precio_gasoil + g.otros_viaje) * viajes_anio;
  const total = sueldos_anio + rolado_anio + mant_anio + viajes_anio_dol;
  return { sueldos_anio, rolado_anio, mant_anio, viajes_anio_dol, total,
           bruto, cargas, viajes_anio, aguinaldo, premios, neto_mensual };
}

function calcPastaje(p, inmag) {
  const im = inmag || 4574;
  const ing_vacas    = p.vacas_tercero    * p.kg_vaca    * im * (p.meses_vaca    || 12);
  const ing_novillos = p.novillos_tercero * p.kg_novillo * im * (p.meses_novillo || 12);
  const ing_terneros = p.terneros_tercero * p.kg_ternero * im * (p.meses_ternero || 12);
  const ing_toros    = p.toros_tercero    * p.kg_toro    * im * (p.meses_toro    || 12);
  const total = ing_vacas + ing_novillos + ing_terneros + ing_toros;
  const animales = p.vacas_tercero + p.novillos_tercero + p.terneros_tercero + p.toros_tercero;
  return { ing_vacas, ing_novillos, ing_terneros, ing_toros, total, animales };
}

function calcRecria(rc, inmag) {
  const im = inmag || 4574;
  const ingreso_bruto = rc.peso_salida * rc.precio_venta_invernada;
  const comerc_v = ingreso_bruto * (rc.comerc_venta / 100);
  const ingreso_neto = ingreso_bruto - comerc_v - rc.flete_venta;
  const compra_kg = rc.peso_entrada * rc.precio_compra;
  const comerc_c = compra_kg * (rc.comerc_compra / 100);
  const costo_compra = compra_kg + comerc_c + rc.flete_compra;
  const pastaje = rc.kg_pastaje * im * rc.meses;
  const nutriliq = rc.nutriliq_kg * rc.nutriliq_precio * rc.meses * 30;
  const sanidad = rc.sanidad;
  const costo_ten = pastaje + nutriliq + sanidad;
  const costo_total = costo_compra + costo_ten;
  const margen_cab = ingreso_neto - costo_total;
  const gdp = rc.meses > 0 ? (rc.peso_salida - rc.peso_entrada) / (rc.meses * 30) : 0;
  const roi = costo_total > 0 ? margen_cab / costo_total * 100 : 0;
  return { ingreso_bruto, comerc_v, ingreso_neto, compra_kg, comerc_c, costo_compra,
           pastaje, nutriliq, sanidad, costo_ten, costo_total, margen_cab, gdp, roi };
}

function calcFeedlot(fl, inmag) {
  const im = inmag || 4574;
  // Ración: kg MS/día x precio x días
  const dias = fl.dias_feedlot;
  const costo_racion_cab = fl.kg_racion_dia * fl.precio_racion_kg * dias;
  const pastaje = fl.kg_pastaje_fl * im * (dias / 30);
  const sanidad_fl = fl.sanidad_fl;
  const flete_fl = fl.flete_entrada_fl + fl.flete_salida_fl;
  const comerc_v = fl.peso_salida_fl * fl.precio_faena * (fl.comerc_venta_fl / 100);
  const ingreso_bruto = fl.peso_salida_fl * fl.precio_faena;
  const ingreso_neto = ingreso_bruto - comerc_v - fl.flete_salida_fl;
  const costo_entrada = fl.peso_entrada_fl * fl.precio_entrada_fl;
  const comerc_c = costo_entrada * (fl.comerc_compra_fl / 100);
  const costo_total = costo_entrada + comerc_c + fl.flete_entrada_fl + costo_racion_cab + pastaje + sanidad_fl;
  const margen_cab = ingreso_neto - costo_total;
  const gdp_fl = dias > 0 ? (fl.peso_salida_fl - fl.peso_entrada_fl) / dias : 0;
  const roi = costo_total > 0 ? margen_cab / costo_total * 100 : 0;
  const kg_ganados = fl.peso_salida_fl - fl.peso_entrada_fl;
  const costo_tenencia = costo_racion_cab + pastaje + sanidad_fl + fl.flete_entrada_fl + fl.flete_salida_fl + comerc_c + comerc_v;
  const costo_kg_prod = kg_ganados > 0 ? costo_tenencia / kg_ganados : 0;
  // precio de venta mínimo para break-even
  const precio_be = fl.peso_salida_fl > 0 ? (costo_total + fl.comerc_v/100*fl.peso_salida_fl*fl.precio_faena) / (fl.peso_salida_fl * (1 - fl.comerc_venta_fl/100)) : 0;
  // diferencial precio: si el animal vale más al entrar que al salir, hay pérdida estructural
  const dif_precio = fl.precio_faena - fl.precio_entrada_fl;
  return { ingreso_bruto, comerc_v, ingreso_neto, costo_entrada, comerc_c, costo_racion_cab,
           pastaje, sanidad_fl, flete_fl, costo_total, margen_cab, gdp_fl, roi, dias,
           kg_ganados, costo_kg_prod, precio_be, dif_precio, costo_tenencia };
}

function calcRechazo(r, inmag) {
  const im = inmag || 4574;
  if (!r || r.cabezas === 0) return { ingreso_invernada: 0, ingreso_feedlot: 0, ingreso_final: 0, margen_invernada_cab: 0, margen_feedlot_cab: 0, costo_feedlot_cab: 0 };
  // Opción A: vender directo como invernada
  const bruto_inv = r.cabezas * r.peso_vivo * r.precio_invernada;
  const comerc_inv = bruto_inv * (r.comerc_venta / 100);
  const ingreso_invernada = bruto_inv - comerc_inv - r.cabezas * r.flete_venta;
  const margen_invernada_cab = ingreso_invernada / r.cabezas;
  // Opción B: feedlot y faena
  const racion_cab = r.kg_racion_dia * r.precio_racion_kg * r.dias_feedlot;
  const pastaje_cab = r.kg_pastaje_fl * im * (r.dias_feedlot / 30);
  const peso_salida = r.peso_vivo + r.gdp_feedlot * r.dias_feedlot;
  const bruto_faena = r.cabezas * peso_salida * r.precio_faena;
  const comerc_faena = bruto_faena * (r.comerc_venta / 100);
  const ingreso_feedlot = bruto_faena - comerc_faena - r.cabezas * r.flete_faena;
  const costo_feedlot_total = r.cabezas * (racion_cab + pastaje_cab + r.sanidad_fl);
  const margen_feedlot_cab = (ingreso_feedlot - costo_feedlot_total) / r.cabezas;
  const ingreso_final = r.destino === "feedlot" ? ingreso_feedlot - costo_feedlot_total : ingreso_invernada;
  return { ingreso_invernada, ingreso_feedlot, ingreso_final,
           margen_invernada_cab, margen_feedlot_cab, costo_feedlot_total,
           peso_salida, racion_cab, pastaje_cab, bruto_faena, bruto_inv };
}

function calcCria(s, gastos_anio, recria_margen_anio, feedlot_margen_anio, pastaje_ingreso_anio, repos_ext, rechazo_ingreso_anio) {
  const ias_vaca = 1 + (1 - s.preniez1);
  const costo_ia_vaca = ias_vaca * s.kg_ia * s.inmag;
  const arrend_vaca = 12 * s.kg_pastaje * s.inmag;
  const costo_vaca_anual = costo_ia_vaca + arrend_vaca;
  const arrend_tern = s.meses_recria_tern * s.kg_pastaje * s.inmag;
  const nutriliq_tern = s.meses_recria_tern * 30 * s.nutriliq_kg * s.nutriliq_precio;
  const ia_tern = ias_vaca * s.kg_ia * s.inmag;
  const costo_recria_ternera = arrend_tern + nutriliq_tern + ia_tern;
  const inv_inicial = s.terneras_compradas * s.peso_entrada_mac * s.precio_compra_tern + s.terneras_compradas * costo_recria_ternera;
  const ingreso_nov_act = s.peso_total_novillos * s.precio_venta_novillos_act;
  const anios = [];
  let acum = 0;
  for (let y = 1; y <= 10; y++) {
    const vacas = y === 1 ? s.vacas_actuales : Math.min(anios[y-2].rodeo_total, s.meta);
    const dest = Math.round(vacas * s.destete);
    const machos = Math.round(dest * s.paridad);
    const hem = dest - machos;
    const ret = Math.min(hem, Math.max(s.meta - vacas, Math.round(vacas * s.repos)));
    const vend = Math.max(hem - ret, 0);
    const rodeo_total = Math.min(vacas + ret, s.meta);
    const ing_exc = vend * s.precio_ternera_exc * s.peso_ternera_exc;
    const ingresos = ing_exc + recria_margen_anio + feedlot_margen_anio + (pastaje_ingreso_anio||0) + (rechazo_ingreso_anio||0);
    const costo_repos_ext = repos_ext ? (repos_ext.terneras * repos_ext.costo_ternera_tot + repos_ext.toros * repos_ext.costo_toro) : 0;
    const costos = vacas * costo_vaca_anual + ret * costo_recria_ternera + gastos_anio + (y===1?costo_repos_ext:costo_repos_ext);
    const inv = y === 1 ? Math.max(inv_inicial - ingreso_nov_act, 0) : 0;
    const flujo_neto = ingresos - costos - inv;
    acum += flujo_neto;
    anios.push({ y, vacas, machos, retenidas: ret, vendidas_exc: vend, rodeo_total, ingresos, costos, flujo_neto, acumulado: acum });
  }
  return { anios, costo_vaca_anual, costo_recria_ternera };
}

// --- UTILIDADES UI ------------------------------------------------------------
function AnimNum({ value, format = fmt }) {
  const [disp, setDisp] = useState(value);
  const prev = useRef(value);
  useEffect(() => {
    const start = prev.current, end = value, dur = 350, s0 = performance.now();
    const tick = now => {
      const t = Math.min((now - s0) / dur, 1);
      const e = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
      setDisp(start + (end - start) * e);
      if (t < 1) requestAnimationFrame(tick);
      else { setDisp(end); prev.current = end; }
    };
    requestAnimationFrame(tick);
  }, [value]);
  return <>{format(disp)}</>;
}

const Tip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:10,
      padding:"10px 14px", fontSize:11, fontFamily:"'DM Mono',monospace",
      boxShadow:"0 4px 20px rgba(0,0,0,0.12)" }}>
      <div style={{ color:C.t3, marginBottom:6, fontSize:10 }}>AÑO {label}</div>
      {payload.map((p,i) => (
        <div key={i} style={{ color:p.color, marginBottom:2 }}>{p.name}: <b>{Math.abs(p.value) > 999 ? fmt(p.value) : p.value}</b></div>
      ))}
    </div>
  );
};

function KPI({ icon, label, value, animValue, sub, color, bg, border, animFmt }) {
  return (
    <div style={{ background: bg||C.card, borderRadius:16, padding:"14px 14px 12px",
      flex:1, minWidth:0, border:`1.5px solid ${border||C.border}`,
      boxShadow:"0 1px 4px rgba(0,0,0,0.06)" }}>
      <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:6 }}>
        <span style={{ fontSize:16 }}>{icon}</span>
        <span style={{ fontSize:10, color:C.t3, textTransform:"uppercase", letterSpacing:0.8, fontWeight:600 }}>{label}</span>
      </div>
      <div style={{ fontSize:20, fontWeight:800, color:color||C.t1, fontFamily:"'DM Mono',monospace", lineHeight:1 }}>
        {animValue !== undefined ? <AnimNum value={animValue} format={animFmt||fmt} /> : value}
      </div>
      {sub && <div style={{ fontSize:10, color:C.t3, marginTop:4 }}>{sub}</div>}
    </div>
  );
}

function Row({ label, val, color, sub, bold }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
      padding:"8px 0", borderBottom:`1px solid ${C.border}` }}>
      <div>
        <div style={{ fontSize:12, color: bold?C.t1:C.t2, fontWeight: bold?700:400 }}>{label}</div>
        {sub && <div style={{ fontSize:10, color:C.t3, marginTop:1 }}>{sub}</div>}
      </div>
      <span style={{ fontSize:13, fontFamily:"'DM Mono',monospace", color:color||C.t1, fontWeight:bold?700:500 }}>{val}</span>
    </div>
  );
}

const SL_STYLES = `
  @keyframes pencilWiggle {
    0%   { transform: rotate(0deg) scale(1); }
    20%  { transform: rotate(-12deg) scale(1.15); }
    40%  { transform: rotate(10deg) scale(1.1); }
    60%  { transform: rotate(-8deg) scale(1.12); }
    80%  { transform: rotate(5deg) scale(1.05); }
    100% { transform: rotate(0deg) scale(1); }
  }
  @keyframes popIn {
    0%   { opacity:0; transform: scale(0.85) translateY(-4px); }
    60%  { transform: scale(1.04) translateY(1px); }
    100% { opacity:1; transform: scale(1) translateY(0); }
  }
  @keyframes thumbPop {
    0%   { transform: scale(1); }
    40%  { transform: scale(1.35); }
    100% { transform: scale(1); }
  }
  @keyframes slideGlow {
    0%,100% { box-shadow: 0 0 0 0 transparent; }
    50%      { box-shadow: 0 0 8px 2px #16a34a55; }
  }
  .sl-range {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 5px;
    border-radius: 999px;
    outline: none;
    cursor: pointer;
    transition: background 0.2s;
  }
  .sl-range::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #16a34a;
    cursor: pointer;
    border: 2.5px solid #fff;
    box-shadow: 0 2px 8px #16a34a55;
    transition: transform 0.15s cubic-bezier(.34,1.56,.64,1), box-shadow 0.15s;
  }
  .sl-range::-webkit-slider-thumb:active {
    transform: scale(1.4);
    box-shadow: 0 0 0 5px #16a34a30;
  }
  .sl-range::-moz-range-thumb {
    width: 20px; height: 20px;
    border-radius: 50%;
    background: #16a34a;
    cursor: pointer;
    border: 2.5px solid #fff;
    box-shadow: 0 2px 8px #16a34a55;
    transition: transform 0.15s cubic-bezier(.34,1.56,.64,1);
  }
  .sl-range::-moz-range-thumb:active { transform: scale(1.4); }
  .sl-pencil-btn:hover .sl-pencil-icon { animation: pencilWiggle 0.45s ease; }
  .sl-pencil-btn:active { transform: scale(0.95); }
`;

let _slStylesInjected = false;
function injectSlStyles() {
  if (_slStylesInjected) return;
  const el = document.createElement("style");
  el.textContent = SL_STYLES;
  document.head.appendChild(el);
  _slStylesInjected = true;
}

function PencilIcon({ size=14, color="#8a7a68" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className="sl-pencil-icon"
      style={{ display:"block", flexShrink:0 }}>
      <path d="M11.5 1.5 L14.5 4.5 L5 14 L1.5 14.5 L2 11 Z" fill={color} opacity="0.15"/>
      <path d="M11.5 1.5 L14.5 4.5 L5 14 L1.5 14.5 L2 11 Z"
        stroke={color} strokeWidth="1.4" strokeLinejoin="round" fill="none"/>
      <path d="M10 3 L13 6" stroke={color} strokeWidth="1.4" strokeLinecap="round"/>
      <path d="M2 11 L5 14" stroke={color} strokeWidth="1.2" strokeLinecap="round" opacity="0.5"/>
    </svg>
  );
}

function Sl({ label, value, onChange, min, max, step, prefix="$", suffix="" }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { injectSlStyles(); }, []);

  const isCab = suffix.trim() === "cab";
  const pct = max > min ? ((Math.min(value, max) - min) / (max - min)) * 100 : 0;
  const trackBg = `linear-gradient(to right, ${C.green} ${pct}%, #ddd8cc ${pct}%)`;

  const startEdit = () => {
    setRaw(String(value));
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 30);
  };
  const commit = () => {
    const n = parseFloat(raw.replace(/[^0-9.,-]/g,"").replace(",","."));
    if (!isNaN(n)) onChange(Math.min(Math.max(n, min), max*10));
    setEditing(false);
  };
  const onKey = e => { if (e.key==="Enter") commit(); if (e.key==="Escape") setEditing(false); };

  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
        <span style={{ fontSize:12, color:C.t2, flex:1, marginRight:8, lineHeight:1.3 }}>{label}</span>

        {editing ? (
          <div style={{ display:"flex", alignItems:"center", gap:5, animation:"popIn 0.2s ease both" }}>
            {prefix && <span style={{ fontSize:11, color:C.t3, fontFamily:"'DM Mono',monospace" }}>{prefix}</span>}
            <input ref={inputRef} value={raw}
              onChange={e => setRaw(e.target.value)}
              onBlur={commit} onKeyDown={onKey}
              style={{ width:88, padding:"4px 8px", borderRadius:8,
                border:`2px solid ${C.green}`,
                fontSize:13, fontFamily:"'DM Mono',monospace", fontWeight:700,
                background:"#fff", color:C.t1, outline:"none", textAlign:"right",
                boxShadow:`0 0 0 3px ${C.green}22` }} />
            {suffix && <span style={{ fontSize:11, color:C.t3, fontFamily:"'DM Mono',monospace" }}>{suffix}</span>}
            <button onClick={commit}
              style={{ background:`linear-gradient(135deg,${C.green},${C.teal})`,
                border:"none", borderRadius:7, color:"#fff",
                fontSize:11, padding:"4px 9px", cursor:"pointer", fontWeight:800,
                boxShadow:`0 2px 8px ${C.green}40`, letterSpacing:0.3 }}>✓</button>
          </div>
        ) : (
          <div style={{ display:"flex", alignItems:"center", gap:5 }}>
            {isCab && value > 0 && (
              <button onClick={() => onChange(0)}
                title="Poner en 0"
                style={{ background:C.redL, border:`1.5px solid ${C.red}40`,
                  borderRadius:7, padding:"3px 7px", cursor:"pointer",
                  fontSize:10, fontWeight:800, color:C.red, lineHeight:1,
                  transition:"all 0.15s" }}>
                ✕ 0
              </button>
            )}
            <button onClick={startEdit} className="sl-pencil-btn"
              style={{ background:C.card, border:`1.5px solid ${C.border}`, borderRadius:9,
                padding:"4px 10px 4px 8px", cursor:"pointer", fontSize:13,
                fontFamily:"'DM Mono',monospace", fontWeight:700, color:C.t1,
                display:"flex", alignItems:"center", gap:6,
                transition:"all 0.15s", boxShadow:"0 1px 3px rgba(0,0,0,0.07)" }}>
              <PencilIcon color={C.t3} size={13} />
              <span style={{ color: prefix?C.t3:C.t1, fontSize:11, marginRight:1 }}>{prefix}</span>
              <span>{Number(value).toLocaleString("es-AR")}</span>
              {suffix && <span style={{ color:C.t3, fontSize:11 }}>{suffix}</span>}
            </button>
          </div>
        )}
      </div>

      <div style={{ position:"relative" }}>
        <input type="range" className="sl-range"
          min={min} max={max} step={step} value={Math.min(value, max)}
          onChange={e => onChange(Number(e.target.value))}
          onMouseDown={() => setDragging(true)}
          onTouchStart={() => setDragging(true)}
          onMouseUp={() => setDragging(false)}
          onTouchEnd={() => setDragging(false)}
          style={{ background: trackBg,
            transition: dragging ? "none" : "background 0.2s" }} />
      </div>
    </div>
  );
}

function SecCard({ title, color, children }) {
  return (
    <div style={{ background:C.card, borderRadius:16, padding:"16px", marginBottom:12,
      border:`1.5px solid ${C.border}`, borderTop:`3px solid ${color}`,
      boxShadow:"0 1px 4px rgba(0,0,0,0.06)" }}>
      <div style={{ fontSize:13, fontWeight:700, color:C.t1, marginBottom:12 }}>{title}</div>
      {children}
    </div>
  );
}

function BtnFijar({ onFijar, guardado, resumen }) {
  return (
    <div style={{ position:"sticky", bottom:16, zIndex:10, marginTop:8, marginBottom:8 }}>
      <button onClick={onFijar}
        style={{ width:"100%", padding:"14px 20px",
          background:`linear-gradient(135deg,${C.green},${C.teal})`,
          border:"none", borderRadius:16, cursor:"pointer",
          boxShadow:`0 4px 20px ${C.green}50`,
          display:"flex", alignItems:"center", justifyContent:"center", gap:10 }}>
        <span style={{ fontSize:18 }}>{guardado ? "[OK]" : "📌"}</span>
        <div style={{ textAlign:"left" }}>
          <div style={{ fontSize:14, fontWeight:800, color:"#fff" }}>
            {guardado ? "¡Valores aplicados!" : "Fijar y aplicar al modelo"}
          </div>
          {resumen && <div style={{ fontSize:10, color:"rgba(255,255,255,0.75)", marginTop:1 }}>{resumen}</div>}
        </div>
      </button>
    </div>
  );
}

function BarraCostos({ items, total }) {
  return (
    <>
      <div style={{ display:"flex", height:10, borderRadius:5, overflow:"hidden", marginBottom:12 }}>
        {items.map((item, i) => (
          <div key={i} style={{ width:`${total>0?(item.valor/total*100).toFixed(1):0}%`, background:item.color, opacity:0.85 }} />
        ))}
      </div>
      {items.map((item, i) => (
        <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"5px 0" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ width:10, height:10, borderRadius:2, background:item.color, opacity:0.85 }} />
            <span style={{ fontSize:12, color:C.t2 }}>{item.label}</span>
          </div>
          <div style={{ display:"flex", gap:12 }}>
            <span style={{ fontSize:11, color:C.t3, fontFamily:"'DM Mono',monospace" }}>{total>0?(item.valor/total*100).toFixed(0):0}%</span>
            <span style={{ fontSize:12, color:C.t1, fontFamily:"'DM Mono',monospace", fontWeight:600 }}>{fmt(item.valor)}</span>
          </div>
        </div>
      ))}
    </>
  );
}

// --- PERFIL -------------------------------------------------------------------
function Perfil({ perfil, onChange, s, rc, fl, pt, rext, R }) {
  const anio0 = R?.anios?.[0];

  // Stock propio
  const vientres     = s?.vacas_actuales || 0;
  const novillosRec  = rc?.stock_cab || 0;       // stock actual en recría
  const novillosNuevo= rc?.cabezas_comprados || 0; // nuevo lote
  const ternerosMac  = anio0?.machos || 0;
  const ternasRep    = rext?.terneras || 0;
  const toros        = rext?.toros || 0;
  const totalPropio  = vientres + novillosRec + novillosNuevo + ternerosMac + ternasRep + toros;

  // Stock pastaje terceros
  const ptVacas    = pt?.vacas_tercero || 0;
  const ptNovillos = pt?.novillos_tercero || 0;
  const ptTerneros = pt?.terneros_tercero || 0;
  const ptToros    = pt?.toros_tercero || 0;
  const totalPastaje = ptVacas + ptNovillos + ptTerneros + ptToros;

  const totalCampo = totalPropio + totalPastaje;

  const pctPropio  = totalCampo > 0 ? (totalPropio  / totalCampo * 100) : 0;
  const pctPastaje = totalCampo > 0 ? (totalPastaje / totalCampo * 100) : 0;

  const categorias = [
    { label:"Vientres",        cab:vientres,     color:C.green  },
    { label:"Novillos stock",  cab:novillosRec,  color:C.amber  },
    { label:"Novillos lote",   cab:novillosNuevo,color:C.blue   },
    { label:"Terneros Mac.",   cab:ternerosMac,  color:C.teal   },
    { label:"Terneras Rep.",   cab:ternasRep,    color:C.purple },
    { label:"Toros",           cab:toros,        color:C.orange },
    { label:"Pastaje vacas",   cab:ptVacas,      color:"#86efac"},
    { label:"Pastaje novillos",cab:ptNovillos,   color:"#93c5fd"},
    { label:"Pastaje terneros",cab:ptTerneros,   color:"#fcd34d"},
    { label:"Pastaje toros",   cab:ptToros,      color:"#c4b5fd"},
  ].filter(c => c.cab > 0);

  return (
    <div style={{ padding:"0 0 16px" }}>
      {/* Hero establecimiento */}
      <div style={{ background:`linear-gradient(135deg,${C.green},${C.teal})`, borderRadius:20,
        padding:"24px 20px", marginBottom:14, position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", right:-10, top:-10, fontSize:80, opacity:0.1 }}>🏡</div>
        <div style={{ fontSize:11, color:"rgba(255,255,255,0.65)", textTransform:"uppercase", letterSpacing:2, marginBottom:6 }}>Establecimiento</div>
        <div style={{ fontSize:28, fontWeight:800, color:"#fff", marginBottom:2 }}>
          {perfil.nombre_campo || "El Retiro"}
        </div>
        {perfil.provincia && <div style={{ fontSize:13, color:"rgba(255,255,255,0.75)" }}>{perfil.provincia}</div>}
        <div style={{ display:"flex", gap:10, marginTop:12 }}>
          <div style={{ background:"rgba(0,0,0,0.2)", borderRadius:8, padding:"6px 12px", textAlign:"center" }}>
            <div style={{ fontSize:9, color:"rgba(255,255,255,0.65)" }}>Total en campo</div>
            <div style={{ fontSize:20, fontWeight:800, color:"#fff" }}>{totalCampo} cab.</div>
          </div>
          <div style={{ background:"rgba(0,0,0,0.2)", borderRadius:8, padding:"6px 12px", textAlign:"center" }}>
            <div style={{ fontSize:9, color:"rgba(255,255,255,0.65)" }}>Propio</div>
            <div style={{ fontSize:20, fontWeight:800, color:"#fff" }}>{totalPropio}</div>
          </div>
          <div style={{ background:"rgba(0,0,0,0.2)", borderRadius:8, padding:"6px 12px", textAlign:"center" }}>
            <div style={{ fontSize:9, color:"rgba(255,255,255,0.65)" }}>Pastaje</div>
            <div style={{ fontSize:20, fontWeight:800, color:"#fff" }}>{totalPastaje}</div>
          </div>
        </div>
      </div>

      {/* Tablero % composición stock */}
      <div style={{ background:C.card, borderRadius:16, padding:"14px 16px", marginBottom:12,
        border:`1.5px solid ${C.border}` }}>
        <div style={{ fontSize:12, fontWeight:700, color:C.t2, marginBottom:10 }}>
          📊 Composición del stock en campo
        </div>

        {/* Barra apilada propio vs pastaje */}
        <div style={{ marginBottom:12 }}>
          <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:C.t3, marginBottom:4 }}>
            <span>🏠 Propio {pctPropio.toFixed(0)}%</span>
            <span>🤝 Pastaje {pctPastaje.toFixed(0)}%</span>
          </div>
          <div style={{ height:14, borderRadius:7, overflow:"hidden", display:"flex", background:C.border }}>
            <div style={{ width:`${pctPropio}%`, background:C.green, transition:"width .4s" }}/>
            <div style={{ width:`${pctPastaje}%`, background:C.teal, transition:"width .4s" }}/>
          </div>
        </div>

        {/* Barra detallada por categoría */}
        <div style={{ height:20, borderRadius:10, overflow:"hidden", display:"flex", gap:1, marginBottom:10 }}>
          {categorias.map((c,i) => (
            <div key={i} title={`${c.label}: ${c.cab}`}
              style={{ width:`${(c.cab/totalCampo*100).toFixed(1)}%`,
                background:c.color, transition:"width .4s", minWidth:c.cab>0?2:0 }}/>
          ))}
        </div>

        {/* Leyenda */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:4 }}>
          {categorias.map((c,i)=>(
            <div key={i} style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
              padding:"5px 8px", background:C.bg, borderRadius:8 }}>
              <div style={{ display:"flex", alignItems:"center", gap:5 }}>
                <div style={{ width:8, height:8, borderRadius:2, background:c.color, flexShrink:0 }}/>
                <span style={{ fontSize:10, color:C.t2 }}>{c.label}</span>
              </div>
              <div style={{ textAlign:"right" }}>
                <span style={{ fontSize:11, fontWeight:700, color:C.t1,
                  fontFamily:"'DM Mono',monospace" }}>{c.cab}</span>
                <span style={{ fontSize:9, color:C.t3, marginLeft:2 }}>
                  {(c.cab/totalCampo*100).toFixed(0)}%
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Resumen rápido */}
      <div style={{ background:C.card, borderRadius:14, padding:"14px 16px",
        border:`1.5px solid ${C.border}` }}>
        <div style={{ fontSize:11, fontWeight:700, color:C.t3, textTransform:"uppercase",
          letterSpacing:1, marginBottom:10 }}>Resumen operativo</div>
        {[
          ["🐄 Vientres en producción", vientres, C.green],
          ["🐂 Toros", toros, C.orange],
          ["📦 En recría (stock)", novillosRec, C.amber],
          ["🌱 Nuevo lote recría", novillosNuevo, C.blue],
          ["🐣 Terneros destete", ternerosMac, C.teal],
          ["🤝 Pastaje de terceros", totalPastaje, C.teal],
        ].filter(([,v])=>v>0).map(([l,v,c],i)=>(
          <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
            padding:"7px 0", borderBottom:`1px solid ${C.border}` }}>
            <span style={{ fontSize:12, color:C.t2 }}>{l}</span>
            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
              <span style={{ fontSize:14, fontWeight:800, color:c,
                fontFamily:"'DM Mono',monospace" }}>{v}</span>
              <span style={{ fontSize:10, color:C.t3 }}>cab.</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


// --- VENTAS -------------------------------------------------------------------
function VentasIcon({ size=18, color="#16a34a" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ display:"block", flexShrink:0 }}>
      <circle cx="9"  cy="20" r="1.8" fill={color} />
      <circle cx="17" cy="20" r="1.8" fill={color} />
      <path d="M2 3h2.5l2.8 11h9.2l2-7H7" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M11 9 L14 12 L18 7" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity="0.6"/>
    </svg>
  );
}

function Ventas({ s, rc, fl, rechazo, rechazo_calc, R, inmag }) {
  const im = inmag || 4574;
  const anio0 = R.anios[0];

  // ── destinos configurados ──
  const stock_va_feedlot   = (rc.stock_destino_actual||0) === 1;
  const nuevolote_feedlot  = (rc.destino_nuevo_lote||0) === 1;

  // ── STOCK ACTUAL ──
  const st_cab    = rc.stock_cab || 0;
  const st_kg     = rc.stock_peso_actual || 260;
  const st_px     = rc.stock_precio_venta || 5500;
  const st_bruto  = st_cab * st_kg * st_px;
  const st_come   = st_bruto * ((rc.stock_comerc_venta||rc.comerc_venta||3)/100);
  const st_flete  = st_cab * (rc.stock_flete_venta||rc.flete_venta||3000);
  const st_neto   = st_bruto - st_come - st_flete;

  // ── NUEVO LOTE RECRÍA → se vende el AÑO QUE VIENE (no este año)
  // Solo lo mostramos como proyección, NO lo sumamos al total de este año
  const novillos_cab   = rc.cabezas_comprados || 35;
  const novillos_kg    = rc.peso_salida || 340;
  const novillos_px    = rc.precio_venta_invernada || 5500;
  const novillos_bruto = novillos_cab * novillos_kg * novillos_px;
  const novillos_come  = novillos_bruto * ((rc.comerc_venta||3) / 100);
  const novillos_neto  = novillos_bruto - novillos_come - novillos_cab * (rc.flete_venta||3000);

  // ── FEEDLOT → este año: solo vacas descarte + externos
  // El nuevo lote y el stock actual que van a feedlot se procesan el año siguiente
  const fl_vacas_cab   = fl.fuente_vacas  ? Math.round((s.vacas_actuales||77)*0.20) : 0;
  const fl_ext_cab     = fl.fuente_externos ? (fl.cabezas_externos||0) : 0;
  const fl_total_cab   = fl_vacas_cab + fl_ext_cab;
  const fl_kg_salida   = fl.peso_salida_fl || 480;
  const fl_px_faena    = fl.precio_faena   || 4300;
  const fl_bruto       = fl_total_cab * fl_kg_salida * fl_px_faena;
  const fl_come        = fl_bruto * ((fl.comerc_venta_fl||3) / 100);
  const fl_neto        = fl_bruto - fl_come - fl_total_cab * (fl.flete_salida_fl||3000);

  // ── FEEDLOT PRÓXIMO AÑO → nuevo lote y/o stock que van a feedlot
  const fl_recria_cab_prox = (fl.fuente_recria && nuevolote_feedlot) ? (rc.cabezas_comprados||35) : 0;
  const fl_stock_cab_prox  = stock_va_feedlot ? st_cab : 0;
  const fl_prox_cab        = fl_recria_cab_prox + fl_stock_cab_prox;
  const fl_prox_bruto      = fl_prox_cab * fl_kg_salida * fl_px_faena;
  const fl_prox_come       = fl_prox_bruto * ((fl.comerc_venta_fl||3) / 100);
  const fl_prox_neto       = fl_prox_bruto - fl_prox_come - fl_prox_cab * (fl.flete_salida_fl||3000);

  // ── TERNERAS EXCEDENTE (cría propia)
  const tern_cab       = anio0?.vendidas_exc || 0;
  const tern_kg        = s.peso_ternera_exc  || 160;
  const tern_px        = s.precio_ternera_exc|| 6349;
  const tern_neto      = tern_cab * tern_kg  * tern_px;

  // ── MACHOS DESTETE
  const mac_cab        = anio0?.machos || 33;
  const mac_kg         = s.peso_entrada_mac || 170;
  const mac_px         = s.precio_venta_nov || 5100;
  const mac_neto       = mac_cab * mac_kg * mac_px;

  // ── VACAS RECHAZO
  const rch_neto       = rechazo_calc.ingreso_final || 0;
  const rch_cab        = rechazo.cabezas || 0;
  const rch_esFeedlot  = rechazo.destino === "feedlot";
  const rch_px_display = rch_esFeedlot ? rechazo.precio_faena : rechazo.precio_invernada;
  const rch_kg_display = rch_esFeedlot ? Math.round(rechazo_calc.peso_salida||rechazo.peso_vivo) : rechazo.peso_vivo;

  // Este año: stock (si va invernada) + feedlot vacas+externos + terneras + machos + rechazo
  const totalVentas    = (stock_va_feedlot ? 0 : st_neto) + fl_neto + tern_neto + mac_neto + rch_neto;
  const totalInvernada = (stock_va_feedlot ? 0 : st_neto) + tern_neto + mac_neto + (rch_esFeedlot?0:rch_neto);
  const totalFaena     = fl_neto + (rch_esFeedlot?rch_neto:0);
  const totalCab       = (stock_va_feedlot?0:st_cab) + fl_total_cab + tern_cab + mac_cab + rch_cab;

  // Grupos este año (sin nuevo lote)
  const grupos = [
    (!stock_va_feedlot && st_cab > 0) ? { label:"Stock recría actual", cab:st_cab, kg:st_kg, px:st_px, neto:st_neto, tipo:"invernada", color:C.amber,
      filas:[
        { l:"Cabezas", v:`${st_cab} cab` },
        { l:"Peso actual", v:`${st_kg} kg` },
        { l:"Precio $/kg", v:`$${st_px.toLocaleString("es-AR")}` },
        { l:"Ingreso bruto", v:fmt(st_bruto), c:C.green },
        { l:"Com. + flete", v:`-${fmt(st_come+st_flete)}`, c:C.red },
        { l:"Ingreso neto", v:fmt(st_neto), c:C.amber, bold:true },
      ]
    } : null,
    fl_total_cab > 0 ? { label:"Feedlot → Faena (este año)", cab:fl_total_cab, kg:fl_kg_salida, px:fl_px_faena, neto:fl_neto, tipo:"faena", color:C.orange,
      filas:[
        fl_vacas_cab>0 ? { l:`Vacas descarte (${fl_vacas_cab} cab)`, v:"✓", c:C.green } : null,
        fl_ext_cab>0   ? { l:`Externos (${fl_ext_cab} cab)`, v:"✓", c:C.green } : null,
        { l:"Peso salida", v:`${fl_kg_salida} kg` },
        { l:"Precio faena $/kg", v:`$${fl_px_faena.toLocaleString("es-AR")}` },
        { l:"Ingreso bruto", v:fmt(fl_bruto), c:C.green },
        { l:"Com. + flete", v:`-${fmt(fl_come + fl_total_cab*(fl.flete_salida_fl||3000))}`, c:C.red },
        { l:"Ingreso neto", v:fmt(fl_neto), c:C.orange, bold:true },
      ].filter(Boolean)
    } : null,
    tern_cab > 0 ? { label:"Terneras excedente", cab:tern_cab, kg:tern_kg, px:tern_px, neto:tern_neto, tipo:"invernada", color:C.teal,
      filas:[
        { l:"Cabezas excedente año 1", v:`${tern_cab} cab` },
        { l:"Peso", v:`${tern_kg} kg` },
        { l:"Precio $/kg", v:`$${tern_px.toLocaleString("es-AR")}` },
        { l:"Ingreso neto", v:fmt(tern_neto), c:C.teal, bold:true },
      ]
    } : null,
    mac_cab > 0 ? { label:"Machos destete", cab:mac_cab, kg:mac_kg, px:mac_px, neto:mac_neto, tipo:"invernada", color:C.green,
      filas:[
        { l:"Machos año 1", v:`${mac_cab} cab` },
        { l:"Peso destete", v:`${mac_kg} kg` },
        { l:"Precio $/kg", v:`$${mac_px.toLocaleString("es-AR")}` },
        { l:"Ingreso neto", v:fmt(mac_neto), c:C.green, bold:true },
      ]
    } : null,
    rch_cab > 0 ? { label:`Rechazo (${rch_esFeedlot?"faena":"invernada"})`, cab:rch_cab, kg:rch_kg_display, px:rch_px_display||0, neto:rch_neto, tipo:rch_esFeedlot?"faena":"invernada", color:C.red,
      filas: rch_esFeedlot ? [
        { l:"Cabezas", v:`${rch_cab} cab` },
        { l:"Peso entrada", v:`${rechazo.peso_vivo} kg` },
        { l:`Días feedlot (GDP ${rechazo.gdp_feedlot}kg/d)`, v:`${rechazo.dias_feedlot} días` },
        { l:"Peso salida est.", v:`${rch_kg_display} kg` },
        { l:"Precio faena $/kg", v:`$${rechazo.precio_faena.toLocaleString("es-AR")}` },
        { l:"Ingreso neto", v:fmt(rch_neto), c:C.orange, bold:true },
      ] : [
        { l:"Cabezas", v:`${rch_cab} cab` },
        { l:"Peso vivo", v:`${rechazo.peso_vivo} kg` },
        { l:"Precio invernada $/kg", v:`$${rechazo.precio_invernada.toLocaleString("es-AR")}` },
        { l:"Ingreso neto", v:fmt(rch_neto), c:C.amber, bold:true },
      ]
    } : null,
  ].filter(Boolean);

  return (
    <div style={{ paddingBottom:8 }}>

      {/* Hero */}
      <div style={{ background:"linear-gradient(135deg,#16a34a,#2563eb)",
        borderRadius:20, padding:"18px 20px", marginBottom:14, position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", right:-10, top:-10, opacity:0.1 }}>
          <VentasIcon size={90} color="#fff" />
        </div>
        <div style={{ fontSize:11, color:"rgba(255,255,255,0.7)", textTransform:"uppercase", letterSpacing:1.5, marginBottom:4 }}>
          Total ventas anuales
        </div>
        <div style={{ fontSize:34, fontWeight:800, color:"#fff", fontFamily:"'DM Mono',monospace", marginBottom:10 }}>
          {fmt(totalVentas)}
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <div style={{ flex:1, background:"rgba(0,0,0,0.18)", borderRadius:10, padding:"8px 10px" }}>
            <div style={{ fontSize:9, color:"rgba(255,255,255,0.65)", marginBottom:2 }}>📦 INVERNADA</div>
            <div style={{ fontSize:14, fontWeight:800, color:"#fff", fontFamily:"'DM Mono',monospace" }}>{fmt(totalInvernada)}</div>
          </div>
          <div style={{ flex:1, background:"rgba(0,0,0,0.18)", borderRadius:10, padding:"8px 10px" }}>
            <div style={{ fontSize:9, color:"rgba(255,255,255,0.65)", marginBottom:2 }}>🥩 FAENA</div>
            <div style={{ fontSize:14, fontWeight:800, color:"#fff", fontFamily:"'DM Mono',monospace" }}>{fmt(totalFaena)}</div>
          </div>
          <div style={{ flex:1, background:"rgba(0,0,0,0.18)", borderRadius:10, padding:"8px 10px" }}>
            <div style={{ fontSize:9, color:"rgba(255,255,255,0.65)", marginBottom:2 }}>Cabezas</div>
            <div style={{ fontSize:14, fontWeight:800, color:"#fff" }}>{totalCab} cab.</div>
          </div>
        </div>
      </div>

      {/* Barra de composición */}
      {grupos.length > 0 && (
        <div style={{ background:C.card, borderRadius:14, padding:"14px 16px", marginBottom:12,
          border:`1.5px solid ${C.border}` }}>
          <div style={{ fontSize:11, fontWeight:700, color:C.t2, marginBottom:10 }}>Composición de ventas</div>
          <div style={{ display:"flex", height:12, borderRadius:6, overflow:"hidden", marginBottom:12, gap:1 }}>
            {grupos.map((g,i) => (
              <div key={i} style={{
                width: totalVentas > 0 ? `${(g.neto/totalVentas*100).toFixed(1)}%` : "0%",
                background: g.color, opacity: 0.85, transition:"width 0.4s"
              }} />
            ))}
          </div>
          {grupos.map((g,i) => (
            <div key={i} style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
              padding:"5px 0", borderBottom:`1px solid ${C.border}` }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <div style={{ width:10, height:10, borderRadius:2, background:g.color, flexShrink:0 }} />
                <div>
                  <div style={{ fontSize:12, color:C.t1, fontWeight:500 }}>{g.label}</div>
                  <div style={{ fontSize:10, color:C.t3 }}>{g.cab} cab · {g.kg}kg · ${(g.px||0).toLocaleString("es-AR")}/kg</div>
                </div>
              </div>
              <div style={{ textAlign:"right", flexShrink:0, marginLeft:8 }}>
                <div style={{ fontSize:13, fontWeight:700, color:g.color, fontFamily:"'DM Mono',monospace" }}>{fmt(g.neto)}</div>
                <div style={{ fontSize:10, color:C.t3 }}>{totalVentas>0?(g.neto/totalVentas*100).toFixed(0):0}%</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Cards detalle por categoría */}
      {grupos.map((g, i) => (
        <div key={i} style={{ background:C.card, borderRadius:16, padding:"14px 16px", marginBottom:12,
          border:`1.5px solid ${C.border}` }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <div style={{ fontSize:13, fontWeight:700, color:C.t1 }}>{g.label}</div>
            <div style={{ background:g.tipo==="faena"?C.orangeL:C.blueL, borderRadius:6,
              padding:"3px 8px", fontSize:10, fontWeight:600, color:g.tipo==="faena"?C.orange:C.blue }}>
              {g.tipo==="faena"?"🥩 Faena":"📦 Invernada"}
            </div>
          </div>
          {g.filas.map((f,j) => (
            <div key={j} style={{ display:"flex", justifyContent:"space-between",
              padding:"6px 0", borderBottom:`1px solid ${C.border}` }}>
              <span style={{ fontSize:11, color:C.t3 }}>{f.l}</span>
              <span style={{ fontSize:12, fontWeight:f.bold?800:600, color:f.c||C.t1,
                fontFamily:"'DM Mono',monospace" }}>{f.v}</span>
            </div>
          ))}
        </div>
      ))}

      {/* ── PROYECCIÓN PRÓXIMO AÑO: nuevo lote ── */}
      {novillos_cab > 0 && (
        <>
          <div style={{ display:"flex", alignItems:"center", gap:8, margin:"16px 0 10px" }}>
            <div style={{ flex:1, height:1, background:C.border }}/>
            <span style={{ fontSize:11, fontWeight:700, color:C.blue, textTransform:"uppercase",
              letterSpacing:1, whiteSpace:"nowrap" }}>🌱 Proyección próximo año</span>
            <div style={{ flex:1, height:1, background:C.border }}/>
          </div>
          <div style={{ background:C.blueL, borderRadius:12, padding:"10px 14px", marginBottom:10,
            fontSize:11, color:C.blue, border:`1px solid ${C.blue}30` }}>
            El nuevo lote (comprado en {["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"][(rc.stock_mes_compra||5)-1]}) se vende en el año que viene, con {rc.meses||10} meses de recría.
          </div>
          <div style={{ background:C.card, borderRadius:16, padding:"14px 16px", marginBottom:12,
            border:`1.5px solid ${C.blue}40` }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
              <div style={{ fontSize:13, fontWeight:700, color:C.blue }}>
                {nuevolote_feedlot ? "🥩 Nuevo lote → Feedlot (año que viene)" : "📦 Nuevo lote → Invernada (año que viene)"}
              </div>
              <div style={{ fontSize:11, fontWeight:700, color:C.blue,
                fontFamily:"'DM Mono',monospace" }}>{novillos_cab} cab.</div>
            </div>
            {[
              { l:"Cabezas", v:`${novillos_cab} cab` },
              { l:"Peso salida", v:`${novillos_kg} kg` },
              { l:"Precio $/kg", v:`$${novillos_px.toLocaleString("es-AR")}` },
              { l:"Ingreso bruto", v:fmt(novillos_bruto), c:C.green },
              { l:"Com. + flete", v:`-${fmt(novillos_come + novillos_cab*(rc.flete_venta||3000))}`, c:C.red },
              { l:"Ingreso neto est.", v:fmt(novillos_neto), c:C.blue, bold:true },
            ].concat(fl_prox_cab > 0 ? [
              { l:`+ Feedlot (${fl_prox_cab} cab)`, v:fmt(fl_prox_neto), c:C.orange, bold:true },
            ] : []).map((f,j) => (
              <div key={j} style={{ display:"flex", justifyContent:"space-between",
                padding:"6px 0", borderBottom:`1px solid ${C.border}` }}>
                <span style={{ fontSize:11, color:C.t3 }}>{f.l}</span>
                <span style={{ fontSize:12, fontWeight:f.bold?800:600, color:f.c||C.t1,
                  fontFamily:"'DM Mono',monospace" }}>{f.v}</span>
              </div>
            ))}
            <div style={{ display:"flex", justifyContent:"space-between", paddingTop:10 }}>
              <span style={{ fontSize:13, fontWeight:800, color:C.t1 }}>Total proyectado</span>
              <span style={{ fontSize:15, fontWeight:800, color:C.blue,
                fontFamily:"'DM Mono',monospace" }}>{fmt(novillos_neto + fl_prox_neto)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// --- PASTAJE ------------------------------------------------------------------
function PastajeIcon({ size=18, color="#0d9488" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ display:"block", flexShrink:0 }}>
      {/* tallo central */}
      <path d="M12 22 Q12 14 12 10" stroke={color} strokeWidth="1.8" strokeLinecap="round"/>
      {/* hoja izquierda grande */}
      <path d="M12 14 Q7 12 5 7 Q9 6 12 10" fill={color} opacity="0.85"/>
      {/* hoja derecha grande */}
      <path d="M12 11 Q17 9 19 4 Q15 4 12 8" fill={color} opacity="0.7"/>
      {/* hoja izquierda pequeña */}
      <path d="M12 18 Q8 17 7 13 Q10 13 12 16" fill={color} opacity="0.55"/>
      {/* tierra */}
      <ellipse cx="12" cy="22" rx="4" ry="1.2" fill={color} opacity="0.2"/>
    </svg>
  );
}

function Pastaje({ pt, setPt, pastaje_calc, inmag, setS, s }) {
  const setp = (k, v) => setPt(p => ({ ...p, [k]: Number(v)||0 }));
  const inmag_ = inmag || 4574;

  return (
    <div style={{ paddingBottom:8 }}>
      {/* Precio INMAG editable */}
      <div style={{ background:`linear-gradient(135deg,#0f766e,#0d9488)`, borderRadius:14,
        padding:"14px 16px", marginBottom:14, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <div style={{ fontSize:10, color:"rgba(255,255,255,0.7)", textTransform:"uppercase", letterSpacing:1, marginBottom:2 }}>
            Precio INMAG actual
          </div>
          <div style={{ fontSize:28, fontWeight:800, color:"#fff", fontFamily:"'DM Mono',monospace" }}>
            ${inmag_.toLocaleString("es-AR")}<span style={{ fontSize:13, fontWeight:500 }}>/kg</span>
          </div>
          <div style={{ fontSize:10, color:"rgba(255,255,255,0.6)", marginTop:2 }}>Varía diariamente · actualizá acá</div>
        </div>
        <div style={{ fontSize:40, opacity:0.15 }}>💲</div>
      </div>
      <div style={{ background:C.card, borderRadius:12, padding:"10px 14px", marginBottom:14,
        border:`1.5px solid ${C.teal}40` }}>
        <Sl label="INMAG ($/kg)" value={s?.inmag || 4574} onChange={v=>setS(p=>({...p,inmag:Number(v)||0}))} min={1000} max={10000} step={50} />
      </div>

      {/* Hero ingresos */}
      <div style={{ borderRadius:20, padding:"18px 20px", marginBottom:14, overflow:"hidden", position:"relative",
        background:"linear-gradient(135deg,#0d9488,#16a34a)" }}>
        <div style={{ position:"absolute", right:-10, top:-10, opacity:0.12 }}>
          <PastajeIcon size={90} color="#fff" />
        </div>
        <div style={{ fontSize:11, color:"rgba(255,255,255,0.7)", textTransform:"uppercase", letterSpacing:1.5, marginBottom:6 }}>
          Ingresos por pastaje
        </div>
        <div style={{ fontSize:34, fontWeight:800, color:"#fff", fontFamily:"'DM Mono',monospace", marginBottom:4 }}>
          {fmt(pastaje_calc.total)}
        </div>
        <div style={{ display:"flex", gap:12 }}>
          <div style={{ background:"rgba(0,0,0,0.18)", borderRadius:8, padding:"5px 12px" }}>
            <span style={{ fontSize:10, color:"rgba(255,255,255,0.7)" }}>Por mes  </span>
            <span style={{ fontSize:12, fontWeight:700, color:"#fff", fontFamily:"'DM Mono',monospace" }}>{fmt(pastaje_calc.total/12)}</span>
          </div>
          <div style={{ background:"rgba(0,0,0,0.18)", borderRadius:8, padding:"5px 12px" }}>
            <span style={{ fontSize:10, color:"rgba(255,255,255,0.7)" }}>Animales  </span>
            <span style={{ fontSize:12, fontWeight:700, color:"#fff" }}>{pastaje_calc.animales} cab.</span>
          </div>
        </div>
      </div>

      {/* Resumen por categoría */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:12 }}>
        {[
          ["🐄 Vacas",    pastaje_calc.ing_vacas,    C.green],
          ["🐂 Novillos", pastaje_calc.ing_novillos, C.blue],
          ["🐣 Terneros", pastaje_calc.ing_terneros, C.amber],
          ["🐮 Toros",    pastaje_calc.ing_toros,    C.purple],
        ].map(([l,v,c]) => (
          <div key={l} style={{ background:C.card, borderRadius:12, padding:"10px 12px",
            border:`1.5px solid ${C.border}`, borderLeft:`3px solid ${c}` }}>
            <div style={{ fontSize:11, color:C.t3, marginBottom:2 }}>{l}</div>
            <div style={{ fontSize:14, fontWeight:800, color:c, fontFamily:"'DM Mono',monospace" }}>{fmt(v)}</div>
            <div style={{ fontSize:10, color:C.t3 }}>/año</div>
          </div>
        ))}
      </div>

      {/* Hero ingresos */}
      <div style={{ borderRadius:20, padding:"18px 20px", marginBottom:14, overflow:"hidden", position:"relative",
        background:"linear-gradient(135deg,#0d9488,#16a34a)" }}>
        <div style={{ position:"absolute", right:-10, top:-10, opacity:0.12 }}>
          <PastajeIcon size={90} color="#fff" />
        </div>
        <div style={{ fontSize:11, color:"rgba(255,255,255,0.7)", textTransform:"uppercase", letterSpacing:1.5, marginBottom:6 }}>
          Ingresos por pastaje
        </div>
        <div style={{ fontSize:34, fontWeight:800, color:"#fff", fontFamily:"'DM Mono',monospace", marginBottom:4 }}>
          {fmt(pastaje_calc.total)}
        </div>
        <div style={{ display:"flex", gap:12 }}>
          <div style={{ background:"rgba(0,0,0,0.18)", borderRadius:8, padding:"5px 12px" }}>
            <span style={{ fontSize:10, color:"rgba(255,255,255,0.7)" }}>Por mes  </span>
            <span style={{ fontSize:12, fontWeight:700, color:"#fff", fontFamily:"'DM Mono',monospace" }}>{fmt(pastaje_calc.total/12)}</span>
          </div>
          <div style={{ background:"rgba(0,0,0,0.18)", borderRadius:8, padding:"5px 12px" }}>
            <span style={{ fontSize:10, color:"rgba(255,255,255,0.7)" }}>Animales  </span>
            <span style={{ fontSize:12, fontWeight:700, color:"#fff" }}>{pastaje_calc.animales} cab.</span>
          </div>
        </div>
      </div>

      {/* Resumen por categoría */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:12 }}>
        {[
          ["🐄 Vacas",    pastaje_calc.ing_vacas,    C.green],
          ["🐂 Novillos", pastaje_calc.ing_novillos, C.blue],
          ["🐣 Terneros", pastaje_calc.ing_terneros, C.amber],
          ["🐮 Toros",    pastaje_calc.ing_toros,    C.purple],
        ].map(([l,v,c]) => (
          <div key={l} style={{ background:C.card, borderRadius:12, padding:"10px 12px",
            border:`1.5px solid ${C.border}`, borderLeft:`3px solid ${c}` }}>
            <div style={{ fontSize:11, color:C.t3, marginBottom:2 }}>{l}</div>
            <div style={{ fontSize:14, fontWeight:800, color:c, fontFamily:"'DM Mono',monospace" }}>{fmt(v)}</div>
            <div style={{ fontSize:10, color:C.t3 }}>/año</div>
          </div>
        ))}
      </div>

      {/* Sliders por categoría */}
      {[
        { label:"🐄 Vacas",    cab_k:"vacas_tercero",    kg_k:"kg_vaca",    meses_k:"meses_vaca",    ing:pastaje_calc.ing_vacas,    maxKg:10 },
        { label:"🐂 Novillos", cab_k:"novillos_tercero", kg_k:"kg_novillo", meses_k:"meses_novillo", ing:pastaje_calc.ing_novillos, maxKg:10 },
        { label:"🐣 Terneros", cab_k:"terneros_tercero", kg_k:"kg_ternero", meses_k:"meses_ternero", ing:pastaje_calc.ing_terneros, maxKg:10 },
        { label:"🐮 Toros",    cab_k:"toros_tercero",    kg_k:"kg_toro",    meses_k:"meses_toro",    ing:pastaje_calc.ing_toros,    maxKg:10 },
      ].map(item => (
        <SecCard key={item.cab_k} title={`${item.label} — ${fmt(item.ing)}/año`} color={C.teal}>
          <div style={{ display:"flex", gap:6, marginBottom:10 }}>
            <div style={{ flex:1, background:C.bg, borderRadius:8, padding:"6px 8px", textAlign:"center" }}>
              <div style={{ fontSize:9, color:C.t3 }}>Cabezas</div>
              <div style={{ fontSize:16, fontWeight:800, color:C.t1 }}>{pt[item.cab_k]}</div>
            </div>
            <div style={{ flex:1, background:C.bg, borderRadius:8, padding:"6px 8px", textAlign:"center" }}>
              <div style={{ fontSize:9, color:C.t3 }}>kg/mes</div>
              <div style={{ fontSize:16, fontWeight:800, color:C.teal }}>{pt[item.kg_k]}</div>
            </div>
            <div style={{ flex:1, background:C.bg, borderRadius:8, padding:"6px 8px", textAlign:"center" }}>
              <div style={{ fontSize:9, color:C.t3 }}>meses</div>
              <div style={{ fontSize:16, fontWeight:800, color:C.purple }}>{pt[item.meses_k]}</div>
            </div>
            <div style={{ flex:1, background:C.bg, borderRadius:8, padding:"6px 8px", textAlign:"center" }}>
              <div style={{ fontSize:9, color:C.t3 }}>$/cab/mes</div>
              <div style={{ fontSize:12, fontWeight:700, color:C.t2 }}>{fmt(pt[item.kg_k]*inmag_)}</div>
            </div>
          </div>
          <Sl label="Cabezas" value={pt[item.cab_k]}
            onChange={v=>setp(item.cab_k,v)} min={0} max={400} step={1} prefix="" suffix=" cab" />
          <Sl label="kg INMAG / mes" value={pt[item.kg_k]}
            onChange={v=>setp(item.kg_k,v)} min={0} max={item.maxKg} step={0.5} prefix="" suffix=" kg" />
          <Sl label="Meses en campo" value={pt[item.meses_k]}
            onChange={v=>setp(item.meses_k,v)} min={1} max={12} step={1} prefix="" suffix=" meses" />
        </SecCard>
      ))}
    </div>
  );
}

// --- RENDIMIENTO KG/HA --------------------------------------------------------
function RendimientoIcon({ size=18, color="#0d9488" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ display:"block", flexShrink:0 }}>
      <rect x="3" y="14" width="3.5" height="7" rx="1.2" fill={color} opacity="0.5"/>
      <rect x="8.5" y="10" width="3.5" height="11" rx="1.2" fill={color} opacity="0.7"/>
      <rect x="14" y="6" width="3.5" height="15" rx="1.2" fill={color} opacity="0.85"/>
      <path d="M4.75 13.5 L10.25 9.5 L15.75 5.5" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="4.75" cy="13.5" r="1.3" fill={color}/>
      <circle cx="10.25" cy="9.5" r="1.3" fill={color}/>
      <circle cx="15.75" cy="5.5" r="1.3" fill={color}/>
    </svg>
  );
}

function Rendimiento({ R, s, rc, fl, rechazo, pt, g }) {
  const ha = g?.hectareas_campo || 1000;
  const MESES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];

  // ── parámetros de salida ──
  const machos_van_feedlot = fl?.fuente_recria;
  const kg_macho_salida    = machos_van_feedlot ? (fl?.peso_salida_fl||480) : (rc?.peso_salida||340);
  const kg_comprados_sal   = machos_van_feedlot ? (fl?.peso_salida_fl||480) : (rc?.peso_salida||340);
  const cab_comprados      = rc?.cabezas_comprados || 35;
  const rch_kg_salida      = rechazo?.destino === "feedlot"
    ? Math.round((rechazo?.peso_vivo||380) + (rechazo?.gdp_feedlot||0.9)*(rechazo?.dias_feedlot||90))
    : (rechazo?.peso_vivo || 380);
  const cab_rechazo        = rechazo?.cabezas || 0;

  // ── pasto ──
  const kg_vaca_mes    = pt?.kg_vaca    || 6;
  const kg_novillo_mes = pt?.kg_novillo || 5.5;
  const kg_ternero_mes = pt?.kg_ternero || 4;
  const kg_toro_mes    = pt?.kg_toro    || 7;
  const inmag          = s?.inmag || 4574;

  // ── stock actual (se vende este año) ──
  const stock_cab  = rc?.stock_cab || 0;
  const stock_peso = rc?.stock_peso_actual || 260;
  const kg_stock   = stock_cab * stock_peso;

  // ── pastaje de terceros: kg de PASTO consumido (carga animal que transita el campo) ──
  // kg_vaca/novillo/etc son kg de MS/día que consume cada categoría
  // Esto representa la presión/producción del campo medida en kg de materia seca por hectárea
  const kg_pastaje_vac  = (pt?.vacas_tercero    || 0) * (pt?.kg_vaca    || 6)   * (pt?.meses_vaca    || 12);
  const kg_pastaje_nov  = (pt?.novillos_tercero || 0) * (pt?.kg_novillo || 5.5) * (pt?.meses_novillo || 12);
  const kg_pastaje_tern = (pt?.terneros_tercero || 0) * (pt?.kg_ternero || 5.5) * (pt?.meses_ternero || 12);
  const kg_pastaje_tor  = (pt?.toros_tercero    || 0) * (pt?.kg_toro    || 5.5) * (pt?.meses_toro    || 12);
  const kg_pastaje_total = kg_pastaje_vac + kg_pastaje_nov + kg_pastaje_tern + kg_pastaje_tor;

  // ── función que calcula kg/ha para un año dado de R.anios, con/sin stock ──
  const calcAnio = (a, conStock) => {
    const kg_tern_exc  = a.vendidas_exc * (s?.peso_ternera_exc || 160);
    const kg_machos    = a.machos       * kg_macho_salida;
    const kg_comprados = cab_comprados  * kg_comprados_sal;
    const kg_rch       = cab_rechazo    * rch_kg_salida;
    const kg_st        = conStock ? kg_stock : 0;
    return {
      ternExc:    Math.round(kg_tern_exc       / ha),
      machos:     Math.round(kg_machos         / ha),
      comprados:  Math.round(kg_comprados      / ha),
      rechazo:    Math.round(kg_rch            / ha),
      stock:      Math.round(kg_st             / ha),
      pastaje:    Math.round(kg_pastaje_total / ha),
      total:      Math.round((kg_tern_exc + kg_machos + kg_comprados + kg_rch + kg_st + kg_pastaje_total) / ha),
    };
  };

  if (!R?.anios?.length) return null;
  const anio1  = R.anios[0];
  const anio2  = R.anios[1] || R.anios[0];
  const anio10 = R.anios[R.anios.length - 1];

  // Los tres momentos
  const actual     = calcAnio(anio1,  true);   // stock en campo + flujo año 1
  const proyAnio1  = calcAnio(anio1,  false);  // solo flujo año 1, sin stock
  const proyAnio2  = calcAnio(anio2,  false);  // año 2, más vientres
  const proyAnio10 = calcAnio(anio10, false);  // pleno

  // Serie para el gráfico a 10 años (sin stock, para ver la curva real de crecimiento)
  const cats = [
    { key:"Stock actual",           color:C.amber  },
    { key:"Tern. excedente",        color:C.teal   },
    { key:"Machos recría/feedlot",  color:C.blue   },
    { key:"Novillos comprados",     color:C.green  },
    { key:"Vacas rechazo",          color:C.orange },
    { key:"Pastaje 3°",             color:C.purple },
  ];

  const chartData = R.anios.map(a => {
    const d = calcAnio(a, a.y === 1);
    return {
      anio: a.y,
      "Stock actual":           d.stock,
      "Tern. excedente":        d.ternExc,
      "Machos recría/feedlot":  d.machos,
      "Novillos comprados":     d.comprados,
      "Vacas rechazo":          d.rechazo,
      "Pastaje 3°":             d.pastaje,
      kgHa: d.total,
      _vacas: a.vacas,
    };
  });

  // Carga animal (pasto consumido)
  const pastoData = R.anios.map(a => {
    const toros    = Math.max(1, Math.round(a.vacas * 0.03));
    const jovenes  = (a.retenidas||0) + (a.machos||0);
    const kgPasto  = (a.vacas * kg_vaca_mes + toros * kg_toro_mes
                   + jovenes * kg_ternero_mes + cab_comprados * kg_novillo_mes) * inmag * 12;
    return { anio: a.y, kgPastoHa: Math.round(kgPasto / ha), _vacas: a.vacas };
  });

  // helper para renderizar una tarjeta de momento
  const MomentoCard = ({ titulo, sub, data, color, bg, badge }) => (
    <div style={{ background:bg, borderRadius:14, padding:"12px 14px",
      border:`1.5px solid ${color}40`, position:"relative" }}>
      {badge && (
        <div style={{ position:"absolute", top:-8, right:10, background:color,
          color:"#fff", fontSize:9, fontWeight:800, borderRadius:6,
          padding:"2px 8px", letterSpacing:0.5 }}>{badge}</div>
      )}
      <div style={{ fontSize:10, color:color, fontWeight:700, textTransform:"uppercase",
        letterSpacing:1, marginBottom:4 }}>{titulo}</div>
      <div style={{ fontSize:10, color:C.t3, marginBottom:8 }}>{sub}</div>
      <div style={{ fontSize:28, fontWeight:800, color:color,
        fontFamily:"'DM Mono',monospace", lineHeight:1, marginBottom:6 }}>
        {data.total} <span style={{ fontSize:13, fontWeight:600 }}>kg/ha</span>
      </div>
      <div style={{ fontSize:10, color:C.t3, marginBottom:8 }}>
        {(data.total * ha).toLocaleString("es-AR")} kg totales · {ha.toLocaleString("es-AR")} ha
      </div>
      {/* mini desglose */}
      <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
        {[
          data.stock     > 0 && ["Stock campo",   data.stock,     C.amber ],
          data.ternExc   > 0 && ["Tern. exc.",     data.ternExc,   C.teal  ],
          data.machos    > 0 && ["Machos",         data.machos,    C.blue  ],
          data.comprados > 0 && ["Nov. comprados", data.comprados, C.green ],
          data.rechazo   > 0 && ["Rechazo",        data.rechazo,   C.orange],
          data.pastaje   > 0 && ["Pastaje 3°",     data.pastaje,   C.purple],
        ].filter(Boolean).map(([l,v,c],i)=>(
          <div key={i} style={{ display:"flex", justifyContent:"space-between",
            alignItems:"center" }}>
            <div style={{ display:"flex", alignItems:"center", gap:4 }}>
              <div style={{ width:6, height:6, borderRadius:2, background:c, flexShrink:0 }}/>
              <span style={{ fontSize:10, color:C.t2 }}>{l}</span>
            </div>
            <span style={{ fontSize:10, fontWeight:700, color:c,
              fontFamily:"'DM Mono',monospace" }}>{v} kg/ha</span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{ paddingBottom:8 }}>

      {/* ── HERO ── */}
      <div style={{ borderRadius:20, padding:"18px 20px", marginBottom:14, overflow:"hidden",
        position:"relative", background:"linear-gradient(135deg,#0f766e,#16a34a)" }}>
        <div style={{ position:"absolute", right:-8, top:-8, opacity:0.1 }}>
          <RendimientoIcon size={90} color="#fff"/>
        </div>
        <div style={{ fontSize:11, color:"rgba(255,255,255,0.7)", textTransform:"uppercase",
          letterSpacing:1.5, marginBottom:10 }}>Rendimiento del campo</div>
        <div style={{ display:"flex", gap:0, alignItems:"stretch" }}>
          {[
            { lbl:"Hoy",        val:actual.total,     vac:anio1.vacas,  nota:"con stock en campo" },
            { lbl:"Año 1",      val:proyAnio1.total,  vac:anio1.vacas,  nota:"flujo normal" },
            { lbl:"Año 2",      val:proyAnio2.total,  vac:anio2.vacas,  nota:"más vientres" },
            { lbl:"Año 10",     val:proyAnio10.total, vac:anio10.vacas, nota:"pleno" },
          ].map((it, i) => (
            <div key={i} style={{ flex:1, textAlign:"center",
              borderRight: i<3 ? "1px solid rgba(255,255,255,0.15)" : "none",
              padding:"0 6px" }}>
              <div style={{ fontSize:9, color:"rgba(255,255,255,0.55)",
                marginBottom:2 }}>{it.lbl}</div>
              <div style={{ fontSize:20, fontWeight:800, color:"#fff",
                fontFamily:"'DM Mono',monospace", lineHeight:1 }}>{it.val}</div>
              <div style={{ fontSize:8, color:"rgba(255,255,255,0.5)",
                marginTop:2 }}>{it.vac}v</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop:10, fontSize:10, color:"rgba(255,255,255,0.5)" }}>
          kg / ha · {ha.toLocaleString("es-AR")} ha
        </div>
      </div>

      {/* ── 3 TARJETAS COMPARATIVAS ── */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:12 }}>
        <MomentoCard
          titulo="Actual"
          sub={`Stock ${stock_cab} cab · ${MESES[(rc?.stock_mes_venta||4)-1]}`}
          data={actual} color={C.amber} bg={C.amberL}
          badge="HOY" />
        <MomentoCard
          titulo={`Proyectado año 1`}
          sub={`${anio1.vacas} vientres · sin stock`}
          data={proyAnio1} color={C.teal} bg={C.tealL} />
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:14 }}>
        <MomentoCard
          titulo="Próximo año"
          sub={`${anio2.vacas} vientres`}
          data={proyAnio2} color={C.blue} bg={C.blueL}
          badge="AÑO 2" />
        <MomentoCard
          titulo="Año pleno"
          sub={`${anio10.vacas} vientres`}
          data={proyAnio10} color={C.green} bg={C.greenL}
          badge="AÑO 10" />
      </div>

      {/* ── GRÁFICO EVOLUCIÓN 10 AÑOS ── */}
      <SecCard title="📈 Evolución kg/ha · 10 años" color={C.teal}>
        <div style={{ fontSize:11, color:C.t3, marginBottom:10 }}>
          Crecimiento real a medida que el rodeo gana vientres. Año 1 incluye el stock en campo.
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={chartData} margin={{ left:0, right:4, top:4, bottom:0 }} barSize={22}>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="anio" tick={{ fill:C.t3, fontSize:10 }}
              tickFormatter={v=>`A${v}`} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill:C.t3, fontSize:9 }} width={30} axisLine={false} tickLine={false} />
            <Tooltip content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const d = chartData.find(x=>x.anio===label);
              const total = payload.reduce((a,x)=>a+(x.value||0),0);
              return (
                <div style={{ background:C.card, border:`1px solid ${C.border}`,
                  borderRadius:10, padding:"9px 13px", fontSize:11, minWidth:190 }}>
                  <div style={{ display:"flex", justifyContent:"space-between",
                    marginBottom:5 }}>
                    <span style={{ color:C.t3, fontSize:10 }}>AÑO {label}</span>
                    <span style={{ color:C.t3, fontSize:10 }}>{d?._vacas} vientres</span>
                  </div>
                  {payload.filter(p=>p.value>0).map((p,i)=>(
                    <div key={i} style={{ display:"flex", justifyContent:"space-between",
                      gap:12, color:p.color, marginBottom:2 }}>
                      <span>{p.name}</span><b>{p.value} kg/ha</b>
                    </div>
                  ))}
                  <div style={{ borderTop:`1px solid ${C.border}`, marginTop:5, paddingTop:5,
                    display:"flex", justifyContent:"space-between",
                    fontWeight:800, color:C.t1 }}>
                    <span>Total</span><span>{total} kg/ha</span>
                  </div>
                </div>
              );
            }} />
            {cats.map((cat,i) => (
              <Bar key={cat.key} dataKey={cat.key} stackId="a" fill={cat.color} opacity={0.85}
                radius={i===cats.length-1?[4,4,0,0]:[0,0,0,0]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
        <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginTop:8 }}>
          {cats.map(({key,color})=>(
            <div key={key} style={{ display:"flex", alignItems:"center", gap:4 }}>
              <div style={{ width:8, height:8, borderRadius:2, background:color }}/>
              <span style={{ fontSize:10, color:C.t3 }}>{key}</span>
            </div>
          ))}
        </div>
      </SecCard>

      {/* ── TABLA RESUMEN 10 AÑOS ── */}
      <SecCard title="📋 Tabla rendimiento año a año" color={C.border}>
        <div style={{ display:"grid", gridTemplateColumns:"0.5fr 0.8fr 1fr 1fr",
          padding:"6px 0", fontSize:10, color:C.t3, fontWeight:700,
          textTransform:"uppercase", letterSpacing:0.6, borderBottom:`1px solid ${C.border}` }}>
          {["Año","Vientres","kg/ha","kg totales"].map((h,i)=>(
            <span key={h} style={{ textAlign:i>0?"right":"left" }}>{h}</span>
          ))}
        </div>
        {chartData.map((d, i) => {
          const prev = i > 0 ? chartData[i-1].kgHa : null;
          const delta = prev !== null ? d.kgHa - prev : null;
          return (
            <div key={d.anio} style={{ display:"grid",
              gridTemplateColumns:"0.5fr 0.8fr 1fr 1fr",
              padding:"7px 0", borderBottom:`1px solid ${C.border}`,
              background: i===0 ? `${C.amber}18` : "transparent" }}>
              <span style={{ fontSize:11, fontWeight:700,
                color: i===0 ? C.amber : C.t2 }}>
                {i===0 ? "A1★" : `A${d.anio}`}
              </span>
              <span style={{ fontSize:11, color:C.t3, textAlign:"right" }}>
                {d._vacas}
              </span>
              <span style={{ fontSize:11, fontWeight:700, textAlign:"right",
                fontFamily:"'DM Mono',monospace",
                color: i===0 ? C.amber : C.teal }}>
                {d.kgHa}
                {delta !== null && delta > 0 && (
                  <span style={{ fontSize:9, color:C.green, marginLeft:4 }}>+{delta}</span>
                )}
              </span>
              <span style={{ fontSize:11, textAlign:"right", color:C.t2,
                fontFamily:"'DM Mono',monospace" }}>
                {(d.kgHa * ha).toLocaleString("es-AR")}
              </span>
            </div>
          );
        })}
      </SecCard>

      {/* ── CARGA ANIMAL ── */}
      <SecCard title="🌿 Carga animal · kg pasto / ha" color={C.green}>
        <div style={{ fontSize:11, color:C.t3, marginBottom:10 }}>
          Presión del rodeo propio sobre el campo. Crece junto con los vientres.
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:12 }}>
          {[
            { lbl:"Año 1", val:pastoData[0]?.kgPastoHa, vac:anio1.vacas, bg:C.greenL, c:C.green },
            { lbl:"Año 10", val:pastoData[pastoData.length-1]?.kgPastoHa, vac:anio10.vacas, bg:C.tealL, c:C.teal },
          ].map(it=>(
            <div key={it.lbl} style={{ background:it.bg, borderRadius:12, padding:"12px 14px",
              border:`1.5px solid ${it.c}40` }}>
              <div style={{ fontSize:10, color:C.t3 }}>{it.lbl} · {it.vac} vientres</div>
              <div style={{ fontSize:22, fontWeight:800, color:it.c,
                fontFamily:"'DM Mono',monospace" }}>{it.val?.toLocaleString("es-AR")}</div>
              <div style={{ fontSize:11, color:C.t3 }}>kg INMAG/ha</div>
            </div>
          ))}
        </div>
        <ResponsiveContainer width="100%" height={120}>
          <AreaChart data={pastoData} margin={{ left:0, right:4, top:4, bottom:0 }}>
            <defs>
              <linearGradient id="gpasto" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={C.green} stopOpacity={0.25}/>
                <stop offset="95%" stopColor={C.green} stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" vertical={false}/>
            <XAxis dataKey="anio" tick={{ fill:C.t3, fontSize:10 }}
              tickFormatter={v=>`A${v}`} axisLine={false} tickLine={false}/>
            <YAxis tick={{ fill:C.t3, fontSize:9 }} width={38} axisLine={false} tickLine={false}/>
            <Tooltip
              formatter={v=>[`${v.toLocaleString("es-AR")} kg/ha`, "kg pasto/ha"]}
              labelFormatter={l=>`Año ${l}`}
              contentStyle={{ background:C.card, border:`1px solid ${C.border}`,
                borderRadius:10, fontSize:11 }}/>
            <Area type="monotone" dataKey="kgPastoHa" stroke={C.green} strokeWidth={2.5}
              fill="url(#gpasto)" dot={false}/>
          </AreaChart>
        </ResponsiveContainer>
      </SecCard>
    </div>
  );
}

// --- CAMPO (GASTOS) -----------------------------------------------------------
function Campo({ g, setG, pastaje_calc, rc_margen, fl_margen, rc_costo_compra, repos_costo, R, s, rc, fl, rechazo, pt }) {
  const [guardado, setGuardado] = useState(false);
  const set  = (k, v) => setG(p => ({ ...p, [k]: Number(v)||0 }));
  const fijar = () => { setGuardado(true); setTimeout(()=>setGuardado(false),2000); };
  const calc = useMemo(() => calcGastos(g), [g]);
  const items = [
    { label:"Sueldos y cargas", valor:calc.sueldos_anio,  color:C.red },
    { label:"Rolado",           valor:calc.rolado_anio,   color:C.amber },
    { label:"Mantenimiento",    valor:calc.mant_anio,     color:C.blue },
    { label:"Viajes",           valor:calc.viajes_anio_dol, color:C.purple },
  ];

  return (
    <div style={{ paddingBottom:8 }}>

      {/* Hero: balance neto INTEGRAL */}
      {(() => {
        const ingresos_tot = pastaje_calc.total + (rc_margen||0) + (fl_margen||0);
        const egresos_tot  = calc.total + (rc_costo_compra||0) + (repos_costo||0);
        const neto_int     = ingresos_tot - egresos_tot;
        const lineItems = [
          { label:"+ Pastaje 3ros",   val: pastaje_calc.total,      sign:"+" },
          { label:"+ Margen recria",  val: rc_margen||0,            sign:"+" },
          { label:"+ Margen feedlot", val: fl_margen||0,            sign: (fl_margen||0)>=0?"+":"-" },
          { label:"- Compra hacienda",val: rc_costo_compra||0,      sign:"-" },
          { label:"- Repos. externa", val: repos_costo||0,          sign:"-" },
          { label:"- Gastos campo",   val: calc.total,              sign:"-" },
        ];
        return (
          <div style={{ borderRadius:20, padding:"18px", marginBottom:14, overflow:"hidden", position:"relative",
            background: neto_int >= 0
              ? "linear-gradient(135deg,#16a34a,#0d9488)"
              : "linear-gradient(135deg,#dc2626,#ea580c)" }}>
            <div style={{ position:"absolute", right:-16, top:-16, fontSize:72, opacity:0.1 }}>🏡</div>
            <div style={{ fontSize:11, color:"rgba(255,255,255,0.7)", textTransform:"uppercase",
              letterSpacing:1.5, marginBottom:8 }}>Balance integral del campo</div>
            <div style={{ fontSize:32, fontWeight:800, color:"#fff",
              fontFamily:"'DM Mono',monospace", marginBottom:12 }}>
              {neto_int >= 0 ? "+" : ""}{fmt(neto_int)}
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
              {lineItems.filter(it => it.val !== 0).map((it,i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between",
                  background:"rgba(0,0,0,0.15)", borderRadius:7, padding:"5px 10px" }}>
                  <span style={{ fontSize:10, color:"rgba(255,255,255,0.75)" }}>{it.label}</span>
                  <span style={{ fontSize:11, fontWeight:700, fontFamily:"'DM Mono',monospace",
                    color: it.sign === "+" ? "rgba(200,255,200,0.95)" : "rgba(255,180,180,0.95)" }}>
                    {it.sign}{fmt(Math.abs(it.val))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      <SecCard title="Distribución gastos" color={C.border}>
        <BarraCostos items={items} total={calc.total} />
      </SecCard>

      <SecCard title="👥 Sueldos" color={C.red}>
        <Row label="Encargado" val={fmt(g.sueldo_encargado)} sub="/mes bruto" />
        <Row label="Peón 1" val={fmt(g.sueldo_peon1)} sub="/mes bruto" />
        <Row label="Peón 2" val={fmt(g.sueldo_peon2)} sub="/mes bruto" />
        <Row label={`Cargas sociales ${g.cargas_sociales}%`} val={fmt(calc.cargas)} sub="/mes" color={C.amber} />
        <Row label="Subtotal mensual" val={fmt(calc.neto_mensual)} sub="bruto + cargas" color={C.t2} />
        <Row label="Aguinaldo (SAC anual)" val={fmt(calc.aguinaldo)} sub="2 medios sueldos" color={C.orange} />
        <Row label="Premios anuales" val={fmt(calc.premios)} color={C.purple} />
        <Row label="Total anual personal" val={fmt(calc.sueldos_anio)} bold color={C.red} />
        <div style={{ marginTop:14 }}>
          <Sl label="Encargado ($/mes)" value={g.sueldo_encargado} onChange={v=>set("sueldo_encargado",v)} min={900000} max={2500000} step={50000} />
          <Sl label="Peón 1 ($/mes)" value={g.sueldo_peon1} onChange={v=>set("sueldo_peon1",v)} min={900000} max={2500000} step={50000} />
          <Sl label="Peón 2 ($/mes)" value={g.sueldo_peon2} onChange={v=>set("sueldo_peon2",v)} min={900000} max={2500000} step={50000} />
          <Sl label="Cargas sociales" value={g.cargas_sociales} onChange={v=>set("cargas_sociales",v)} min={35} max={65} step={1} prefix="" suffix="%" />
          <Sl label="Premios anuales ($)" value={g.premios_anio||0} onChange={v=>set("premios_anio",v)} min={0} max={3000000} step={100000} />
        </div>
      </SecCard>

      <SecCard title="🚜 Rolado" color={C.amber}>
        <Row label="Campo total" val={`${g.hectareas_campo.toLocaleString("es-AR")} ha`} />
        <Row label="Has roladas/anio" val={`${g.hectareas_rolado} ha`}
          sub={g.hectareas_rolado>0?`ciclo en ${(g.hectareas_campo/g.hectareas_rolado).toFixed(1)} anios`:"sin rolado"} />
        <Row label="Costo anual" val={fmt(calc.rolado_anio)} bold color={C.amber} />
        <div style={{ marginTop:14 }}>
          <Sl label="Hectáreas del campo" value={g.hectareas_campo} onChange={v=>set("hectareas_campo",v)} min={100} max={10000} step={50} prefix="" suffix=" ha" />
          <Sl label="Has a rolar/anio" value={g.hectareas_rolado} onChange={v=>set("hectareas_rolado",v)} min={0} max={1000} step={10} prefix="" suffix=" ha" />
          <Sl label="Costo ($/ha)" value={g.costo_rolado_ha} onChange={v=>set("costo_rolado_ha",v)} min={30000} max={200000} step={5000} />
        </div>
      </SecCard>

      <SecCard title="🔧 Mantenimiento" color={C.blue}>
        <Row label="Infraestructura" val={fmt(g.mant_infra)} sub="/mes" />
        <Row label="Equipos" val={fmt(g.mant_equipos)} sub="/mes" />
        <Row label="Alambrados" val={fmt(g.mant_alambrados)} sub="/mes" />
        <Row label="Total anual" val={fmt(calc.mant_anio)} bold color={C.blue} />
        <div style={{ marginTop:14 }}>
          <Sl label="Infraestructura ($/mes)" value={g.mant_infra} onChange={v=>set("mant_infra",v)} min={0} max={2000000} step={10000} />
          <Sl label="Equipos ($/mes)" value={g.mant_equipos} onChange={v=>set("mant_equipos",v)} min={0} max={2000000} step={10000} />
          <Sl label="Alambrados ($/mes)" value={g.mant_alambrados} onChange={v=>set("mant_alambrados",v)} min={0} max={1000000} step={10000} />
        </div>
      </SecCard>

      <SecCard title="🚗 Viajes" color={C.purple}>
        <Row label="Km por viaje" val={`${g.km_ida*2} km`} sub="ida y vuelta" />
        <Row label="Litros por viaje" val={`${(g.km_ida*2*g.consumo_l100km/100).toFixed(0)} L`} />
        <Row label="Costo por viaje" val={fmt((g.km_ida*2*g.consumo_l100km/100)*g.precio_gasoil+g.otros_viaje)} />
        <Row label={`${g.viajes_mes} viajes/mes`} val={`${calc.viajes_anio} viajes/anio`} />
        <Row label="Total anual viajes" val={fmt(calc.viajes_anio_dol)} bold color={C.purple} />
        <div style={{ marginTop:14 }}>
          <Sl label="Km de ida" value={g.km_ida} onChange={v=>set("km_ida",v)} min={50} max={1500} step={10} prefix="" suffix=" km" />
          <Sl label="Viajes/mes" value={g.viajes_mes} onChange={v=>set("viajes_mes",v)} min={1} max={8} step={1} prefix="" suffix=" viajes" />
          <Sl label="Consumo" value={g.consumo_l100km} onChange={v=>set("consumo_l100km",v)} min={5} max={25} step={0.5} prefix="" suffix=" L/100km" />
          <Sl label="Gasoil ($/L)" value={g.precio_gasoil} onChange={v=>set("precio_gasoil",v)} min={500} max={3000} step={50} />
          <Sl label="Peajes+otros ($/viaje)" value={g.otros_viaje} onChange={v=>set("otros_viaje",v)} min={0} max={100000} step={1000} />
        </div>
      </SecCard>

      <BtnFijar onFijar={fijar} guardado={guardado}
        resumen={`Gastos anuales: -${fmt(calc.total)}`} />
    </div>
  );
}

// --- CRÍA ---------------------------------------------------------------------
function Cria({ s, setS, R, rext, setRext, repos_ext_calc, rechazo, setRechazo, rechazo_calc, inmag }) {
  const set = (k,v) => setS(p=>({...p,[k]:Number(v)||0}));
  const setR = (k,v) => setRechazo(p=>({...p,[k]:v}));
  const flujoData = R.anios.map(a => ({ anio:a.y, Ingresos:a.ingresos, Costos:a.costos, Acumulado:a.acumulado }));
  return (
    <div style={{ paddingBottom:8 }}>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
        <KPI icon="🐄" label="Vacas meta" value={`Año ${R.anios.find(a=>a.vacas>=s.meta)?.y||"--"}`} sub={`${s.meta} cabezas`} color={C.blue} bg={C.blueL} border={`${C.blue}40`} />
        <KPI icon="⚡" label="Flujo/anio pleno" animValue={R.anios[9]?.flujo_neto||0} color={C.teal} bg={C.tealL} border={`${C.teal}40`} />
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:14 }}>
        <KPI icon="📊" label="Retorno 10 anios" animValue={R.anios[9]?.acumulado||0} color={C.purple} bg={C.purpleL} border={`${C.purple}40`} />
        <KPI icon="🎯" label="Año pleno" value={`A${R.anios[R.anios.length-1]?.vacas||0} vac.`} sub="rodeo completo" color={C.green} bg={C.greenL} border={`${C.green}40`} />
      </div>

      <SecCard title="Flujo acumulado 10 anios" color={C.green}>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={flujoData} margin={{ left:0,right:4,top:4,bottom:0 }}>
            <defs>
              <linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={C.green} stopOpacity={0.25}/>
                <stop offset="95%" stopColor={C.green} stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="anio" tick={{ fill:C.t3, fontSize:10 }} tickFormatter={v=>`A${v}`} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill:C.t3, fontSize:9 }} tickFormatter={v=>`${(v/1e6).toFixed(0)}M`} width={32} axisLine={false} tickLine={false} />
            <Tooltip content={<Tip />} />
            <ReferenceLine y={0} stroke={C.green} strokeDasharray="4 4" strokeWidth={1.5} strokeOpacity={0.6} />
            <Area type="monotone" dataKey="Acumulado" stroke={C.green} strokeWidth={2.5} fill="url(#ag)" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </SecCard>

      <SecCard title="Evolución del rodeo" color={C.blue}>
        <div style={{ display:"flex", gap:14, marginBottom:10 }}>
          {[[C.blue,"Vacas"],[C.green,"Machos"],[C.amber,"Exc. vendidas"]].map(([c,l])=>(
            <div key={l} style={{ display:"flex", alignItems:"center", gap:5 }}>
              <div style={{ width:8,height:8,borderRadius:2,background:c }} />
              <span style={{ fontSize:10,color:C.t3 }}>{l}</span>
            </div>
          ))}
        </div>
        <ResponsiveContainer width="100%" height={140}>
          <BarChart data={R.anios.map(a=>({anio:a.y,Vacas:a.vacas,Machos:a.machos,Excedente:a.vendidas_exc}))} margin={{ left:0,right:4,top:0,bottom:0 }} barGap={2}>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="anio" tick={{ fill:C.t3, fontSize:10 }} tickFormatter={v=>`A${v}`} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill:C.t3, fontSize:9 }} width={28} axisLine={false} tickLine={false} />
            <Tooltip content={<Tip />} />
            <Bar dataKey="Vacas" fill={C.blue} radius={[3,3,0,0]} opacity={0.85} />
            <Bar dataKey="Machos" fill={C.green} radius={[3,3,0,0]} opacity={0.85} />
            <Bar dataKey="Excedente" fill={C.amber} radius={[3,3,0,0]} opacity={0.85} />
          </BarChart>
        </ResponsiveContainer>
      </SecCard>

      <SecCard title="🐄 Stock actual en campo" color={C.green}>
        <Sl label="Vacas actuales" value={s.vacas_actuales} onChange={v=>set("vacas_actuales",v)} min={10} max={500} step={1} prefix="" suffix=" cab" />
        <Sl label="Meta vacas" value={s.meta} onChange={v=>set("meta",v)} min={50} max={1000} step={10} prefix="" suffix=" cab" />
        <Sl label="% destete" value={Math.round(s.destete*100)} onChange={v=>set("destete",v/100)} min={50} max={100} step={1} prefix="" suffix="%" />
        <Sl label="INMAG ($/kg)" value={s.inmag} onChange={v=>set("inmag",v)} min={2000} max={8000} step={50} />
        <Sl label="Precio novillito venta" value={s.precio_venta_nov} onChange={v=>set("precio_venta_nov",v)} min={3000} max={10000} step={100} />
        <Sl label="Precio ternera exc." value={s.precio_ternera_exc} onChange={v=>set("precio_ternera_exc",v)} min={3000} max={10000} step={100} />
        {/* Toros */}
        <div style={{ marginTop:8, paddingTop:8, borderTop:`1px solid ${C.border}` }}>
          <div style={{ fontSize:11, fontWeight:700, color:C.amber, marginBottom:6 }}>🐮 Toros</div>
          <Sl label="Toros en campo" value={rext?.toros||2} onChange={v=>setRext(p=>({...p,toros:Number(v)||0}))} min={0} max={30} step={1} prefix="" suffix=" cab" />
          <Sl label="Precio toro" value={rext?.precio_toro||2500000} onChange={v=>setRext(p=>({...p,precio_toro:Number(v)||0}))} min={500000} max={10000000} step={100000} />
        </div>
      </SecCard>

      {/* VACAS RECHAZO */}
      {(() => {
        const rc_ = rechazo_calc;
        const esFeedlot = rechazo.destino === "feedlot";
        const margenActivo = esFeedlot ? rc_.margen_feedlot_cab : rc_.margen_invernada_cab;
        const margenColor = margenActivo >= 0 ? C.green : C.red;
        const mejorOpcion = rc_.margen_feedlot_cab > rc_.margen_invernada_cab ? "feedlot" : "invernada";
        return (
          <SecCard title="🔴 Vacas rechazo / descarte" color={C.orange}>
            {/* Hero ingreso */}
            <div style={{ background: esFeedlot
                ? `linear-gradient(135deg,${C.orange},${C.red})`
                : `linear-gradient(135deg,${C.amber},${C.orange})`,
              borderRadius:14, padding:"14px 16px", marginBottom:14 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div>
                  <div style={{ fontSize:10, color:"rgba(255,255,255,0.7)", textTransform:"uppercase", letterSpacing:1 }}>
                    {esFeedlot ? "Vía feedlot → faena" : "Venta directa invernada"}
                  </div>
                  <div style={{ fontSize:26, fontWeight:800, color:"#fff", fontFamily:"'DM Mono',monospace", marginTop:2 }}>
                    {fmt(rc_.ingreso_final)}
                  </div>
                  <div style={{ fontSize:11, color:"rgba(255,255,255,0.75)", marginTop:2 }}>
                    {rechazo.cabezas} cab · {fmt(margenActivo)}/cab
                  </div>
                </div>
                <div style={{ textAlign:"right" }}>
                  {mejorOpcion !== rechazo.destino && (
                    <div style={{ background:"rgba(255,255,255,0.2)", borderRadius:8, padding:"5px 10px" }}>
                      <div style={{ fontSize:9, color:"rgba(255,255,255,0.7)" }}>mejor opción</div>
                      <div style={{ fontSize:12, fontWeight:700, color:"#fff" }}>
                        {mejorOpcion === "feedlot" ? "🥩 Feedlot" : "📦 Invernada"}
                      </div>
                      <div style={{ fontSize:11, fontWeight:700, color:"rgba(255,255,255,0.9)", fontFamily:"'DM Mono',monospace" }}>
                        +{fmt(Math.abs(rc_.margen_feedlot_cab - rc_.margen_invernada_cab))}/cab
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Toggle destino */}
            <div style={{ display:"flex", gap:8, marginBottom:14 }}>
              {["invernada","feedlot"].map(op => (
                <button key={op} onClick={() => setR("destino", op)}
                  style={{ flex:1, padding:"10px 0", borderRadius:12, border:"none", cursor:"pointer",
                    fontWeight:700, fontSize:12, transition:"all 0.18s",
                    background: rechazo.destino === op
                      ? (op === "feedlot" ? C.orange : C.amber)
                      : C.bg,
                    color: rechazo.destino === op ? "#fff" : C.t3,
                    boxShadow: rechazo.destino === op ? `0 3px 12px ${C.orange}50` : "none" }}>
                  {op === "invernada" ? "📦 Vender invernada" : "🥩 Pasar a feedlot"}
                </button>
              ))}
            </div>

            {/* Comparativa lado a lado */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:14 }}>
              {[
                { label:"Invernada", margen: rc_.margen_invernada_cab, total: rc_.ingreso_invernada, color: C.amber, op:"invernada" },
                { label:"Feedlot→Faena", margen: rc_.margen_feedlot_cab, total: rc_.ingreso_feedlot - rc_.costo_feedlot_total, color: C.orange, op:"feedlot" },
              ].map(it => (
                <div key={it.op} style={{ background: rechazo.destino===it.op ? `${it.color}18` : C.bg,
                  borderRadius:12, padding:"10px 12px",
                  border:`1.5px solid ${rechazo.destino===it.op ? it.color : C.border}` }}>
                  <div style={{ fontSize:10, color:C.t3, marginBottom:3 }}>{it.label}</div>
                  <div style={{ fontSize:14, fontWeight:800,
                    color: it.margen >= 0 ? it.color : C.red,
                    fontFamily:"'DM Mono',monospace" }}>{fmt(it.margen)}/cab</div>
                  <div style={{ fontSize:10, color:C.t3, marginTop:2 }}>total {fmt(it.total)}</div>
                </div>
              ))}
            </div>

            {/* Desglose según destino */}
            {esFeedlot ? (<>
              <Row label="Peso entrada" val={`${rechazo.peso_vivo} kg`} />
              <Row label={`Peso salida (${rechazo.dias_feedlot}d · ${rechazo.gdp_feedlot}kg/d)`}
                val={`${Math.round(rc_.peso_salida)} kg`} color={C.green} />
              <Row label="Ingreso bruto faena" val={fmt(rc_.bruto_faena)} color={C.green} />
              <Row label="Ración" val={`-${fmt(rc_.racion_cab * rechazo.cabezas)}`}
                sub={`${rechazo.kg_racion_dia}kg/d · ${rechazo.dias_feedlot}d`} color={C.red} />
              <Row label="Pastaje feedlot" val={`-${fmt(rc_.pastaje_cab * rechazo.cabezas)}`} color={C.amber} />
              <Row label="Sanidad" val={`-${fmt(rechazo.sanidad_fl * rechazo.cabezas)}`} color={C.blue} />
              <Row label="Flete + com.venta" val={`-${fmt(rechazo.cabezas * rechazo.flete_faena + rc_.bruto_faena * rechazo.comerc_venta/100)}`} color={C.purple} />
              <div style={{ display:"flex", justifyContent:"space-between", padding:"10px 0 0", borderTop:`1px solid ${C.border}`, marginTop:4 }}>
                <span style={{ fontSize:13, fontWeight:800 }}>Ingreso neto total</span>
                <span style={{ fontSize:15, fontWeight:800, fontFamily:"'DM Mono',monospace",
                  color: rc_.ingreso_final >= 0 ? C.orange : C.red }}>{fmt(rc_.ingreso_final)}</span>
              </div>
            </>) : (<>
              <Row label="Peso vivo" val={`${rechazo.peso_vivo} kg`} />
              <Row label="Ingreso bruto invernada" val={fmt(rc_.bruto_inv)} color={C.green} />
              <Row label="Com.venta + flete" val={`-${fmt(rc_.bruto_inv * rechazo.comerc_venta/100 + rechazo.cabezas * rechazo.flete_venta)}`} color={C.red} />
              <div style={{ display:"flex", justifyContent:"space-between", padding:"10px 0 0", borderTop:`1px solid ${C.border}`, marginTop:4 }}>
                <span style={{ fontSize:13, fontWeight:800 }}>Ingreso neto total</span>
                <span style={{ fontSize:15, fontWeight:800, fontFamily:"'DM Mono',monospace",
                  color: rc_.ingreso_final >= 0 ? C.amber : C.red }}>{fmt(rc_.ingreso_final)}</span>
              </div>
            </>)}

            {/* Sliders */}
            <div style={{ marginTop:16 }}>
              <Sl label="Vacas rechazo" value={rechazo.cabezas} onChange={v=>setR("cabezas",Number(v))} min={0} max={100} step={1} prefix="" suffix=" cab" />
              <Sl label="Peso vivo (kg)" value={rechazo.peso_vivo} onChange={v=>setR("peso_vivo",Number(v))} min={200} max={600} step={5} prefix="" suffix=" kg" />
              <Sl label="Comisión venta" value={rechazo.comerc_venta} onChange={v=>setR("comerc_venta",Number(v))} min={0} max={5} step={0.5} prefix="" suffix="%" />
              <Sl label="Flete ($/cab)" value={rechazo.flete_venta} onChange={v=>setR("flete_venta",Number(v))} min={0} max={20000} step={500} />
              {!esFeedlot && (
                <Sl label="Precio invernada ($/kg)" value={rechazo.precio_invernada} onChange={v=>setR("precio_invernada",Number(v))} min={2000} max={7000} step={100} />
              )}
              {esFeedlot && (<>
                <Sl label="Días feedlot" value={rechazo.dias_feedlot} onChange={v=>setR("dias_feedlot",Number(v))} min={30} max={180} step={10} prefix="" suffix=" días" />
                <Sl label="GDP feedlot (kg/día)" value={rechazo.gdp_feedlot} onChange={v=>setR("gdp_feedlot",Number(v))} min={0.4} max={1.8} step={0.05} prefix="" suffix=" kg/d" />
                <Sl label="Ración (kg MS/día)" value={rechazo.kg_racion_dia} onChange={v=>setR("kg_racion_dia",Number(v))} min={4} max={14} step={0.5} prefix="" suffix=" kg" />
                <Sl label="Precio ración ($/kg)" value={rechazo.precio_racion_kg} onChange={v=>setR("precio_racion_kg",Number(v))} min={100} max={600} step={10} />
                <Sl label="Pastaje feedlot (kg INMAG)" value={rechazo.kg_pastaje_fl} onChange={v=>setR("kg_pastaje_fl",Number(v))} min={0} max={6} step={0.5} prefix="" suffix=" kg" />
                <Sl label="Sanidad ($/cab)" value={rechazo.sanidad_fl} onChange={v=>setR("sanidad_fl",Number(v))} min={0} max={30000} step={500} />
                <Sl label="Precio faena ($/kg res)" value={rechazo.precio_faena} onChange={v=>setR("precio_faena",Number(v))} min={2000} max={8000} step={100} />
                <Sl label="Flete faena ($/cab)" value={rechazo.flete_faena} onChange={v=>setR("flete_faena",Number(v))} min={0} max={20000} step={500} />
              </>)}
            </div>
          </SecCard>
        );
      })()}

      {/* REPOSICIÓN EXTERNA */}
      {rext && repos_ext_calc && (<>
        <SecCard title="🛒 Reposición externa -- Terneras para madres" color={C.purple}>
          <div style={{ background:C.purpleL, borderRadius:10, padding:"10px 14px", marginBottom:12,
            display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div>
              <div style={{ fontSize:10, color:C.t3 }}>Inversión total terneras</div>
              <div style={{ fontSize:20, fontWeight:800, color:C.purple, fontFamily:"'DM Mono',monospace" }}>{fmt(repos_ext_calc.total_terneras)}</div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontSize:10, color:C.t3 }}>Costo/ternera (compra+recría)</div>
              <div style={{ fontSize:14, fontWeight:700, color:C.purple, fontFamily:"'DM Mono',monospace" }}>{fmt(repos_ext_calc.costo_ternera_tot)}</div>
            </div>
          </div>
          <Row label="Compra" val={fmt(rext.terneras * rext.peso_ternera * rext.precio_ternera_compra)}
            sub={`${rext.terneras} cab x ${rext.peso_ternera}kg x $${rext.precio_ternera_compra.toLocaleString("es-AR")}/kg`} color={C.red} />
          <Row label="Pastaje recría" val={fmt(rext.terneras * rext.meses_recria * rext.kg_pastaje_r * (s.inmag||4574))}
            sub={`${rext.meses_recria} meses x ${rext.kg_pastaje_r}kg INMAG`} color={C.amber} />
          <Row label="Nutriliq" val={fmt(rext.terneras * rext.meses_recria * 30 * rext.nutriliq_kg_r * rext.nutriliq_precio_r)} color={C.teal} />
          <Row label="Sanidad" val={fmt(rext.terneras * rext.sanidad_r)} color={C.blue} />
          <Row label="Flete" val={fmt(rext.terneras * rext.flete_r)} color={C.purple} />
          <Row label="Total inversión terneras" val={fmt(repos_ext_calc.total_terneras)} bold color={C.purple} />
          <div style={{ marginTop:14 }}>
            <Sl label="Terneras a comprar" value={rext.terneras} onChange={v=>setRext(p=>({...p,terneras:Number(v)}))} min={0} max={200} step={1} prefix="" suffix=" cab" />
            <Sl label="Peso entrada (kg)" value={rext.peso_ternera} onChange={v=>setRext(p=>({...p,peso_ternera:Number(v)}))} min={100} max={250} step={5} prefix="" suffix=" kg" />
            <Sl label="Precio compra ($/kg)" value={rext.precio_ternera_compra} onChange={v=>setRext(p=>({...p,precio_ternera_compra:Number(v)}))} min={3000} max={10000} step={100} />
            <Sl label="Meses recría hasta madre" value={rext.meses_recria} onChange={v=>setRext(p=>({...p,meses_recria:Number(v)}))} min={6} max={30} step={1} prefix="" suffix=" meses" />
            <Sl label="Kg pastaje/mes" value={rext.kg_pastaje_r} onChange={v=>setRext(p=>({...p,kg_pastaje_r:Number(v)}))} min={2} max={12} step={0.5} prefix="" suffix=" kg" />
            <Sl label="Sanidad $/cab" value={rext.sanidad_r} onChange={v=>setRext(p=>({...p,sanidad_r:Number(v)}))} min={0} max={30000} step={500} />
            <Sl label="Flete $/cab" value={rext.flete_r} onChange={v=>setRext(p=>({...p,flete_r:Number(v)}))} min={0} max={15000} step={500} />
          </div>
        </SecCard>

        <SecCard title="🐂 Reposición externa -- Toros" color={C.amber}>
          <div style={{ background:C.amberL, borderRadius:10, padding:"10px 14px", marginBottom:12,
            display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div>
              <div style={{ fontSize:10, color:C.t3 }}>Inversión total toros</div>
              <div style={{ fontSize:20, fontWeight:800, color:C.amber, fontFamily:"'DM Mono',monospace" }}>{fmt(repos_ext_calc.total_toros)}</div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontSize:10, color:C.t3 }}>Precio / toro</div>
              <div style={{ fontSize:14, fontWeight:700, color:C.amber, fontFamily:"'DM Mono',monospace" }}>{fmt(rext.precio_toro)}</div>
            </div>
          </div>
          <Row label="Toros a comprar" val={`${rext.toros} cab`} />
          <Row label="Precio por toro" val={fmt(rext.precio_toro)} />
          <Row label="Total inversión toros" val={fmt(repos_ext_calc.total_toros)} bold color={C.amber} />
          <div style={{ marginTop:14 }}>
            <Sl label="Toros a comprar" value={rext.toros} onChange={v=>setRext(p=>({...p,toros:Number(v)}))} min={0} max={20} step={1} prefix="" suffix=" cab" />
            <Sl label="Precio por toro ($)" value={rext.precio_toro} onChange={v=>setRext(p=>({...p,precio_toro:Number(v)}))} min={500000} max={10000000} step={100000} />
          </div>
        </SecCard>

        <div style={{ background:C.purpleL, borderRadius:14, padding:"14px 16px", marginBottom:12, border:`1.5px solid ${C.purple}30` }}>
          <div style={{ fontSize:11, color:C.t3, marginBottom:4 }}>Inversión total reposición externa / anio</div>
          <div style={{ fontSize:22, fontWeight:800, color:C.purple, fontFamily:"'DM Mono',monospace" }}>{fmt(repos_ext_calc.total)}</div>
          <div style={{ fontSize:11, color:C.t3, marginTop:4 }}>Se descuenta del flujo anual como costo de capital</div>
        </div>
      </>)}
    </div>
  );
}

// --- RECRÍA -------------------------------------------------------------------
function Recria({ rc, setRc, inmag, machos_destete, hembras_destete, peso_destete, setTab }) {
  const goTab = (id) => { setTab(id); window.scrollTo({ top:0, behavior:"instant" }); };
  const [guardado, setGuardado] = useState(false);
  const [incluir_propios, setIncluirPropios] = useState(true);
  const [destino, setDestino] = useState("feedlot");
  const set = (k,v) => setRc(p=>({...p,[k]:Number(v)||0}));
  const fijar = () => { setGuardado(true); setTimeout(()=>setGuardado(false),2000); };

  const inmag_     = inmag || 4574;
  const machos_    = machos_destete  || 33;
  const hembras_   = hembras_destete || 20;
  const peso_dest_ = peso_destete    || 170;

  const MESES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];

  // ── Cálculo stock actual ──
  const stock_ingreso_bruto = rc.stock_cab * rc.stock_peso_actual * rc.stock_precio_venta;
  const stock_comerc        = stock_ingreso_bruto * (rc.comerc_venta / 100);
  const stock_flete         = rc.stock_cab * rc.flete_venta;
  const stock_ingreso_neto  = stock_ingreso_bruto - stock_comerc - stock_flete;
  // ── Margen real (precio compra vs venta) ──
  const stock_costo_compra  = rc.stock_cab * rc.stock_peso_actual * (rc.stock_precio_compra || 3600);
  const stock_margen_bruto  = stock_ingreso_neto - stock_costo_compra;
  const stock_margen_cab    = rc.stock_cab > 0 ? stock_margen_bruto / rc.stock_cab : 0;
  const stock_mc            = stock_margen_bruto >= 0 ? C.green : C.red;

  // ── Cálculo nuevo lote ──
  const LC = useMemo(() => calcRecria({ ...rc, peso_entrada: rc.peso_entrada_comprado||180, precio_compra: rc.precio_compra||7000 }, inmag_), [rc, inmag_]);
  const LP = useMemo(() => calcRecria({ ...rc, peso_entrada: peso_dest_, precio_compra: rc.precio_venta_invernada * 1.2, comerc_compra:0, flete_compra:0 }, inmag_), [rc, inmag_, peso_dest_]);
  const LH = useMemo(() => calcRecria({ ...rc, peso_entrada: peso_dest_, precio_compra: rc.precio_ternera_hem||6000, comerc_compra:0, flete_compra:0 }, inmag_), [rc, inmag_, peso_dest_]);

  const total_margen = (rc.cabezas_comprados||35) * LC.margen_cab
    + (incluir_propios ? machos_ * LP.margen_cab : 0)
    + (incluir_propios ? hembras_ * LH.margen_cab : 0);
  const mc = total_margen >= 0 ? C.green : C.red;

  // ── Timeline datos ──
  const mes_venta  = rc.stock_mes_venta  || 4;   // 1-12
  const mes_compra = rc.stock_mes_compra || 5;    // 1-12
  // Año ganadero: cierra 30-jun (mes 6), abre 1-jul (mes 7)
  // Timeline visual: 12 meses del año ganadero jul→jun
  const anioGanadero = [7,8,9,10,11,12,1,2,3,4,5,6]; // jul..jun

  const LoteCard = ({ titulo, icon, color, l, cabezas, precio_ent_display }) => (
    <SecCard title={`${icon} ${titulo} — ${cabezas} cab.`} color={color}>
      <Row label="Ingreso bruto" val={fmt(l.ingreso_bruto)} color={C.green} />
      <Row label="Com.venta + flete" val={`-${fmt(l.comerc_v + rc.flete_venta)}`} color={C.red} />
      <Row label="Compra" val={`-${fmt(l.compra_kg)}`} sub={precio_ent_display} color={C.red} />
      <Row label="Com.compra + flete" val={`-${fmt(l.comerc_c + rc.flete_compra)}`} color={C.red} />
      <Row label="Pastaje" val={`-${fmt(l.pastaje)}`} color={C.amber} />
      <Row label="Nutriliq" val={`-${fmt(l.nutriliq)}`} color={C.purple} />
      <Row label="Sanidad" val={`-${fmt(l.sanidad)}`} color={C.blue} />
      <div style={{ display:"flex", justifyContent:"space-between", padding:"10px 0 0" }}>
        <span style={{ fontSize:13, fontWeight:800 }}>Margen / cabeza</span>
        <span style={{ fontSize:15, fontWeight:800, color:l.margen_cab>=0?C.green:C.red,
          fontFamily:"'DM Mono',monospace" }}>{fmt(l.margen_cab)}</span>
      </div>
      <div style={{ background:l.margen_cab>=0?C.greenL:C.redL, borderRadius:10, padding:"10px 14px",
        marginTop:8, display:"flex", justifyContent:"space-between" }}>
        <span style={{ fontSize:12, color:C.t2 }}>Margen lote ({cabezas} cab.)</span>
        <span style={{ fontSize:15, fontWeight:800, color:l.margen_cab>=0?C.green:C.red,
          fontFamily:"'DM Mono',monospace" }}>{fmt(l.margen_cab*cabezas)}</span>
      </div>
      <div style={{ display:"flex", gap:16, marginTop:10 }}>
        {[["GDP",`${l.gdp.toFixed(3)} kg/d`,C.t1],["ROI",`${l.roi>=0?"+":""}${l.roi.toFixed(1)}%`,l.roi>=0?C.green:C.red],
          ["Aumento",`${rc.peso_salida-(titulo.includes("comprado")||titulo.includes("Comprado")?(rc.peso_entrada_comprado||180):peso_dest_)} kg`,C.t1]
        ].map(([lab,val,col])=>(
          <div key={lab} style={{ flex:1, background:C.bg, borderRadius:8, padding:"8px 10px", textAlign:"center" }}>
            <div style={{ fontSize:10, color:C.t3 }}>{lab}</div>
            <div style={{ fontSize:13, fontWeight:700, color:col }}>{val}</div>
          </div>
        ))}
      </div>
    </SecCard>
  );

  return (
    <div style={{ paddingBottom:8 }}>

      {/* ── SECCIÓN 1: STOCK ACTUAL ── */}
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
        <div style={{ flex:1, height:1, background:C.border }}/>
        <span style={{ fontSize:11, fontWeight:700, color:C.amber, textTransform:"uppercase",
          letterSpacing:1, whiteSpace:"nowrap" }}>📦 Stock en campo hoy</span>
        <div style={{ flex:1, height:1, background:C.border }}/>
      </div>

      {/* Hero stock actual */}
      {(() => {
        // Costo nuevo lote (para mostrar balance)
        const nuevo_cab    = rc.cabezas_comprados || 35;
        const nuevo_compra = nuevo_cab * (rc.peso_entrada_comprado||180) * (rc.precio_compra||7000);
        const nuevo_come_c = nuevo_compra * ((rc.comerc_compra||3)/100);
        const nuevo_flete  = nuevo_cab * (rc.flete_compra||3000);
        const costo_nuevo  = nuevo_compra + nuevo_come_c + nuevo_flete;
        const balance      = stock_ingreso_neto - costo_nuevo;
        const balColor     = balance >= 0 ? C.green : C.red;
        return (
          <div style={{ background:`linear-gradient(135deg,#b45309,#d97706)`, borderRadius:18,
            padding:"16px 18px", marginBottom:12, position:"relative", overflow:"hidden" }}>
            <div style={{ position:"absolute", right:-10, top:-10, fontSize:60, opacity:0.12 }}>🐂</div>
            <div style={{ fontSize:10, color:"rgba(255,255,255,0.65)", textTransform:"uppercase",
              letterSpacing:1.5, marginBottom:6 }}>Venta {MESES[(mes_venta-1)]} → ingreso estimado</div>
            <div style={{ fontSize:32, fontWeight:800, color:"#fff",
              fontFamily:"'DM Mono',monospace", lineHeight:1, marginBottom:8 }}>
              {fmt(stock_ingreso_neto)}
            </div>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:10 }}>
              {[`${rc.stock_cab} cab`, `${rc.stock_peso_actual} kg/cab`, `Margen: ${fmt(stock_margen_bruto)}`].map((l,i)=>(
                <div key={i} style={{ background:"rgba(0,0,0,0.2)", borderRadius:7, padding:"4px 10px",
                  fontSize:11, color:"rgba(255,255,255,0.85)", fontWeight:600 }}>{l}</div>
              ))}
            </div>
            {/* Balance: vendo stock - compro nuevo */}
            <div style={{ background:"rgba(0,0,0,0.25)", borderRadius:10, padding:"10px 12px" }}>
              <div style={{ fontSize:9, color:"rgba(255,255,255,0.6)", textTransform:"uppercase",
                letterSpacing:1, marginBottom:6 }}>Balance: vendo stock y reponés nuevo lote</div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div style={{ fontSize:10, color:"rgba(255,255,255,0.7)" }}>
                  <div>+ Venta stock neta: <b style={{ color:"#fff" }}>{fmt(stock_ingreso_neto)}</b></div>
                  <div>− Compra {nuevo_cab} cab ({rc.peso_entrada_comprado||180}kg × ${(rc.precio_compra||7000).toLocaleString("es-AR")}): <b style={{ color:"#ffb3a7" }}>-{fmt(costo_nuevo)}</b></div>
                </div>
                <div style={{ textAlign:"right", minWidth:90 }}>
                  <div style={{ fontSize:9, color:"rgba(255,255,255,0.6)" }}>Te queda</div>
                  <div style={{ fontSize:18, fontWeight:800,
                    color: balance >= 0 ? "#86efac" : "#fca5a5",
                    fontFamily:"'DM Mono',monospace" }}>{balance>=0?"+":""}{fmt(balance)}</div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      <SecCard title="⚙ Stock actual — configuración" color={C.amber}>
        {/* Margen real */}
        {(() => {
          // Costo completo del lote en campo (lo que te costó hacerlos)
          const meses_st  = rc.stock_meses_recria || 10;
          const past_st   = (rc.stock_kg_pastaje || rc.kg_pastaje || 6) * inmag_ * meses_st * rc.stock_cab;
          const nutri_st  = (rc.stock_nutriliq_kg || rc.nutriliq_kg || 1) * (rc.stock_nutriliq_precio || rc.nutriliq_precio || 500) * meses_st * 30 * rc.stock_cab;
          const san_st    = (rc.stock_sanidad || rc.sanidad || 8000) * rc.stock_cab;
          const flete_c_st= (rc.stock_flete_compra || rc.flete_compra || 3000) * rc.stock_cab;
          const flete_v_st= (rc.stock_flete_venta  || rc.flete_venta  || 3000) * rc.stock_cab;
          const compra_kg_st = rc.stock_cab * rc.stock_peso_actual * (rc.stock_precio_compra || 3600);
          // Nota: comerc de compra ya aplicado implícitamente en precio compra; aquí mostramos comerc venta
          const come_c_st = compra_kg_st * ((rc.stock_comerc_compra || rc.comerc_compra || 3)/100);
          const come_v_st = stock_ingreso_bruto * ((rc.stock_comerc_venta || rc.comerc_venta || 3)/100);
          const costo_total_st = compra_kg_st + come_c_st + flete_c_st + past_st + nutri_st + san_st;
          const ingreso_neto_st = stock_ingreso_bruto - come_v_st - flete_v_st;
          const margen_st = ingreso_neto_st - costo_total_st;
          const mc_st = margen_st >= 0 ? C.green : C.red;
          const costo_cab_st = rc.stock_cab > 0 ? costo_total_st / rc.stock_cab : 0;
          return (
            <>
              <div style={{ background:margen_st>=0?C.greenL:C.redL, borderRadius:10,
                padding:"10px 14px", marginBottom:12, border:`1px solid ${mc_st}30` }}>
                <div style={{ fontSize:10, color:C.t3, marginBottom:6, textTransform:"uppercase", letterSpacing:0.8 }}>
                  Margen real este lote
                </div>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                  <div>
                    <div style={{ fontSize:22, fontWeight:800, color:mc_st,
                      fontFamily:"'DM Mono',monospace" }}>{fmt(margen_st)}</div>
                    <div style={{ fontSize:10, color:C.t3, marginTop:2 }}>total · {fmt(rc.stock_cab>0?margen_st/rc.stock_cab:0)}/cab</div>
                  </div>
                  <div style={{ textAlign:"right", display:"flex", flexDirection:"column", gap:3 }}>
                    <div style={{ background:"rgba(0,0,0,0.06)", borderRadius:8, padding:"4px 10px" }}>
                      <div style={{ fontSize:9, color:C.t3 }}>Vendés a</div>
                      <div style={{ fontSize:12, fontWeight:700, color:C.green, fontFamily:"'DM Mono',monospace" }}>${rc.stock_precio_venta.toLocaleString("es-AR")}/kg</div>
                    </div>
                    <div style={{ background:"rgba(0,0,0,0.06)", borderRadius:8, padding:"4px 10px" }}>
                      <div style={{ fontSize:9, color:C.t3 }}>Compraste a</div>
                      <div style={{ fontSize:12, fontWeight:700, color:C.red, fontFamily:"'DM Mono',monospace" }}>${(rc.stock_precio_compra||3600).toLocaleString("es-AR")}/kg</div>
                    </div>
                  </div>
                </div>
                {/* Desglose costos */}
                {[
                  ["Compra original",       compra_kg_st,  C.red],
                  ["Com. compra",           come_c_st,     C.red],
                  ["Flete compra",          flete_c_st,    C.red],
                  ["Pastaje recría",        past_st,       C.amber],
                  ["Nutriliq",              nutri_st,      C.purple],
                  ["Sanidad",               san_st,        C.blue],
                  ["─ Costo total",         costo_total_st,C.t1],
                  ["Ingreso bruto venta",   stock_ingreso_bruto, C.green],
                  ["Com. + flete venta",    come_v_st + flete_v_st, C.red],
                  ["Ingreso neto venta",    ingreso_neto_st, C.green],
                ].map(([l,v,c],i)=>(
                  <div key={i} style={{ display:"flex", justifyContent:"space-between",
                    padding:"3px 0", borderBottom:i===7?`2px solid ${C.border}`:`1px solid ${C.border}40`,
                    fontWeight:l.startsWith("─")?700:400 }}>
                    <span style={{ fontSize:10, color:l.startsWith("─")?C.t1:C.t3 }}>{l.replace("─ ","")}</span>
                    <span style={{ fontSize:10, fontWeight:l.startsWith("─")?800:600, color:c,
                      fontFamily:"'DM Mono',monospace" }}>{l.includes("Costo")||l.includes("Ingreso")?"":"-"}{fmt(v)}</span>
                  </div>
                ))}
                <div style={{ display:"flex", justifyContent:"space-between", marginTop:6 }}>
                  <span style={{ fontSize:12, fontWeight:800 }}>Margen neto</span>
                  <span style={{ fontSize:14, fontWeight:800, color:mc_st,
                    fontFamily:"'DM Mono',monospace" }}>{fmt(margen_st)}</span>
                </div>
                <div style={{ fontSize:10, color:C.t3, marginTop:2 }}>Costo de hacer 1 novillo: {fmt(costo_cab_st)}</div>
              </div>
              {/* Botones destino stock actual */}
              <div style={{ marginBottom:14 }}>
                <div style={{ fontSize:11, fontWeight:700, color:C.t2, marginBottom:8 }}>¿Qué hacés con el stock actual?</div>
                <div style={{ display:"flex", gap:8 }}>
                  {[["invernada","💰 Vendo invernada",C.green],["feedlot","🥩 Paso a feedlot",C.orange]].map(([val,lbl,col])=>(
                    <button key={val} onClick={()=>{ set("stock_destino_actual",val==="invernada"?0:1); goTab(val==="invernada"?"ventas":"feedlot"); }}
                      style={{ flex:1, padding:"10px 8px", borderRadius:12,
                        border:`2px solid ${(rc.stock_destino_actual||0)===(val==="invernada"?0:1)?col:C.border}`,
                        background:(rc.stock_destino_actual||0)===(val==="invernada"?0:1)?`${col}18`:C.bg,
                        color:(rc.stock_destino_actual||0)===(val==="invernada"?0:1)?col:C.t2,
                        fontSize:12, fontWeight:700, cursor:"pointer" }}>{lbl}</button>
                  ))}
                </div>
                <div style={{ marginTop:8, fontSize:11, padding:"7px 10px", borderRadius:8,
                  color:(rc.stock_destino_actual||0)===1?C.orange:C.green,
                  background:(rc.stock_destino_actual||0)===1?C.orangeL:C.greenL }}>
                  {(rc.stock_destino_actual||0)===1
                    ? "→ Se suma al módulo Feedlot y el resultado va a Ventas"
                    : "→ Venta directa · el ingreso va a Ventas"}
                </div>
              </div>
            </>
          );
        })()}
        <div style={{ marginTop:4 }}>
          <Sl label="Cabezas en campo" value={rc.stock_cab} onChange={v=>set("stock_cab",v)} min={0} max={2000} step={5} prefix="" suffix=" cab" />
          <Sl label="Peso actual (kg)" value={rc.stock_peso_actual} onChange={v=>set("stock_peso_actual",v)} min={150} max={500} step={5} prefix="" suffix=" kg" />
          <Sl label="Precio compra original ($/kg)" value={rc.stock_precio_compra||3600} onChange={v=>set("stock_precio_compra",v)} min={1000} max={12000} step={100} />
          <Sl label="Precio venta ($/kg)" value={rc.stock_precio_venta} onChange={v=>set("stock_precio_venta",v)} min={3000} max={12000} step={100} />
          <Sl label="Meses de recría (este lote)" value={rc.stock_meses_recria||10} onChange={v=>set("stock_meses_recria",v)} min={1} max={24} step={1} prefix="" suffix=" meses" />
          <Sl label="kg pastaje/mes" value={rc.stock_kg_pastaje||rc.kg_pastaje||6} onChange={v=>set("stock_kg_pastaje",v)} min={2} max={15} step={0.5} prefix="" suffix=" kg" />
          <Sl label="Nutriliq kg/día" value={rc.stock_nutriliq_kg||rc.nutriliq_kg||1} onChange={v=>set("stock_nutriliq_kg",v)} min={0} max={4} step={0.1} prefix="" suffix=" kg" />
          <Sl label="Nutriliq $/kg" value={rc.stock_nutriliq_precio||rc.nutriliq_precio||500} onChange={v=>set("stock_nutriliq_precio",v)} min={100} max={2000} step={50} />
          <Sl label="Sanidad $/cab" value={rc.stock_sanidad||rc.sanidad||8000} onChange={v=>set("stock_sanidad",v)} min={0} max={30000} step={500} />
          <Sl label="Flete compra $/cab" value={rc.stock_flete_compra||rc.flete_compra||3000} onChange={v=>set("stock_flete_compra",v)} min={0} max={15000} step={500} />
          <Sl label="Flete venta $/cab" value={rc.stock_flete_venta||rc.flete_venta||3000} onChange={v=>set("stock_flete_venta",v)} min={0} max={15000} step={500} />
          <Sl label="Com. compra %" value={rc.stock_comerc_compra||rc.comerc_compra||3} onChange={v=>set("stock_comerc_compra",v)} min={0} max={5} step={0.5} prefix="" suffix="%" />
          <Sl label="Com. venta %" value={rc.stock_comerc_venta||rc.comerc_venta||3} onChange={v=>set("stock_comerc_venta",v)} min={0} max={5} step={0.5} prefix="" suffix="%" />
        </div>
      </SecCard>

      {/* ── TIMELINE AÑO GANADERO ── */}
      <div style={{ background:C.card, borderRadius:16, padding:"14px 16px", marginBottom:12,
        border:`1.5px solid ${C.border}` }}>
        <div style={{ fontSize:12, fontWeight:700, color:C.t1, marginBottom:12 }}>
          📅 Línea de tiempo · año ganadero
        </div>

        {/* Header de meses */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(12,1fr)", gap:2, marginBottom:4 }}>
          {anioGanadero.map((m, i) => (
            <div key={i} style={{ textAlign:"center", fontSize:9, fontWeight:700,
              color: m===mes_venta?C.orange : m===mes_compra?C.green : m===6||m===7?C.blue : C.t3 }}>
              {MESES[m-1].slice(0,3)}
            </div>
          ))}
        </div>

        {/* Fila 1: Stock actual */}
        <div style={{ marginBottom:8 }}>
          <div style={{ fontSize:10, color:C.amber, fontWeight:600, marginBottom:3 }}>
            📦 Stock actual → vendo en {MESES[mes_venta-1]}
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(12,1fr)", gap:2 }}>
            {anioGanadero.map((m, i) => {
              const mes_venta_idx = anioGanadero.indexOf(mes_venta);
              const activo = i <= mes_venta_idx;
              const esVenta = m === mes_venta;
              return (
                <div key={i} style={{ height:18, borderRadius:4,
                  background: esVenta ? C.orange : activo ? `${C.amber}90` : `${C.border}50`,
                  border: esVenta ? `1.5px solid ${C.orange}` : activo ? `1px solid ${C.amber}40` : "1px solid transparent",
                  display:"flex", alignItems:"center", justifyContent:"center" }}>
                  {esVenta && <span style={{ fontSize:8, color:"#fff", fontWeight:800 }}>VENTA</span>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Fila 2: Nuevo lote con meses de recría */}
        {(() => {
          const meses_rec = rc.meses || 10;
          const compra_idx = anioGanadero.indexOf(mes_compra);
          const venta_idx_nuevo = compra_idx + meses_rec - 1;
          return (
            <div style={{ marginBottom:8 }}>
              <div style={{ fontSize:10, color:C.green, fontWeight:600, marginBottom:3 }}>
                🌱 Nuevo lote → compra {MESES[mes_compra-1]} · {meses_rec} meses recría
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(12,1fr)", gap:2 }}>
                {anioGanadero.map((m, i) => {
                  const enRecria   = i >= compra_idx && i <= Math.min(venta_idx_nuevo, 11);
                  const esCompra   = i === compra_idx;
                  const esVentaNuevo = i === Math.min(venta_idx_nuevo, 11);
                  const continua   = venta_idx_nuevo > 11 && i === 11;
                  return (
                    <div key={i} style={{ height:18, borderRadius:4,
                      background: esCompra ? C.green : esVentaNuevo && !continua ? C.blue : enRecria ? `${C.green}70` : `${C.border}50`,
                      border: esCompra ? `1.5px solid ${C.green}` : esVentaNuevo && !continua ? `1.5px solid ${C.blue}` : enRecria ? `1px solid ${C.green}40` : "1px solid transparent",
                      display:"flex", alignItems:"center", justifyContent:"center" }}>
                      {esCompra && <span style={{ fontSize:7, color:"#fff", fontWeight:800 }}>COMPRA</span>}
                      {esVentaNuevo && !continua && <span style={{ fontSize:7, color:"#fff", fontWeight:800 }}>VENTA</span>}
                      {continua && <span style={{ fontSize:8, color:C.green, fontWeight:800 }}>→</span>}
                    </div>
                  );
                })}
              </div>
              {venta_idx_nuevo > 11 && (
                <div style={{ fontSize:10, color:C.blue, marginTop:4, fontWeight:600 }}>
                  ↳ Venta en {MESES[(mes_compra - 1 + meses_rec - 1) % 12]} del año siguiente
                </div>
              )}
            </div>
          );
        })()}

        {/* Leyenda */}
        <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginTop:4 }}>
          {[[C.amber,"Stock actual"],[C.orange,"Venta stock"],[C.green,"Compra/recría"],[C.blue,"Venta nuevo lote"]].map(([c,l])=>(
            <div key={l} style={{ display:"flex", alignItems:"center", gap:4 }}>
              <div style={{ width:9, height:9, borderRadius:2, background:c }}/>
              <span style={{ fontSize:10, color:C.t3 }}>{l}</span>
            </div>
          ))}
        </div>

        {/* Selectores de mes */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:12 }}>
          {[
            { label:"Mes de venta stock", key:"stock_mes_venta", val:mes_venta, color:C.orange },
            { label:"Mes de compra nuevo", key:"stock_mes_compra", val:mes_compra, color:C.green },
          ].map(({ label, key, val, color }) => (
            <div key={key}>
              <div style={{ fontSize:10, color:C.t3, marginBottom:4 }}>{label}</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:3 }}>
                {MESES.map((m, i) => (
                  <button key={i} onClick={()=>set(key, i+1)}
                    style={{ padding:"5px 0", borderRadius:7, border:`1.5px solid ${val===i+1?color:C.border}`,
                      background:val===i+1?`${color}18`:C.bg, color:val===i+1?color:C.t3,
                      fontSize:10, fontWeight:val===i+1?700:400, cursor:"pointer" }}>
                    {m}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── SECCIÓN 2: NUEVO LOTE ── */}
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10, marginTop:8 }}>
        <div style={{ flex:1, height:1, background:C.border }}/>
        <span style={{ fontSize:11, fontWeight:700, color:C.green, textTransform:"uppercase",
          letterSpacing:1, whiteSpace:"nowrap" }}>🌱 Nuevo lote · compra {MESES[mes_compra-1]}</span>
        <div style={{ flex:1, height:1, background:C.border }}/>
      </div>

      {/* Hero nuevo lote */}
      <div style={{ background:total_margen>=0?C.greenL:C.redL, borderRadius:16, padding:"16px 18px",
        marginBottom:12, border:`1.5px solid ${mc}40` }}>
        <div style={{ fontSize:11, color:C.t3, textTransform:"uppercase", letterSpacing:1.2, marginBottom:6 }}>
          Margen proyectado · nuevo lote
        </div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end" }}>
          <div>
            <div style={{ fontSize:28, fontWeight:800, color:mc,
              fontFamily:"'DM Mono',monospace" }}>{fmt(total_margen)}</div>
            <div style={{ fontSize:11, color:C.t3, marginTop:2 }}>
              {(rc.cabezas_comprados||35) + (incluir_propios?(machos_+hembras_):0)} cabezas totales
            </div>
          </div>
          <div style={{ textAlign:"right", display:"flex", flexDirection:"column", gap:4 }}>
            <div style={{ background:"rgba(37,99,235,0.1)", borderRadius:8, padding:"5px 10px" }}>
              <div style={{ fontSize:9, color:C.t3 }}>Lote comprado</div>
              <div style={{ fontSize:13, fontWeight:700, color:C.blue,
                fontFamily:"'DM Mono',monospace" }}>{fmt(LC.margen_cab*(rc.cabezas_comprados||35))}</div>
            </div>
            {incluir_propios && <>
              <div style={{ background:"rgba(13,148,136,0.1)", borderRadius:8, padding:"5px 10px" }}>
                <div style={{ fontSize:9, color:C.t3 }}>ML machos ({machos_} cab)</div>
                <div style={{ fontSize:13, fontWeight:700, color:C.teal,
                  fontFamily:"'DM Mono',monospace" }}>{fmt(LP.margen_cab*machos_)}</div>
              </div>
              <div style={{ background:"rgba(124,58,237,0.1)", borderRadius:8, padding:"5px 10px" }}>
                <div style={{ fontSize:9, color:C.t3 }}>ML hembras ({hembras_} cab)</div>
                <div style={{ fontSize:13, fontWeight:700, color:C.purple,
                  fontFamily:"'DM Mono',monospace" }}>{fmt(LH.margen_cab*hembras_)}</div>
              </div>
            </>}
          </div>
        </div>
      </div>

      {/* Destino al terminar recría */}
      <div style={{ background:C.card, borderRadius:14, padding:"12px 16px", marginBottom:12,
        border:`1.5px solid ${C.border}` }}>
        <div style={{ fontSize:12, fontWeight:700, color:C.t2, marginBottom:10 }}>
          Al terminar los {rc.meses} meses → ¿qué hacés?
        </div>
        <div style={{ display:"flex", gap:8 }}>
          {[["vender","💰 Vendo invernada",C.green],["feedlot","🥩 Paso a feedlot",C.orange]].map(([val,lbl,col])=>(
            <button key={val} onClick={()=>{ set("destino_nuevo_lote", val==="vender"?0:1); goTab(val==="vender"?"ventas":"feedlot"); }}
              style={{ flex:1, padding:"10px 8px", borderRadius:12,
                border:`2px solid ${(rc.destino_nuevo_lote||0)===(val==="vender"?0:1)?col:C.border}`,
                background:(rc.destino_nuevo_lote||0)===(val==="vender"?0:1)?`${col}18`:C.bg,
                color:(rc.destino_nuevo_lote||0)===(val==="vender"?0:1)?col:C.t2,
                fontSize:12, fontWeight:700, cursor:"pointer" }}>{lbl}</button>
          ))}
        </div>
        <div style={{ marginTop:8, fontSize:11, borderRadius:8, padding:"8px 10px",
          color:(rc.destino_nuevo_lote||0)===1?C.teal:C.green,
          background:(rc.destino_nuevo_lote||0)===1?C.tealL:C.greenL }}>
          {(rc.destino_nuevo_lote||0)===1
            ? "→ Pasando a Feedlot · el margen final va a Ventas"
            : "→ Venta directa como novillito recriado · se refleja en Ventas"}
        </div>
      </div>

      {/* Toggle marca líquida */}
      <div style={{ background:C.card, borderRadius:14, padding:"12px 16px", marginBottom:12,
        border:`1.5px solid ${C.border}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <div style={{ fontSize:13, fontWeight:700, color:C.t1 }}>Incluir marca líquida</div>
          <div style={{ fontSize:11, color:C.t3, marginTop:2 }}>
            {machos_} machos + {hembras_} hembras · {peso_dest_} kg · nacidos en campo
          </div>
        </div>
        <div onClick={()=>setIncluirPropios(v=>!v)}
          style={{ width:44, height:26, borderRadius:13, cursor:"pointer", transition:"all .2s",
            background:incluir_propios?C.green:C.border, position:"relative", flexShrink:0 }}>
          <div style={{ position:"absolute", top:3, left:incluir_propios?21:3, width:20, height:20,
            borderRadius:10, background:"#fff", transition:"all .2s",
            boxShadow:"0 1px 4px rgba(0,0,0,0.2)" }} />
        </div>
      </div>

      <LoteCard titulo="Lote comprado" icon="🛒" color={C.blue} l={LC} cabezas={rc.cabezas_comprados||35}
        precio_ent_display={`${rc.peso_entrada_comprado||180}kg x $${(rc.precio_compra||7000).toLocaleString("es-AR")}`} />
      {incluir_propios && <>
        <LoteCard titulo="Marca liquida - Machos" icon="🐂" color={C.teal} l={LP} cabezas={machos_}
          precio_ent_display={`${peso_dest_}kg — nacidos en campo`} />
        <LoteCard titulo="Marca liquida - Hembras" icon="🐄" color={C.purple} l={LH} cabezas={hembras_}
          precio_ent_display={`${peso_dest_}kg — nacidas en campo`} />
      </>}

      {incluir_propios && (
        <SecCard title="⚙ Supuestos marca líquida" color={C.teal}>
          <div style={{ background:C.tealL, borderRadius:8, padding:"8px 12px", marginBottom:10,
            fontSize:11, color:C.teal }}>
            Machos y hembras usan los mismos supuestos de recría (peso salida, meses, pastaje).
          </div>
          <Sl label="Precio ternera hembra ($/kg)" value={rc.precio_ternera_hem||6000}
            onChange={v=>set("precio_ternera_hem",v)} min={3000} max={10000} step={100} />
        </SecCard>
      )}

      <SecCard title="⚙ Supuestos lote comprado" color={C.blue}>
        <Sl label="Cabezas" value={rc.cabezas_comprados||35} onChange={v=>set("cabezas_comprados",v)} min={0} max={1000} step={1} prefix="" suffix=" cab" />
        <Sl label="Peso entrada (kg)" value={rc.peso_entrada_comprado||180} onChange={v=>set("peso_entrada_comprado",v)} min={120} max={280} step={5} prefix="" suffix=" kg" />
        <Sl label="Precio compra ($/kg)" value={rc.precio_compra||7000} onChange={v=>set("precio_compra",v)} min={4000} max={15000} step={100} />
        <Sl label="Peso salida (kg)" value={rc.peso_salida} onChange={v=>set("peso_salida",v)} min={250} max={500} step={5} prefix="" suffix=" kg" />
        <Sl label="Precio venta invernada ($/kg)" value={rc.precio_venta_invernada} onChange={v=>set("precio_venta_invernada",v)} min={3000} max={12000} step={100} />
        <Sl label="Meses de recría" value={rc.meses} onChange={v=>set("meses",v)} min={4} max={24} step={1} prefix="" suffix=" meses" />
        <Sl label="Kg pastaje/mes" value={rc.kg_pastaje} onChange={v=>set("kg_pastaje",v)} min={2} max={15} step={0.5} prefix="" suffix=" kg" />
        <Sl label="Nutriliq kg/día" value={rc.nutriliq_kg} onChange={v=>set("nutriliq_kg",v)} min={0} max={4} step={0.1} prefix="" suffix=" kg" />
        <Sl label="Nutriliq $/kg" value={rc.nutriliq_precio} onChange={v=>set("nutriliq_precio",v)} min={100} max={2000} step={50} />
        <Sl label="Sanidad $/cab" value={rc.sanidad} onChange={v=>set("sanidad",v)} min={0} max={30000} step={500} />
        <Sl label="Flete compra $/cab" value={rc.flete_compra} onChange={v=>set("flete_compra",v)} min={0} max={15000} step={500} />
        <Sl label="Flete venta $/cab" value={rc.flete_venta} onChange={v=>set("flete_venta",v)} min={0} max={15000} step={500} />
        <Sl label="Com. compra %" value={rc.comerc_compra} onChange={v=>set("comerc_compra",v)} min={0} max={5} step={0.5} prefix="" suffix="%" />
        <Sl label="Com. venta %" value={rc.comerc_venta} onChange={v=>set("comerc_venta",v)} min={0} max={5} step={0.5} prefix="" suffix="%" />
      </SecCard>

      <BtnFijar onFijar={fijar} guardado={guardado}
        resumen={`Stock: ${fmt(stock_ingreso_neto)} · Nuevo lote: ${fmt(total_margen)}`} />
    </div>
  );
}

function BarrasPrecios({ items }) {
  const max = Math.max(...items.map(x => x.val)) * 1.1;
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
      {items.map((b, i) => (
        <div key={i}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
            <span style={{ fontSize:10, color:C.t2 }}>{b.label}</span>
            <span style={{ fontSize:11, fontFamily:"'DM Mono',monospace", fontWeight:700, color:b.color }}>
              ${Math.round(b.val).toLocaleString("es-AR")}/kg
            </span>
          </div>
          <div style={{ height:8, borderRadius:4, background:C.border, overflow:"hidden" }}>
            <div style={{ height:"100%", width:`${(b.val/max*100).toFixed(1)}%`, background:b.color, borderRadius:4, opacity:0.8 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// --- FEEDLOT ------------------------------------------------------------------
function Feedlot({ fl, setFl, inmag, cabezas_recria, peso_salida_recria, vacas_descarte, FL_cabezas, FL_margen, FL_calc }) {
  const [guardado, setGuardado] = useState(false);
  const set    = (k,v) => setFl(p=>({...p,[k]:Number(v)||0}));
  const toggle = (k)   => setFl(p=>({...p,[k]:!p[k]}));
  const fijar  = () => { setGuardado(true); setTimeout(()=>setGuardado(false),2000); };

  const inmag_ = inmag || 4574;
  const cabezas_total = FL_cabezas ?? ((fl.fuente_recria?(cabezas_recria||35):0)+(fl.fuente_vacas?(vacas_descarte||15):0)+(fl.fuente_externos?(fl.cabezas_externos||0):0));

  const FL = FL_calc ?? useMemo(() => calcFeedlot(fl, inmag_), [fl, inmag_]);
  const margen_total = FL_margen ?? (FL.margen_cab * cabezas_total);
  const mc = margen_total >= 0 ? C.orange : C.red;

  const items_costo = [
    { label:"Compra animal", valor:FL.costo_entrada, color:C.red },
    { label:"Ración",        valor:FL.costo_racion_cab, color:C.amber },
    { label:"Pastaje",       valor:FL.pastaje, color:C.green },
    { label:"Sanidad",       valor:FL.sanidad_fl, color:C.blue },
    { label:"Fletes+Com.",   valor:FL.flete_fl + FL.comerc_v, color:C.purple },
  ];

  return (
    <div style={{ paddingBottom:8 }}>
      {/* Hero */}
      <div style={{ background:`linear-gradient(135deg,${C.orange},${C.amber})`, borderRadius:20,
        padding:"20px 18px", marginBottom:14 }}>
        <div style={{ fontSize:11, color:"rgba(255,255,255,0.7)", textTransform:"uppercase", letterSpacing:1.5, marginBottom:4 }}>Feedlot -- Mix ración + pasto</div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end" }}>
          <div>
            <div style={{ fontSize:26, fontWeight:800, color:"#fff", fontFamily:"'DM Mono',monospace" }}>{fmt(margen_total)}</div>
            <div style={{ fontSize:11, color:"rgba(255,255,255,0.7)", marginTop:2 }}>margen total . {cabezas_total} cabezas</div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:18, fontWeight:700, color:"#fff", fontFamily:"'DM Mono',monospace" }}>{fmt(FL.margen_cab)}</div>
            <div style={{ fontSize:10, color:"rgba(255,255,255,0.7)" }}>por cabeza</div>
            <div style={{ fontSize:12, fontWeight:600, color:"#fff", marginTop:4 }}>{fl.dias_feedlot} días . {FL.gdp_fl.toFixed(3)} kg/d GDP</div>
          </div>
        </div>
      </div>

      {/* Fuentes de animales */}
      <SecCard title="🐂 Animales que entran al feedlot" color={C.orange}>
        {[
          { k:"recria", label:"Recría terminada", sub:`${cabezas_recria||35} cab . ${peso_salida_recria||340}kg`, color:C.green },
          { k:"vacas",  label:"Vacas de descarte", sub:`${vacas_descarte||0} cab . engordar y mandar a faena`, color:C.red },
          { k:"externos", label:"Compra externa feedlot", sub:`${fl.cabezas_externos} cab adicionales`, color:C.orange },
        ].map(item => (
          <div key={item.k} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 0", borderBottom:`1px solid ${C.border}` }}>
            <div>
              <div style={{ fontSize:13, fontWeight:600, color:C.t1 }}>{item.label}</div>
              <div style={{ fontSize:11, color:C.t3 }}>{item.sub}</div>
            </div>
            <div onClick={()=>toggle('fuente_'+item.k)}
              style={{ width:44, height:26, borderRadius:13, cursor:"pointer", transition:"all .2s",
                background:fl['fuente_'+item.k]?item.color:C.border, position:"relative", flexShrink:0 }}>
              <div style={{ position:"absolute", top:3, left:fl['fuente_'+item.k]?21:3, width:20, height:20,
                borderRadius:10, background:"#fff", transition:"all .2s", boxShadow:"0 1px 4px rgba(0,0,0,0.2)" }} />
            </div>
          </div>
        ))}
        {fl.fuente_externos && (
          <div style={{ marginTop:10 }}>
            <Sl label="Cabezas externas" value={fl.cabezas_externos} onChange={v=>set("cabezas_externos",v)} min={0} max={500} step={5} prefix="" suffix=" cab" />
          </div>
        )}
        <div style={{ marginTop:10, padding:"8px 10px", background:C.orangeL, borderRadius:8, fontSize:11, color:C.orange, fontWeight:600 }}>
          Total: {cabezas_total} cabezas -> Margen: {fmt(margen_total)}
        </div>
      </SecCard>

      {/* Resultado por cabeza */}
      <SecCard title="Resultado por cabeza" color={C.orange}>
        <Row label="Ingreso bruto faena" val={fmt(FL.ingreso_bruto)} color={C.green} />
        <Row label="Com. venta + flete salida" val={`-${fmt(FL.comerc_v + fl.flete_salida_fl)}`} color={C.red} />
        <Row label="Ingreso neto" val={fmt(FL.ingreso_neto)} bold color={C.green} />
        <Row label="Costo entrada animal" val={`-${fmt(FL.costo_entrada)}`} color={C.red} />
        <Row label="Com. compra + flete entrada" val={`-${fmt(FL.comerc_c + fl.flete_entrada_fl)}`} color={C.red} />
        <Row label={`Ración (${fl.kg_racion_dia}kg/día x ${fl.dias_feedlot}d)`} val={`-${fmt(FL.costo_racion_cab)}`} color={C.amber} />
        <Row label="Pastaje" val={`-${fmt(FL.pastaje)}`} color={C.green} />
        <Row label="Sanidad feedlot" val={`-${fmt(FL.sanidad_fl)}`} color={C.blue} />
        <Row label="Costo total" val={`-${fmt(FL.costo_total)}`} bold color={C.red} />
        <div style={{ display:"flex", justifyContent:"space-between", padding:"10px 0 0" }}>
          <span style={{ fontSize:14, fontWeight:800 }}>Margen neto / cab</span>
          <span style={{ fontSize:16, fontWeight:800, color:FL.margen_cab>=0?C.orange:C.red, fontFamily:"'DM Mono',monospace" }}>{fmt(FL.margen_cab)}</span>
        </div>
        <div style={{ display:"flex", gap:10, marginTop:12 }}>
          <div style={{ flex:1, background:C.bg, borderRadius:8, padding:"8px 10px", textAlign:"center" }}>
            <div style={{ fontSize:10, color:C.t3 }}>GDP</div>
            <div style={{ fontSize:13, fontWeight:700 }}>{FL.gdp_fl.toFixed(3)} kg/d</div>
          </div>
          <div style={{ flex:1, background:C.bg, borderRadius:8, padding:"8px 10px", textAlign:"center" }}>
            <div style={{ fontSize:10, color:C.t3 }}>ROI</div>
            <div style={{ fontSize:13, fontWeight:700, color:FL.roi>=0?C.orange:C.red }}>{FL.roi>=0?"+":""}{FL.roi.toFixed(1)}%</div>
          </div>
          <div style={{ flex:1, background:C.bg, borderRadius:8, padding:"8px 10px", textAlign:"center" }}>
            <div style={{ fontSize:10, color:C.t3 }}>Aumento</div>
            <div style={{ fontSize:13, fontWeight:700 }}>{fl.peso_salida_fl - fl.peso_entrada_fl} kg</div>
          </div>
        </div>
      </SecCard>

      {/* PANEL RENTABILIDAD */}
      <SecCard title="📐 Análisis de rentabilidad" color={FL.margen_cab>=0?C.orange:C.red}>
        {/* Semáforo de diagnóstico */}
        {FL.dif_precio < 0 && (
          <div style={{ background:C.redL, borderRadius:10, padding:"10px 12px", marginBottom:12,
            border:`1px solid ${C.red}30`, fontSize:11, color:C.red }}>
            ⚠ <b>Diferencial negativo:</b> compras a <b>${fl.precio_entrada_fl.toLocaleString("es-AR")}/kg</b>{" "}
            y vendes a <b>${fl.precio_faena.toLocaleString("es-AR")}/kg</b> -&gt;{" "}
            perdes <b>${Math.abs(FL.dif_precio).toLocaleString("es-AR")}/kg</b> sobre el animal base.
          </div>
        )}

        {/* Las 3 métricas clave en cards grandes */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:14 }}>
          {[
            { label:"Costo kg producido", value:fmt(FL.costo_kg_prod), sub:"racion+pastaje / kg ganados", color:C.amber,
              ok: FL.costo_kg_prod < fl.precio_faena },
            { label:"GDP kg/dia", value:`${FL.gdp_fl.toFixed(3)}`, sub:`${FL.kg_ganados} kg en ${fl.dias_feedlot} dias`, color:C.blue,
              ok: FL.gdp_fl >= 1.0 },
            { label:"Precio venta/kg", value:`$${fl.precio_faena.toLocaleString("es-AR")}`, sub:"faena", color:C.green,
              ok: fl.precio_faena > fl.precio_entrada_fl },
          ].map((m,i) => (
            <div key={i} style={{ background: m.ok ? C.greenL : C.redL, borderRadius:12, padding:"10px 8px",
              border:`1.5px solid ${m.ok?C.green:C.red}30`, textAlign:"center" }}>
              <div style={{ fontSize:9, color:C.t3, whiteSpace:"pre-line", marginBottom:4, lineHeight:1.3 }}>{m.label}</div>
              <div style={{ fontSize:16, fontWeight:800, color:m.ok?C.green:C.red, fontFamily:"'DM Mono',monospace" }}>{m.value}</div>
              <div style={{ fontSize:9, color:C.t3, whiteSpace:"pre-line", marginTop:3, lineHeight:1.3 }}>{m.sub}</div>
            </div>
          ))}
        </div>

        {/* Relación clave: costo producción vs precio venta */}
        <div style={{ background:C.bg, borderRadius:10, padding:"12px 14px", marginBottom:10 }}>
          <div style={{ fontSize:11, fontWeight:700, color:C.t2, marginBottom:8 }}>Costo de producción vs precio de venta</div>
          <BarrasPrecios
            items={[
              { label:"Precio compra entrada", val:fl.precio_entrada_fl, color:C.red },
              { label:"Costo kg producido",    val:FL.costo_kg_prod,    color:C.amber },
              { label:"Precio venta faena",    val:fl.precio_faena,     color:C.green },
            ]}
          />
        </div>

        {/* Precio break-even */}
        <div style={{ background: fl.precio_faena >= FL.precio_be ? C.greenL : C.redL, borderRadius:10, padding:"10px 14px",
          border:`1px solid ${fl.precio_faena >= FL.precio_be ? C.green : C.red}30`,
          display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontSize:11, fontWeight:700, color:C.t1 }}>Precio mínimo de faena para break-even</div>
            <div style={{ fontSize:10, color:C.t3, marginTop:2 }}>
              {fl.precio_faena >= FL.precio_be
                ? `v Vendés ${fmt(fl.precio_faena - FL.precio_be)}/kg por encima del mínimo`
                : `x Necesitás ${fmt(FL.precio_be - fl.precio_faena)}/kg más para cubrir costos`}
            </div>
          </div>
          <div style={{ textAlign:"right", flexShrink:0, marginLeft:10 }}>
            <div style={{ fontSize:20, fontWeight:800, fontFamily:"'DM Mono',monospace",
              color: fl.precio_faena >= FL.precio_be ? C.green : C.red }}>${Math.round(FL.precio_be).toLocaleString("es-AR")}</div>
            <div style={{ fontSize:9, color:C.t3 }}>/ kg</div>
          </div>
        </div>
      </SecCard>

      <SecCard title="Distribución costos" color={C.border}>
        <BarraCostos items={items_costo} total={FL.costo_total} />
      </SecCard>

      <SecCard title="⚙ Supuestos feedlot" color={C.orange}>
        <Sl label="Peso entrada (kg)" value={fl.peso_entrada_fl} onChange={v=>set("peso_entrada_fl",v)} min={200} max={500} step={5} prefix="" suffix=" kg" />
        <Sl label="Precio entrada ($/kg)" value={fl.precio_entrada_fl} onChange={v=>set("precio_entrada_fl",v)} min={2000} max={8000} step={100} />
        <Sl label="Peso salida faena (kg)" value={fl.peso_salida_fl} onChange={v=>set("peso_salida_fl",v)} min={350} max={650} step={5} prefix="" suffix=" kg" />
        <Sl label="Precio faena ($/kg)" value={fl.precio_faena} onChange={v=>set("precio_faena",v)} min={2000} max={8000} step={100} />
        <Sl label="Días en feedlot" value={fl.dias_feedlot} onChange={v=>set("dias_feedlot",v)} min={60} max={300} step={5} prefix="" suffix=" días" />
        <Sl label="Ración kg MS/día" value={fl.kg_racion_dia} onChange={v=>set("kg_racion_dia",v)} min={3} max={15} step={0.5} prefix="" suffix=" kg" />
        <Sl label="Precio ración ($/kg)" value={fl.precio_racion_kg} onChange={v=>set("precio_racion_kg",v)} min={100} max={1000} step={10} />
        <Sl label="Kg pastaje/mes feedlot" value={fl.kg_pastaje_fl} onChange={v=>set("kg_pastaje_fl",v)} min={0} max={10} step={0.5} prefix="" suffix=" kg" />
        <Sl label="Sanidad $/cab" value={fl.sanidad_fl} onChange={v=>set("sanidad_fl",v)} min={0} max={30000} step={500} />
        <Sl label="Flete entrada $/cab" value={fl.flete_entrada_fl} onChange={v=>set("flete_entrada_fl",v)} min={0} max={15000} step={500} />
        <Sl label="Flete salida $/cab" value={fl.flete_salida_fl} onChange={v=>set("flete_salida_fl",v)} min={0} max={15000} step={500} />
        <Sl label="Com. compra %" value={fl.comerc_compra_fl} onChange={v=>set("comerc_compra_fl",v)} min={0} max={5} step={0.5} prefix="" suffix="%" />
        <Sl label="Com. venta %" value={fl.comerc_venta_fl} onChange={v=>set("comerc_venta_fl",v)} min={0} max={5} step={0.5} prefix="" suffix="%" />
      </SecCard>

      <BtnFijar onFijar={fijar} guardado={guardado}
        resumen={`${cabezas_total} cab . ${fmt(FL.margen_cab)}/cab . Total: ${fmt(margen_total)}`} />
    </div>
  );
}


// --- STOCK --------------------------------------------------------------------
function Stock({ s, rc, fl, pt, rext, R, inmag }) {
  const im = inmag || 4574;
  const anio0 = R.anios[0];

  // Precios reales de las pestañas (no de mercado)
  const P = {
    vaca:      s?.precio_venta_nov  || 5100,   // novillito como proxy
    novillito: rc?.precio_venta_invernada || 5500,
    ternero:   rc?.precio_compra    || 7000,   // precio compra ternero = ref ternero
    ternera:   s?.precio_ternera_exc || 6349,
    toro:      rext?.precio_toro ? rext.precio_toro / 600 : 4000, // $/cab → $/kg (~600kg)
    novilloFL: fl?.precio_entrada_fl || 3800,
  };

  const propio = [
    { cat:"🐄 Vacas en producción",  cab: s.vacas_actuales,                peso: 430, precio: P.vaca,      color: C.green  },
    { cat:"🐂 Novillos en recría",   cab: rc.cabezas_comprados||35,         peso: rc.peso_salida||340,     precio: P.novillito,  color: C.blue   },
    { cat:"🐣 Terneros destete",     cab: anio0?.machos||33,                 peso: s.peso_entrada_mac||170, precio: P.ternero,    color: C.teal   },
    { cat:"🐮 Terneras reposición",  cab: rext?.terneras||30,               peso: rext?.peso_ternera||160, precio: P.ternera,    color: C.purple },
    { cat:"🐂 Toros",               cab: rext?.toros||2,                   peso: 600,                     precio: P.toro,       color: C.amber  },
  ];

  const tercero = [
    { cat:"🐄 Vacas (tercero)",      cab: pt.vacas_tercero||100,    peso: 420, precio: P.vaca,      color: C.green  },
    { cat:"🐂 Novillos (tercero)",   cab: pt.novillos_tercero||145, peso: 310, precio: P.novillito, color: C.blue   },
    { cat:"🐣 Terneros (tercero)",   cab: pt.terneros_tercero||90,  peso: 160, precio: P.ternero,   color: C.teal   },
    { cat:"🐮 Toros (tercero)",      cab: pt.toros_tercero||0,      peso: 580, precio: P.toro,      color: C.amber  },
  ];

  const totalPropCab  = propio.reduce((a,x)=>a+x.cab,0);
  const totalPropKg   = propio.reduce((a,x)=>a+x.cab*x.peso,0);
  const totalPropVal  = propio.reduce((a,x)=>a+x.cab*x.peso*x.precio,0);
  const totalTercCab  = tercero.reduce((a,x)=>a+x.cab,0);
  const totalTercKg   = tercero.reduce((a,x)=>a+x.cab*x.peso,0);
  const totalTercVal  = tercero.reduce((a,x)=>a+x.cab*x.peso*x.precio,0);
  const totalCab      = totalPropCab + totalTercCab;
  const totalKg       = totalPropKg  + totalTercKg;
  const totalVal      = totalPropVal + totalTercVal;

  const StockTable = ({ rows, title, color }) => (
    <SecCard title={title} color={color}>
      <div style={{ display:"grid", gridTemplateColumns:"1.6fr 0.6fr 0.8fr 1fr", padding:"6px 0",
        fontSize:9, color:C.t3, textTransform:"uppercase", letterSpacing:0.8, fontWeight:700,
        borderBottom:`1px solid ${C.border}` }}>
        {["Categoría","Cab.","Kg tot.","Valor"].map((h,i)=>(
          <span key={h} style={{ textAlign:i===0?"left":"right" }}>{h}</span>
        ))}
      </div>
      {rows.filter(r=>r.cab>0).map((row, i) => (
        <div key={i} style={{ display:"grid", gridTemplateColumns:"1.6fr 0.6fr 0.8fr 1fr",
          padding:"9px 0", borderBottom:`1px solid ${C.border}`,
          alignItems:"center" }}>
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <div style={{ width:8, height:8, borderRadius:2, background:row.color, flexShrink:0 }} />
            <span style={{ fontSize:11, color:C.t1, fontWeight:600 }}>{row.cat}</span>
          </div>
          <span style={{ fontSize:12, fontFamily:"'DM Mono',monospace", color:C.t2, textAlign:"right" }}>{row.cab}</span>
          <span style={{ fontSize:11, fontFamily:"'DM Mono',monospace", color:C.t3, textAlign:"right" }}>{Math.round(row.cab*row.peso/1000).toFixed(0)}t</span>
          <span style={{ fontSize:12, fontFamily:"'DM Mono',monospace", color:row.color, fontWeight:700, textAlign:"right" }}>{fmt(row.cab*row.peso*row.precio)}</span>
        </div>
      ))}
      <div style={{ display:"grid", gridTemplateColumns:"1.6fr 0.6fr 0.8fr 1fr", padding:"10px 0 0" }}>
        <span style={{ fontSize:11, fontWeight:800, color:C.t1 }}>TOTAL</span>
        <span style={{ fontSize:12, fontFamily:"'DM Mono',monospace", fontWeight:700, textAlign:"right" }}>{rows.reduce((a,x)=>a+x.cab,0)}</span>
        <span style={{ fontSize:11, fontFamily:"'DM Mono',monospace", color:C.t3, textAlign:"right" }}>{Math.round(rows.reduce((a,x)=>a+x.cab*x.peso,0)/1000).toFixed(0)}t</span>
        <span style={{ fontSize:12, fontFamily:"'DM Mono',monospace", fontWeight:800, color:color, textAlign:"right" }}>{fmt(rows.reduce((a,x)=>a+x.cab*x.peso*x.precio,0))}</span>
      </div>
    </SecCard>
  );

  return (
    <div style={{ paddingBottom:8 }}>
      {/* Hero total */}
      <div style={{ background:`linear-gradient(135deg,${C.blue},${C.purple})`, borderRadius:20,
        padding:"20px 18px", marginBottom:14, position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", right:-16, top:-16, fontSize:72, opacity:0.1 }}>📋</div>
        <div style={{ fontSize:11, color:"rgba(255,255,255,0.65)", textTransform:"uppercase", letterSpacing:1.5, marginBottom:6 }}>Stock total en campo</div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end", marginBottom:10 }}>
          <div>
            <div style={{ fontSize:28, fontWeight:800, color:"#fff" }}>{totalCab} cab.</div>
            <div style={{ fontSize:12, color:"rgba(255,255,255,0.65)", marginTop:2 }}>{Math.round(totalKg/1000).toFixed(0)} toneladas vivas</div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:11, color:"rgba(255,255,255,0.65)" }}>Valor a mercado</div>
            <div style={{ fontSize:20, fontWeight:800, color:"#fff", fontFamily:"'DM Mono',monospace" }}>{fmt(totalVal)}</div>
          </div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <div style={{ flex:1, background:"rgba(255,255,255,0.15)", borderRadius:10, padding:"8px 10px", textAlign:"center" }}>
            <div style={{ fontSize:9, color:"rgba(255,255,255,0.65)" }}>Propio</div>
            <div style={{ fontSize:14, fontWeight:700, color:"#fff" }}>{totalPropCab} cab.</div>
            <div style={{ fontSize:10, color:"rgba(255,255,255,0.55)" }}>{fmt(totalPropVal)}</div>
          </div>
          <div style={{ flex:1, background:"rgba(255,255,255,0.15)", borderRadius:10, padding:"8px 10px", textAlign:"center" }}>
            <div style={{ fontSize:9, color:"rgba(255,255,255,0.65)" }}>Pastaje 3°</div>
            <div style={{ fontSize:14, fontWeight:700, color:"#fff" }}>{totalTercCab} cab.</div>
            <div style={{ fontSize:10, color:"rgba(255,255,255,0.55)" }}>{fmt(totalTercVal)}</div>
          </div>
          <div style={{ flex:1, background:"rgba(255,255,255,0.15)", borderRadius:10, padding:"8px 10px", textAlign:"center" }}>
            <div style={{ fontSize:9, color:"rgba(255,255,255,0.65)" }}>INMAG</div>
            <div style={{ fontSize:14, fontWeight:700, color:"#fff" }}>${(im/1000).toFixed(1)}k</div>
            <div style={{ fontSize:10, color:"rgba(255,255,255,0.55)" }}>/kg vivo</div>
          </div>
        </div>
      </div>

      <StockTable rows={propio}  title="🏠 Hacienda propia"         color={C.blue}   />
      <StockTable rows={tercero} title="🤝 Pastaje de terceros"      color={C.teal}   />

      {/* Nota precios */}
      <div style={{ background:C.card, borderRadius:12, padding:"12px 14px", border:`1.5px solid ${C.border}` }}>
        <div style={{ fontSize:10, color:C.t3, marginBottom:8, fontWeight:700, textTransform:"uppercase", letterSpacing:1 }}>Precios usados (de tus pestañas)</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
          {[
            ["Vaca/novillito", P.vaca, C.green, "Recría → precio venta"],
            ["Novillito salida", P.novillito, C.blue, "Recría → precio venta"],
            ["Ternero compra", P.ternero, C.teal, "Recría → precio compra"],
            ["Ternera exc.", P.ternera, C.purple, "Cría → precio ternera"],
            ["Toro ($/kg aprox)", Math.round(P.toro), C.amber, "Cría → precio toro/600kg"],
          ].map(([l,v,c,src])=>(
            <div key={l} style={{ padding:"5px 8px", background:C.bg, borderRadius:6 }}>
              <div style={{ display:"flex", justifyContent:"space-between" }}>
                <span style={{ fontSize:10, color:C.t2 }}>{l}</span>
                <span style={{ fontSize:10, fontFamily:"'DM Mono',monospace", color:c, fontWeight:700 }}>${Math.round(v).toLocaleString("es-AR")}/kg</span>
              </div>
              <div style={{ fontSize:9, color:C.t3 }}>{src}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


// --- RESULTADO ----------------------------------------------------------------
function Resultado({ R, s, rc, fl, gastos_calc, recria_margen, feedlot_margen, feedlot_cabezas, pastaje_margen, repos_costo, rechazo_neto }) {
  const anio0  = R?.anios?.[0];
  const anio10 = R?.anios?.[R.anios.length-1];
  const acum   = R?.anios?.reduce((a,x)=>a+(x.flujo_neto||0), 0) || 0;
  const mc1    = (anio0?.flujo_neto||0)  >= 0 ? C.green : C.red;
  const mcP    = (anio10?.flujo_neto||0) >= 0 ? C.green : C.red;
  const mcA    = acum >= 0 ? C.green : C.red;

  // ── Venta stock recría (ingreso puntual año 1, no incluido en calcCria) ──
  const stock_va_feedlot  = (rc?.stock_destino_actual||0) === 1;
  const st_cab   = rc?.stock_cab || 0;
  const st_bruto = st_cab * (rc?.stock_peso_actual||260) * (rc?.stock_precio_venta||5500);
  const st_come  = st_bruto * ((rc?.stock_comerc_venta||rc?.comerc_venta||3)/100);
  const st_flete = st_cab * (rc?.stock_flete_venta||rc?.flete_venta||3000);
  const st_neto  = stock_va_feedlot ? 0 : (st_bruto - st_come - st_flete);

  // ── Desglose correcto del año 1 ──
  // anio0.ingresos = ing_exc(terneras) + recria_margen + feedlot_margen + pastaje + rechazo
  const ing_terneras = anio0?.vendidas_exc > 0
    ? anio0.vendidas_exc * (s?.precio_ternera_exc||6349) * (s?.peso_ternera_exc||160)
    : 0;
  // margen feedlot real (cabezas activas)
  const fl_margen_real = feedlot_cabezas > 0 ? feedlot_margen : 0;

  // Total ingresos año 1 (lo que calcula el modelo) + stock extra
  const total_ing = (anio0?.ingresos||0) + st_neto;
  const total_cos = (anio0?.costos||0) + (repos_costo||0);
  const flujo_real_1 = total_ing - total_cos;

  const dataBar  = R?.anios?.map((a,i)=>({ año:`A${i+1}`, flujo: a.flujo_neto||0 })) || [];
  const dataAcum = R?.anios?.map((a,i)=>({ año:`A${i+1}`, acum:  a.acumulado||0  })) || [];

  return (
    <div style={{ paddingBottom:8 }}>
      {/* Hero */}
      <div style={{ background:`linear-gradient(135deg,${C.green},${C.teal})`, borderRadius:20,
        padding:"20px", marginBottom:14, position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", right:-10, top:-10, fontSize:80, opacity:0.08 }}>📈</div>
        <div style={{ fontSize:11, color:"rgba(255,255,255,0.7)", textTransform:"uppercase", letterSpacing:1.5, marginBottom:4 }}>Resultado económico</div>
        <div style={{ fontSize:34, fontWeight:800, color:"#fff", fontFamily:"'DM Mono',monospace", marginBottom:10 }}>
          {fmt(flujo_real_1)}
        </div>
        <div style={{ display:"flex", gap:8 }}>
          {[["Año 1", fmt(flujo_real_1), mc1],
            ["Año pleno", fmt(anio10?.flujo_neto||0), mcP],
            ["Acum. 10a", fmt(acum), mcA],
          ].map(([l,v,c],i)=>(
            <div key={i} style={{ flex:1, background:"rgba(0,0,0,0.2)", borderRadius:10, padding:"8px 10px" }}>
              <div style={{ fontSize:9, color:"rgba(255,255,255,0.65)", marginBottom:2 }}>{l}</div>
              <div style={{ fontSize:12, fontWeight:800, color:"#fff", fontFamily:"'DM Mono',monospace" }}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* P&L */}
      <SecCard title="📊 Balance integral — Año 1" color={C.green}>
        {/* INGRESOS */}
        <div style={{ fontSize:10, fontWeight:700, color:C.t3, textTransform:"uppercase",
          letterSpacing:0.8, padding:"4px 0 6px" }}>Ingresos</div>
        {[
          ing_terneras > 0     ? ["Terneras excedente cría", ing_terneras,   C.green ] : null,
          st_neto > 0          ? ["Venta stock recría",       st_neto,        C.amber ] : null,
          recria_margen !== 0  ? ["Margen recría (nuevo lote)",recria_margen, recria_margen>=0?C.blue:C.red] : null,
          fl_margen_real !== 0 ? ["Margen feedlot",           fl_margen_real, fl_margen_real>=0?C.orange:C.red] : null,
          pastaje_margen > 0   ? ["Ingresos pastaje",         pastaje_margen, C.teal  ] : null,
          rechazo_neto > 0     ? ["Venta rechazo",            rechazo_neto,   C.red   ] : null,
        ].filter(Boolean).map(([l,v,c],i)=>(
          <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"6px 0",
            borderBottom:`1px solid ${C.border}` }}>
            <span style={{ fontSize:11, color:C.t3 }}>{l}</span>
            <span style={{ fontSize:12, fontWeight:600, color:c,
              fontFamily:"'DM Mono',monospace" }}>{fmt(v)}</span>
          </div>
        ))}
        <div style={{ display:"flex", justifyContent:"space-between", padding:"7px 0",
          borderBottom:`2px solid ${C.border}` }}>
          <span style={{ fontSize:11, fontWeight:700, color:C.t1 }}>Total ingresos</span>
          <span style={{ fontSize:13, fontWeight:800, color:C.green,
            fontFamily:"'DM Mono',monospace" }}>{fmt(total_ing)}</span>
        </div>

        {/* EGRESOS */}
        <div style={{ fontSize:10, fontWeight:700, color:C.t3, textTransform:"uppercase",
          letterSpacing:0.8, padding:"10px 0 6px" }}>Egresos</div>
        {[
          ["Gastos campo (sueldos, infra, viajes)",  gastos_calc?.total||0, C.red],
          ["Costos cría (pastaje vacas, IA, etc.)",  (anio0?.costos||0) - (gastos_calc?.total||0), C.red],
          repos_costo > 0 ? ["Reposición (terneras + toros)", repos_costo, C.red] : null,
        ].filter(Boolean).map(([l,v,c],i)=>(
          <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"6px 0",
            borderBottom:`1px solid ${C.border}` }}>
            <span style={{ fontSize:11, color:C.t3 }}>{l}</span>
            <span style={{ fontSize:12, fontWeight:600, color:c,
              fontFamily:"'DM Mono',monospace" }}>-{fmt(v)}</span>
          </div>
        ))}
        <div style={{ display:"flex", justifyContent:"space-between", padding:"7px 0",
          borderBottom:`2px solid ${C.border}` }}>
          <span style={{ fontSize:11, fontWeight:700, color:C.t1 }}>Total egresos</span>
          <span style={{ fontSize:13, fontWeight:800, color:C.red,
            fontFamily:"'DM Mono',monospace" }}>-{fmt(total_cos)}</span>
        </div>

        {/* RESULTADO */}
        <div style={{ background: flujo_real_1>=0?C.greenL:C.redL, borderRadius:10,
          padding:"12px 14px", marginTop:10, display:"flex", justifyContent:"space-between",
          alignItems:"center" }}>
          <span style={{ fontSize:14, fontWeight:800 }}>Flujo neto año 1</span>
          <span style={{ fontSize:18, fontWeight:800, color:mc1,
            fontFamily:"'DM Mono',monospace" }}>{fmt(flujo_real_1)}</span>
        </div>
      </SecCard>

      {/* Gráfico flujo neto */}
      <div style={{ background:C.card, borderRadius:16, padding:"16px", marginBottom:12,
        border:`1.5px solid ${C.border}` }}>
        <div style={{ fontSize:12, fontWeight:700, color:C.t2, marginBottom:12 }}>Flujo neto año a año</div>
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={dataBar} margin={{ top:4, right:0, left:0, bottom:0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
            <XAxis dataKey="año" tick={{ fontSize:9, fill:C.t3 }} axisLine={false} tickLine={false} />
            <YAxis hide />
            <Tooltip formatter={v=>[fmt(v),"Flujo"]}
              contentStyle={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, fontSize:11 }} />
            <Bar dataKey="flujo" radius={[4,4,0,0]} fill={C.green} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Gráfico acumulado */}
      <div style={{ background:C.card, borderRadius:16, padding:"16px", marginBottom:12,
        border:`1.5px solid ${C.border}` }}>
        <div style={{ fontSize:12, fontWeight:700, color:C.t2, marginBottom:12 }}>Acumulado 10 años</div>
        <ResponsiveContainer width="100%" height={140}>
          <AreaChart data={dataAcum} margin={{ top:4, right:0, left:0, bottom:0 }}>
            <defs>
              <linearGradient id="gradAcum" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={C.green} stopOpacity={0.3}/>
                <stop offset="95%" stopColor={C.green} stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
            <XAxis dataKey="año" tick={{ fontSize:9, fill:C.t3 }} axisLine={false} tickLine={false} />
            <YAxis hide />
            <Tooltip formatter={v=>[fmt(v),"Acumulado"]}
              contentStyle={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, fontSize:11 }} />
            <Area dataKey="acum" stroke={C.green} fill="url(#gradAcum)" strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Tabla año a año */}
      <div style={{ background:C.card, borderRadius:16, padding:"16px",
        border:`1.5px solid ${C.border}` }}>
        <div style={{ fontSize:12, fontWeight:700, color:C.t2, marginBottom:10 }}>Detalle por año</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:0 }}>
          {["Año","Ingresos","Egresos","Flujo"].map((h,i)=>(
            <div key={i} style={{ fontSize:9, fontWeight:700, color:C.t3, padding:"4px 6px",
              textTransform:"uppercase", borderBottom:`2px solid ${C.border}` }}>{h}</div>
          ))}
          {R?.anios?.map((a,i)=>{
            const fc = (a.flujo_neto||0)>=0?C.green:C.red;
            return [
              <div key={`y${i}`} style={{ fontSize:10, color:C.t2,    padding:"5px 6px", borderBottom:`1px solid ${C.border}` }}>Año {i+1}</div>,
              <div key={`i${i}`} style={{ fontSize:10, color:C.green,  padding:"5px 6px", borderBottom:`1px solid ${C.border}`, fontFamily:"'DM Mono',monospace" }}>{fmt(a.ingresos||0)}</div>,
              <div key={`e${i}`} style={{ fontSize:10, color:C.red,    padding:"5px 6px", borderBottom:`1px solid ${C.border}`, fontFamily:"'DM Mono',monospace" }}>{fmt(a.costos||0)}</div>,
              <div key={`f${i}`} style={{ fontSize:10, color:fc,       padding:"5px 6px", borderBottom:`1px solid ${C.border}`, fontFamily:"'DM Mono',monospace", fontWeight:700 }}>{fmt(a.flujo_neto||0)}</div>,
            ];
          })}
        </div>
      </div>
    </div>
  );
}

// --- APP ----------------------------------------------------------------------
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=DM+Mono:wght@400;500;700&display=swap";
    document.head.appendChild(link);
  }, []);
  // ── Defaults ──────────────────────────────────────────────────
  const D = {
    tab: "perfil",
    perfil: { nombre:"", nombre_campo:"", provincia:"" },
    s: {
      vacas_actuales:77, terneras_compradas:35, meta:200,
      destete:0.85, paridad:0.50, repos:0.20,
      kg_pastaje:6, inmag:4574, nutriliq_kg:1, nutriliq_precio:500,
      kg_ia:8, preniez1:0.50, meses_recria_tern:11, meses_nutriliq_mac:9,
      peso_entrada_mac:170, peso_salida:350, gdp:0.5,
      precio_venta_nov:5100, precio_compra_tern:7000,
      precio_venta_novillos_act:5100, peso_total_novillos:12064,
      peso_ternera_exc:160, precio_ternera_exc:6349,
    },
    g: {
      sueldo_encargado:900000, sueldo_peon1:900000, sueldo_peon2:900000,
      cargas_sociales:45, premios_anio:1500000,
      hectareas_campo:1000, hectareas_rolado:100,
      costo_rolado_ha:80000, mant_infra:200000, mant_equipos:150000,
      mant_alambrados:80000, km_ida:500, viajes_mes:2,
      consumo_l100km:10, precio_gasoil:1200, otros_viaje:15000,
    },
    rc: {
      stock_cab:35, stock_peso_actual:260, stock_precio_venta:5500,
      stock_precio_compra:3600, stock_mes_venta:4, stock_mes_compra:5,
      cabezas_comprados:35, peso_entrada_comprado:180, precio_compra:7000,
      peso_salida:340, precio_venta_invernada:5500, meses:10,
      kg_pastaje:6, nutriliq_kg:1, nutriliq_precio:500,
      sanidad:8000, flete_compra:3000, flete_venta:3000,
      comerc_compra:3, comerc_venta:3, precio_ternera_hem:6000,
    },
    fl: {
      peso_entrada_fl:340, precio_entrada_fl:3800,
      peso_salida_fl:480, precio_faena:4300,
      dias_feedlot:120, kg_racion_dia:8, precio_racion_kg:280,
      kg_pastaje_fl:2, sanidad_fl:10000,
      flete_entrada_fl:3000, flete_salida_fl:3000,
      comerc_compra_fl:3, comerc_venta_fl:3,
      cabezas_externos:0,
      fuente_recria:false, fuente_vacas:false, fuente_externos:false,
    },
    pt: {
      vacas_tercero:100,    kg_vaca:6,    meses_vaca:12,
      novillos_tercero:145, kg_novillo:5.5, meses_novillo:12,
      terneros_tercero:90,  kg_ternero:5.5, meses_ternero:12,
      toros_tercero:0,      kg_toro:5.5,    meses_toro:12,
    },
    rext: {
      terneras:30, precio_ternera_compra:6500, peso_ternera:160,
      meses_recria:18, kg_pastaje_r:6, nutriliq_kg_r:1, nutriliq_precio_r:500,
      sanidad_r:8000, flete_r:3000, toros:2, precio_toro:2500000,
    },
    rechazo: {
      cabezas:15, peso_vivo:380, destino:"invernada",
      precio_invernada:3800, comerc_venta:3, flete_venta:4000,
      dias_feedlot:90, gdp_feedlot:0.9, kg_racion_dia:8, precio_racion_kg:280,
      kg_pastaje_fl:2, sanidad_fl:8000, precio_faena:4300, flete_faena:4000,
    },
  };

  // ── Cargar desde localStorage (merge con defaults para campos nuevos) ──
  const load = (key) => {
    try {
      const saved = localStorage.getItem("vacaapp_" + key);
      if (!saved) return D[key];
      return typeof D[key] === "object" && !Array.isArray(D[key])
        ? { ...D[key], ...JSON.parse(saved) }
        : JSON.parse(saved);
    } catch { return D[key]; }
  };

  const [tab,     setTab]     = useState(() => load("tab"));
  const [perfil,  setPerfil]  = useState(() => load("perfil"));
  const [s,       setS]       = useState(() => load("s"));
  const [g,       setG]       = useState(() => load("g"));
  const [rc,      setRc]      = useState(() => load("rc"));
  const [fl,      setFl]      = useState(() => load("fl"));
  const [pt,      setPt]      = useState(() => load("pt"));
  const [rext,    setRext]    = useState(() => load("rext"));
  const [rechazo, setRechazo] = useState(() => load("rechazo"));

  // ── Guardar en localStorage cuando cambia cualquier estado ──
  useEffect(() => { try { localStorage.setItem("vacaapp_tab",     JSON.stringify(tab))     } catch {} }, [tab]);
  useEffect(() => { try { localStorage.setItem("vacaapp_perfil",  JSON.stringify(perfil))  } catch {} }, [perfil]);
  useEffect(() => { try { localStorage.setItem("vacaapp_s",       JSON.stringify(s))       } catch {} }, [s]);
  useEffect(() => { try { localStorage.setItem("vacaapp_g",       JSON.stringify(g))       } catch {} }, [g]);
  useEffect(() => { try { localStorage.setItem("vacaapp_rc",      JSON.stringify(rc))      } catch {} }, [rc]);
  useEffect(() => { try { localStorage.setItem("vacaapp_fl",      JSON.stringify(fl))      } catch {} }, [fl]);
  useEffect(() => { try { localStorage.setItem("vacaapp_pt",      JSON.stringify(pt))      } catch {} }, [pt]);
  useEffect(() => { try { localStorage.setItem("vacaapp_rext",    JSON.stringify(rext))    } catch {} }, [rext]);
  useEffect(() => { try { localStorage.setItem("vacaapp_rechazo", JSON.stringify(rechazo)) } catch {} }, [rechazo]);

  const gastos_calc  = useMemo(() => calcGastos(g), [g]);
  const pastaje_calc = useMemo(() => calcPastaje(pt, s.inmag), [pt, s.inmag]);
  const RC_margen = useMemo(() => {
    const l = calcRecria({ ...rc, peso_entrada: rc.peso_entrada_comprado, precio_compra: rc.precio_compra }, s.inmag);
    return l.margen_cab * rc.cabezas_comprados;
  }, [rc, s.inmag]);
  const FL_calc = useMemo(() => calcFeedlot(fl, s.inmag), [fl, s.inmag]);
  const vacas_desc_est = rechazo.cabezas || 0;
  const FL_cabezas = (fl.fuente_recria    ? (rc.cabezas_comprados||35) : 0)
                   + (fl.fuente_vacas     ? vacas_desc_est : 0)
                   + (fl.fuente_externos  ? (fl.cabezas_externos||0) : 0);
  const FL_margen = FL_calc.margen_cab * FL_cabezas;

  const repos_ext_calc = useMemo(() => {
    const im = s.inmag || 4574;
    const pastaje_r = rext.meses_recria * rext.kg_pastaje_r * im;
    const nutriliq_r = rext.meses_recria * 30 * rext.nutriliq_kg_r * rext.nutriliq_precio_r;
    const costo_recria_r = pastaje_r + nutriliq_r + rext.sanidad_r + rext.flete_r;
    const costo_ternera_tot = rext.peso_ternera * rext.precio_ternera_compra + costo_recria_r;
    return { ...rext, costo_recria_r, costo_ternera_tot,
             total_terneras: rext.terneras * costo_ternera_tot,
             total_toros: rext.toros * rext.precio_toro,
             total: rext.terneras * costo_ternera_tot + rext.toros * rext.precio_toro };
  }, [rext, s.inmag]);

  const rechazo_calc = useMemo(() => calcRechazo(rechazo, s.inmag), [rechazo, s.inmag]);
  const R = useMemo(() => calcCria(s, gastos_calc.total, RC_margen, FL_margen, pastaje_calc.total, repos_ext_calc, rechazo_calc.ingreso_final), [s, gastos_calc.total, RC_margen, FL_margen, pastaje_calc.total, repos_ext_calc, rechazo_calc.ingreso_final]);


  const TABS = [
    { id:"perfil",    icon:"🏠",  label:"Perfil"    },
    { id:"campo",     icon:"🏡",  label:"Campo"     },
    { id:"cria",      icon:"🐄",  label:"Cría"      },
    { id:"recria",    icon:"🐂",  label:"Recría"    },
    { id:"feedlot",   icon:"🥩",  label:"Feedlot"   },
    { id:"ventas",    icon:null,  label:"Ventas",  svgIcon:"ventas" },
    { id:"pastaje",      icon:null,  label:"Pastaje",     svgIcon:"pastaje" },
    { id:"rendimiento",  icon:null,  label:"Rendim.",     svgIcon:"rendimiento" },
    { id:"stock",        icon:"📋",  label:"Stock"     },
    { id:"resultado", icon:"📈",  label:"Resultado" },
  ];

  const winW = useWindowWidth();
  const isDesktop = winW >= 900;

  // ── Panel resumen para desktop ──────────────────────────────────
  const anio0 = R?.anios?.[0];
  const flujoAnio1   = anio0?.flujo_neto || 0;
  const flujoPleno   = R?.anios?.[R.anios.length-1]?.flujo_neto || 0;
  const acum10       = R?.anios?.reduce((a,x)=>a+(x.flujo_neto||0), 0) || 0;
  const totalVacas   = s.vacas_actuales || 0;
  const mc1          = flujoAnio1  >= 0 ? C.green : C.red;
  const mcP          = flujoPleno  >= 0 ? C.green : C.red;
  const mcA          = acum10      >= 0 ? C.green : C.red;

  const kpis = [
    { icon:"📈", label:"Flujo año 1",    val:fmt(flujoAnio1),  color:mc1  },
    { icon:"🏆", label:"Flujo año pleno",val:fmt(flujoPleno),  color:mcP  },
    { icon:"💰", label:"Acumulado 10a",  val:fmt(acum10),      color:mcA  },
    { icon:"🐄", label:"Vientres",       val:`${totalVacas} cab`, color:C.green },
    { icon:"🐂", label:"Stock recría",   val:`${rc.stock_cab||0} cab`,   color:C.amber },
    { icon:"🥩", label:"INMAG",          val:`$${(s.inmag||4574).toLocaleString("es-AR")}`, color:C.t2 },
  ];

  // breakdown ventas para el panel
  const st_neto_panel = (rc.stock_cab||0) * (rc.stock_peso_actual||260) * (rc.stock_precio_venta||5500) * 0.97 - (rc.stock_cab||0) * (rc.flete_venta||3000);
  const pastaje_ing   = pastaje_calc?.total || 0;
  const gastos_tot    = gastos_calc?.total || 0;

  return (
    <div style={{ background:C.bg, minHeight:"100vh", color:C.t1,
      fontFamily:"'Plus Jakarta Sans',sans-serif" }}>

      {/* HEADER */}
      <div style={{ padding: isDesktop ? "10px 32px 0" : "8px 12px 0",
        background:C.bg, position:"sticky", top:0, zIndex:20,
        borderBottom:`1px solid ${C.border}` }}>
        <div style={{ maxWidth: isDesktop ? 1400 : 430, margin:"0 auto" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
            marginBottom: isDesktop ? 10 : 6 }}>
            <div style={{ display:"flex", alignItems:"center", gap:0, lineHeight:1 }}>
              <span style={{ fontSize: isDesktop ? 38 : 30, fontFamily:"Georgia,serif",
                fontWeight:700, color:"#332211", letterSpacing:-1 }}>Vaca</span>
              <span style={{ fontSize: isDesktop ? 38 : 30, fontFamily:"Georgia,serif",
                fontWeight:700, color:C.green, letterSpacing:-1 }}>App</span>
            </div>
            {isDesktop && (
              <div style={{ fontSize:13, color:C.t3, fontWeight:500 }}>
                {perfil.nombre_campo || "El Retiro"} · Modelo ganadero
              </div>
            )}
          </div>
          <div style={{ display:"flex", width:"100%" }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => { setTab(t.id); window.scrollTo({ top:0, behavior:"instant" }); }}
                style={{ flex:1, padding: isDesktop ? "8px 0 10px" : "5px 0 7px",
                  border:"none", cursor:"pointer", background:"transparent",
                  fontSize: isDesktop ? 11 : 8, fontWeight:600,
                  color: tab===t.id ? C.green : C.t3,
                  borderBottom:`2px solid ${tab===t.id ? C.green : "transparent"}`,
                  transition:"all .15s", display:"flex", flexDirection:"column", alignItems:"center",
                  gap: isDesktop ? 3 : 1 }}>
                <span style={{ fontSize: isDesktop ? 16 : 13, height: isDesktop ? 20 : 16,
                  display:"flex", alignItems:"center", justifyContent:"center" }}>
                  {t.svgIcon === "pastaje"      ? <PastajeIcon     size={isDesktop?16:14} color={tab===t.id ? C.green : C.t3} />
                   : t.svgIcon === "ventas"     ? <VentasIcon      size={isDesktop?16:14} color={tab===t.id ? C.green : C.t3} />
                   : t.svgIcon === "rendimiento"? <RendimientoIcon size={isDesktop?16:14} color={tab===t.id ? C.green : C.t3} />
                   : t.icon}
                </span>
                <span style={{ lineHeight:1.1 }}>{t.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* CUERPO */}
      <div style={{ maxWidth: isDesktop ? 1400 : 430, margin:"0 auto",
        padding: isDesktop ? "24px 32px 80px" : "16px 16px 100px",
        display: isDesktop ? "grid" : "block",
        gridTemplateColumns: isDesktop ? "1fr 320px" : undefined,
        gap: isDesktop ? 24 : undefined,
        alignItems: "start" }}>

        {/* Columna izquierda: tab activo */}
        <div>
          {tab==="perfil"    && <Perfil perfil={perfil} onChange={setPerfil} s={s} rc={rc} fl={fl} pt={pt} rext={rext} R={R} />}
          {tab==="ventas"    && <Ventas s={s} rc={rc} fl={fl} rechazo={rechazo} rechazo_calc={rechazo_calc} R={R} inmag={s.inmag} />}
          {tab==="campo"     && <Campo g={g} setG={setG}
            pastaje_calc={pastaje_calc} inmag={s.inmag}
            rc_margen={RC_margen} fl_margen={FL_margen}
            rc_costo_compra={rc.cabezas_comprados * rc.peso_entrada_comprado * rc.precio_compra}
            repos_costo={repos_ext_calc.total}
            R={R} s={s} rc={rc} fl={fl} rechazo={rechazo} pt={pt} />}
          {tab==="cria"      && <Cria s={s} setS={setS} R={R} rext={rext} setRext={setRext} repos_ext_calc={repos_ext_calc} rechazo={rechazo} setRechazo={setRechazo} rechazo_calc={rechazo_calc} inmag={s.inmag} />}
          {tab==="recria"    && <Recria rc={rc} setRc={setRc} inmag={s.inmag} machos_destete={R.anios[0]?.machos||33} hembras_destete={R.anios[0]?.retenidas||20} peso_destete={s.peso_entrada_mac} setTab={setTab} />}
          {tab==="feedlot"   && <Feedlot fl={fl} setFl={setFl} inmag={s.inmag} cabezas_recria={rc.cabezas_comprados} peso_salida_recria={rc.peso_salida} vacas_descarte={vacas_desc_est} FL_cabezas={FL_cabezas} FL_margen={FL_margen} FL_calc={FL_calc} />}
          {tab==="pastaje"      && <Pastaje pt={pt} setPt={setPt} pastaje_calc={pastaje_calc} inmag={s.inmag} setS={setS} s={s} />}
          {tab==="rendimiento"  && <Rendimiento R={R} s={s} rc={rc} fl={fl} rechazo={rechazo} pt={pt} g={g} />}
          {tab==="stock"     && <Stock s={s} rc={rc} fl={fl} pt={pt} rext={rext} R={R} inmag={s.inmag} />}
          {tab==="resultado" && <Resultado R={R} s={s} rc={rc} fl={fl} gastos_calc={gastos_calc} recria_margen={RC_margen} feedlot_margen={FL_margen} feedlot_cabezas={FL_cabezas} pastaje_margen={pastaje_calc.total} repos_costo={repos_ext_calc.total} rechazo_neto={rechazo_calc.ingreso_final||0} />}
        </div>

        {/* Columna derecha: panel resumen (solo desktop) */}
        {isDesktop && (
          <div style={{ position:"sticky", top:80 }}>
            {/* KPIs principales */}
            <div style={{ background:C.card, borderRadius:20, padding:"20px",
              border:`1.5px solid ${C.border}`, marginBottom:16 }}>
              <div style={{ fontSize:11, fontWeight:700, color:C.t3, textTransform:"uppercase",
                letterSpacing:1, marginBottom:14 }}>Resumen del modelo</div>
              {kpis.map((k,i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between",
                  alignItems:"center", padding:"9px 0",
                  borderBottom: i < kpis.length-1 ? `1px solid ${C.border}` : "none" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:16 }}>{k.icon}</span>
                    <span style={{ fontSize:12, color:C.t2 }}>{k.label}</span>
                  </div>
                  <span style={{ fontSize:13, fontWeight:800, color:k.color,
                    fontFamily:"'DM Mono',monospace" }}>{k.val}</span>
                </div>
              ))}
            </div>

            {/* Gráfico mini flujo 10 años */}
            {R?.anios?.length > 0 && (
              <div style={{ background:C.card, borderRadius:20, padding:"20px",
                border:`1.5px solid ${C.border}`, marginBottom:16 }}>
                <div style={{ fontSize:11, fontWeight:700, color:C.t3, textTransform:"uppercase",
                  letterSpacing:1, marginBottom:14 }}>Flujo neto — 10 años</div>
                <ResponsiveContainer width="100%" height={140}>
                  <BarChart data={R.anios.map((a,i)=>({ año:`A${i+1}`, flujo:a.flujo_neto||0 }))}
                    margin={{ top:4, right:0, left:0, bottom:0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                    <XAxis dataKey="año" tick={{ fontSize:9, fill:C.t3 }} axisLine={false} tickLine={false} />
                    <YAxis hide />
                    <Tooltip formatter={v=>[fmt(v),"Flujo"]}
                      contentStyle={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, fontSize:11 }} />
                    <Bar dataKey="flujo" radius={[4,4,0,0]}
                      fill={C.green}
                      label={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            {/* Breakdown ingresos / egresos */}
            <div style={{ 
              background: C.card, 
              borderRadius: 20, 
              padding: "20px", 
              border: "1.5px solid " + C.border, 
              marginTop: 20 
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.t3, textTransform: "uppercase", letterSpacing: 1, marginBottom: 14 }}>
                Estructura año 1
              </div>
              {[
                { l: "Ingresos cría",   v: (anio0?.ingreso_bruto || 0), c: C.green },
                { l: "Ingresos recría", v: ((rc.stock_cab || 0) * (rc.stock_peso_actual || 260) * (rc.stock_precio_venta || 5500)), c: C.amber },
                { l: "Gastos campo",    v: gastos_tot, c: C.red, neg: true },
                { l: "Ingresos pastaje", v: pastaje_ing, c: C.teal }
              ].map((r, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid " + C.border }}>
                  <span style={{ fontSize: 11, color: C.t3 }}>{r.l}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: r.c, fontFamily: "monospace" }}>
                    {r.neg ? "-" : ""}{fmt(r.v)}
                  </span>
                ))}
           </div>
        )
    )}
        
export default VacaApp;}
