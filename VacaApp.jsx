import { useState, useMemo, useEffect } from "react";

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fmt = (n, dec = 0) =>
  isNaN(n) || !isFinite(n)
    ? "—"
    : new Intl.NumberFormat("es-AR", {
        minimumFractionDigits: dec,
        maximumFractionDigits: dec,
      }).format(n);

const fmtMoney = (n, dec = 0) =>
  isNaN(n) || !isFinite(n) ? "—" : `$ ${fmt(n, dec)}`;

const fmtKg = (n, dec = 1) =>
  isNaN(n) || !isFinite(n) ? "—" : `${fmt(n, dec)} kg`;

const fmtPct = (n, dec = 1) =>
  isNaN(n) || !isFinite(n) ? "—" : `${n > 0 ? "+" : ""}${fmt(n, dec)}%`;

// ─── Shared UI Atoms ─────────────────────────────────────────────────────────

// Slider config per field type (keyed by unit or explicit sliderMax/sliderMin)
function getSliderConfig(unit, step, value) {
  const s = step ?? 1;
  // Porcentajes
  if (unit === "%" ) return { min: 0, max: 100, step: s };
  // Días de encierre
  if (unit === "días") return { min: 0, max: 365, step: s };
  // Meses
  if (unit === "meses") return { min: 0, max: 36, step: s };
  // Años
  if (unit === "años") return { min: 0, max: 20, step: s };
  // Cabezas
  if (unit === "cab") return { min: 0, max: 500, step: s };
  // kg (pesos de animales)
  if (unit === "kg") return { min: 0, max: 600, step: s };
  // Precio por kg
  if (unit === "$/kg") return { min: 0, max: 6000, step: s };
  // Costo por día
  if (unit === "$/día") return { min: 0, max: 20000, step: s };
  // Costo por mes
  if (unit === "$/mes") return { min: 0, max: 100000, step: s };
  // Costo por cabeza
  if (unit === "$/cab") return { min: 0, max: 2000000, step: s };
  // kg INMAG
  if (unit === "kg INMAG" || unit === "kg/mes") return { min: 0, max: 30, step: s };
  // kg/día (GPV)
  if (unit === "kg/día") return { min: 0, max: 3, step: s };
  // kg/ha
  if (unit === "kg/ha") return { min: 0, max: 300, step: s };
  // Pesos (montos grandes)
  const mag = Math.max(value * 3, 5000000);
  return { min: 0, max: mag, step: s };
}

function Field({ label, value, onChange, unit, hint, highlight, readOnly, step, sliderMax, noSlider }) {
  const s = step ?? 1;
  const numVal = Number(value) || 0;

  const handleChange = (raw) => {
    if (!onChange) return;
    const v = Math.max(0, Number(raw));
    onChange(v);
  };

  const increment = () => handleChange(numVal + s);
  const decrement = () => handleChange(Math.max(0, numVal - s));
  const reset = () => handleChange(0);

  const sliderCfg = getSliderConfig(unit, s, numVal);
  const sliderMax_ = sliderMax ?? sliderCfg.max;

  // Accent colors
  const accent = highlight
    ? { border: "border-emerald-300", bg: "bg-emerald-50", text: "text-emerald-800", ring: "focus:ring-emerald-400/50 focus:border-emerald-500", btn: "bg-emerald-100 hover:bg-emerald-200 text-emerald-700 active:bg-emerald-300", sliderAccent: "accent-emerald-500" }
    : { border: "border-slate-200", bg: "bg-white", text: "text-slate-800", ring: "focus:ring-emerald-400/50 focus:border-emerald-400", btn: "bg-slate-100 hover:bg-slate-200 text-slate-600 active:bg-slate-300", sliderAccent: "accent-emerald-500" };

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
      {/* Label row */}
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold tracking-wider uppercase text-slate-500">{label}</label>
        <button
          onClick={reset}
          title="Reset a 0"
          className="text-xs font-black text-slate-300 hover:text-red-400 active:text-red-500 transition-colors px-1 leading-none tabular-nums select-none"
        >
          ×0
        </button>
      </div>

      {/* Input row: − | value | + */}
      <div className={`flex items-stretch rounded-xl border ${accent.border} overflow-hidden shadow-sm`}>
        {/* Decrement button */}
        <button
          onClick={decrement}
          className={`${accent.btn} flex items-center justify-center w-12 shrink-0 text-xl font-black transition-all active:scale-95 border-r ${accent.border} touch-manipulation select-none`}
          aria-label="Reducir"
        >
          −
        </button>

        {/* Number input */}
        <div className="relative flex-1">
          <input
            type="number"
            min={0}
            step={s}
            value={value}
            onChange={(e) => handleChange(e.target.value)}
            className={`w-full h-full ${accent.bg} ${accent.text} px-2 py-3 text-sm font-mono font-semibold text-center
              [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none
              focus:outline-none focus:ring-2 ${accent.ring} transition-all`}
          />
        </div>

        {/* Unit badge */}
        {unit && (
          <span className={`${accent.bg} ${accent.text} opacity-60 flex items-center px-2 text-xs font-mono border-l ${accent.border} shrink-0 whitespace-nowrap`}>
            {unit}
          </span>
        )}

        {/* Increment button */}
        <button
          onClick={increment}
          className={`${accent.btn} flex items-center justify-center w-12 shrink-0 text-xl font-black transition-all active:scale-95 border-l ${accent.border} touch-manipulation select-none`}
          aria-label="Aumentar"
        >
          +
        </button>
      </div>

      {/* Slider */}
      {!noSlider && sliderMax_ > 0 && (
        <input
          type="range"
          min={sliderCfg.min}
          max={sliderMax_}
          step={sliderCfg.step}
          value={Math.min(numVal, sliderMax_)}
          onChange={(e) => handleChange(e.target.value)}
          className={`w-full h-2 rounded-full cursor-pointer ${accent.sliderAccent} touch-manipulation`}
          style={{ accentColor: highlight ? "#10b981" : "#10b981" }}
        />
      )}

      {hint && <p className="text-xs text-slate-400 italic leading-tight">{hint}</p>}
    </div>
  );
}

function SectionTitle({ children, icon, color = "text-emerald-600" }) {
  return (
    <div className="flex items-center gap-2 mb-4 mt-1">
      {icon && <span>{icon}</span>}
      <h3 className={`text-xs font-black tracking-widest uppercase ${color}`}>{children}</h3>
      <div className="flex-1 h-px bg-slate-100" />
    </div>
  );
}

function KpiCard({ label, value, sub, color = "text-slate-800", bg = "bg-white", border = "border-slate-200", large }) {
  return (
    <div className={`rounded-xl border p-4 flex flex-col gap-1 ${bg} ${border}`}>
      <span className="text-xs font-semibold tracking-wider uppercase text-slate-400">{label}</span>
      <span className={`font-mono font-bold tabular-nums ${large ? "text-2xl" : "text-xl"} ${color}`}>{value}</span>
      {sub && <span className="text-xs text-slate-400">{sub}</span>}
    </div>
  );
}

function Divider() { return <div className="h-px bg-slate-100 my-5" />; }

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
      <div className="grid grid-cols-3 gap-3">
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

// ─── Gastos Comerciales subcomponent ─────────────────────────────────────────
function ToggleSwitch({ on, onToggle, label, color = "emerald" }) {
  const colors = {
    emerald: { track: on ? "bg-emerald-500" : "bg-slate-200", knob: "bg-white", label: on ? "text-emerald-700" : "text-slate-400" },
    red:     { track: on ? "bg-red-500"     : "bg-slate-200", knob: "bg-white", label: on ? "text-red-700"     : "text-slate-400" },
  };
  const c = colors[color] ?? colors.emerald;
  return (
    <button
      onClick={onToggle}
      className={`flex items-center gap-2 select-none transition-all group`}
      title={on ? "Activo — clic para desactivar" : "Inactivo — clic para activar"}
    >
      {/* Track */}
      <div className={`relative w-10 h-6 rounded-full transition-colors duration-200 shadow-inner ${c.track}`}>
        <div className={`absolute top-1 left-1 w-4 h-4 rounded-full shadow transition-transform duration-200 ${c.knob} ${on ? "translate-x-4" : "translate-x-0"}`} />
      </div>
      <span className={`text-xs font-semibold transition-colors ${c.label}`}>{label}</span>
    </button>
  );
}

function GastosComerciales({ gastos, setGastos }) {
  const set = (k) => (v) => setGastos((p) => ({ ...p, [k]: v }));
  const toggle = (k) => () => setGastos((p) => ({ ...p, [k]: p[k] === 0 ? (k.includes("omision") ? 3 : 50000) : 0 }));

  const GastoRow = ({ toggleKey, valueKey, label, unit, step, color, icon }) => {
    const isOn = gastos[toggleKey !== valueKey ? toggleKey : valueKey] > 0;
    // We control "on" by checking if value > 0
    const on = gastos[valueKey] > 0;
    return (
      <div className={`rounded-xl border p-3 space-y-2 transition-all ${on ? "bg-white border-slate-200" : "bg-slate-50 border-slate-100 opacity-60"}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="text-sm">{icon}</span>
            <span className="text-xs font-black uppercase tracking-widest text-slate-600">{label}</span>
          </div>
          <ToggleSwitch
            on={on}
            onToggle={() => setGastos((p) => ({
              ...p,
              [valueKey]: p[valueKey] > 0 ? 0 : (unit === "%" ? 3 : 50000),
            }))}
            label={on ? "Activo" : "Off"}
            color={on ? "red" : "emerald"}
          />
        </div>
        {on && (
          <div className="relative flex items-stretch rounded-lg border border-slate-200 overflow-hidden">
            <button onClick={() => set(valueKey)(Math.max(0, gastos[valueKey] - (step ?? 1)))}
              className="w-10 shrink-0 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-600 font-black text-lg flex items-center justify-center border-r border-slate-200 touch-manipulation transition-all">−</button>
            <input type="number" min={0} step={step ?? 1} value={gastos[valueKey]}
              onChange={(e) => set(valueKey)(Number(e.target.value))}
              className="flex-1 bg-white text-slate-800 text-sm font-mono font-semibold text-center py-2
                [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none focus:outline-none focus:ring-2 focus:ring-emerald-400/50" />
            <span className="flex items-center px-2 text-xs text-slate-400 bg-white border-l border-slate-200 font-mono">{unit}</span>
            <button onClick={() => set(valueKey)(gastos[valueKey] + (step ?? 1))}
              className="w-10 shrink-0 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-600 font-black text-lg flex items-center justify-center border-l border-slate-200 touch-manipulation transition-all">+</button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-base">🧾</span>
        <p className="text-xs font-black uppercase tracking-widest text-slate-500">Gastos Comerciales</p>
        <span className="text-xs text-slate-400 font-normal normal-case">— activá solo los que apliquen</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <GastoRow valueKey="fleteCompra" label="Flete Compra" unit="$" step={5000} icon="🚛" color="red" />
        <GastoRow valueKey="comisionCompra" label="Comisión Compra" unit="%" step={0.5} icon="📋" color="red" />
        <GastoRow valueKey="fleteVenta" label="Flete Venta" unit="$" step={5000} icon="🚚" color="red" />
        <GastoRow valueKey="comisionVenta" label="Comisión Venta" unit="%" step={0.5} icon="📄" color="red" />
      </div>
      <div className="flex flex-wrap gap-3 pt-1">
        {[
          { k: "fleteCompra", label: "Flete compra" },
          { k: "comisionCompra", label: `Com. compra ${gastos.comisionCompra}%` },
          { k: "fleteVenta", label: "Flete venta" },
          { k: "comisionVenta", label: `Com. venta ${gastos.comisionVenta}%` },
        ].map(({ k, label }) => (
          <span key={k} className={`text-xs px-2.5 py-1 rounded-full font-semibold border transition-all
            ${gastos[k] > 0 ? "bg-red-50 border-red-200 text-red-600" : "bg-slate-100 border-slate-200 text-slate-400 line-through"}`}>
            {label}
          </span>
        ))}
      </div>
      <p className="text-xs text-slate-400 italic">Compra → suma a inversión · Venta → resta del ingreso bruto</p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO: PODER DE COMPRA
// ═══════════════════════════════════════════════════════════════════════════
function PoderDeCompra({ gastos }) {
  const [venta, setVenta] = useState({ cantidad: 100, pesoPromedio: 430, precioKg: 2200 });
  const [compra, setCompra] = useState({ pesoAnimal: 200, precioKg: 1800 });
  const setV = (k) => (v) => setVenta((p) => ({ ...p, [k]: v }));
  const setC = (k) => (v) => setCompra((p) => ({ ...p, [k]: v }));

  const calc = useMemo(() => {
    // Ingreso bruto de venta
    const ingresoBrutoVenta = venta.cantidad * venta.pesoPromedio * venta.precioKg;
    // Gastos de venta
    const gastoComisionVenta = ingresoBrutoVenta * (gastos.comisionVenta / 100);
    const ingresoNetoVenta = ingresoBrutoVenta - gastos.fleteVenta - gastoComisionVenta;

    // Costo real de compra por cabeza
    const precioAnimalBruto = compra.pesoAnimal * compra.precioKg;
    const gastoComisionCompra = precioAnimalBruto * (gastos.comisionCompra / 100);
    // El flete de compra se distribuye como si fuera un costo fijo total → por cabeza = fleteCompra / cantidadComprada
    // Para la triangulación, calculamos cuántas cabezas podemos comprar iterativamente.
    // Fórmula directa: ingresoNeto = n * (precioAnimalBruto + comisionCompra%) + fleteCompra
    // → n = (ingresoNeto - fleteCompra) / (precioAnimalBruto * (1 + comision%))
    const costoUnitarioBruto = precioAnimalBruto * (1 + gastos.comisionCompra / 100);
    const cabezasComprables = costoUnitarioBruto > 0
      ? Math.floor((ingresoNetoVenta - gastos.fleteCompra) / costoUnitarioBruto)
      : 0;

    const costoRealTotal = cabezasComprables * costoUnitarioBruto + gastos.fleteCompra;
    const sobrante = ingresoNetoVenta - costoRealTotal;
    const relacionVentaCompra = venta.cantidad > 0 ? cabezasComprables / venta.cantidad : 0;

    return { ingresoBrutoVenta, ingresoNetoVenta, costoUnitarioBruto, cabezasComprables, sobrante, relacionVentaCompra };
  }, [venta, compra, gastos]);

  const ratio = calc.relacionVentaCompra;
  const ratioColor = ratio >= 1.3 ? "text-emerald-600" : ratio >= 1 ? "text-amber-600" : "text-red-500";

  return (
    <div className="rounded-2xl border-2 border-sky-200 bg-sky-50 p-6 space-y-5">
      <div className="flex items-center gap-3">
        <span className="w-8 h-8 rounded-lg bg-sky-500 flex items-center justify-center text-white font-black text-sm">⇄</span>
        <div>
          <p className="font-black text-sky-800 text-base tracking-tight">Poder de Compra — Triangulación Venta / Compra</p>
          <p className="text-xs text-sky-600">¿Si vendo X, cuántos Y puedo comprar? Los gastos comerciales se aplican automáticamente.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Venta */}
        <div className="bg-white rounded-xl border border-sky-200 p-4 space-y-3">
          <p className="text-xs font-black uppercase tracking-widest text-sky-700">📤 Origen — Animales que Vendo</p>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Cantidad" value={venta.cantidad} onChange={setV("cantidad")} unit="cab" />
            <Field label="Peso prom." value={venta.pesoPromedio} onChange={setV("pesoPromedio")} unit="kg" />
            <Field label="Precio venta" value={venta.precioKg} onChange={setV("precioKg")} unit="$/kg" step={50} />
          </div>
          <div className="rounded-lg bg-sky-50 border border-sky-100 p-3 space-y-1">
            <div className="flex justify-between text-xs text-slate-500">
              <span>Ingreso bruto</span>
              <span className="font-mono font-semibold">{fmtMoney(calc.ingresoBrutoVenta)}</span>
            </div>
            <div className="flex justify-between text-xs text-red-400">
              <span>− Flete + comisión venta ({gastos.comisionVenta}%)</span>
              <span className="font-mono">−{fmtMoney(calc.ingresoBrutoVenta - calc.ingresoNetoVenta)}</span>
            </div>
            <div className="flex justify-between text-sm font-bold border-t border-sky-200 pt-1 text-sky-800">
              <span>= Ingreso neto disponible</span>
              <span className="font-mono">{fmtMoney(calc.ingresoNetoVenta)}</span>
            </div>
          </div>
        </div>

        {/* Compra */}
        <div className="bg-white rounded-xl border border-sky-200 p-4 space-y-3">
          <p className="text-xs font-black uppercase tracking-widest text-sky-700">📥 Destino — Animales que Compro</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Peso del animal" value={compra.pesoAnimal} onChange={setC("pesoAnimal")} unit="kg" />
            <Field label="Precio compra" value={compra.precioKg} onChange={setC("precioKg")} unit="$/kg" step={50} />
          </div>
          <div className="rounded-lg bg-sky-50 border border-sky-100 p-3 space-y-1">
            <div className="flex justify-between text-xs text-slate-500">
              <span>Precio animal</span>
              <span className="font-mono font-semibold">{fmtMoney(compra.pesoAnimal * compra.precioKg)}</span>
            </div>
            <div className="flex justify-between text-xs text-red-400">
              <span>+ Comisión compra ({gastos.comisionCompra}%)</span>
              <span className="font-mono">+{fmtMoney(compra.pesoAnimal * compra.precioKg * gastos.comisionCompra / 100)}</span>
            </div>
            <div className="flex justify-between text-sm font-bold border-t border-sky-200 pt-1 text-sky-800">
              <span>= Costo real / cabeza</span>
              <span className="font-mono">{fmtMoney(calc.costoUnitarioBruto)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Resultado principal */}
      <div className="rounded-2xl border-2 border-sky-300 bg-white p-5 flex flex-col md:flex-row items-center gap-6">
        <div className="flex-1 text-center md:text-left">
          <p className="text-xs font-black uppercase tracking-widest text-slate-400 mb-1">Resultado de la Triangulación</p>
          <p className="text-slate-600 text-sm leading-relaxed">
            Con la venta de <span className="font-black text-slate-800">{fmt(venta.cantidad)} novillos</span> podés reponer
          </p>
          <p className={`font-mono font-black text-5xl mt-1 ${ratioColor}`}>
            {calc.cabezasComprables > 0 ? fmt(calc.cabezasComprables) : "—"}
          </p>
          <p className="text-slate-500 text-sm mt-0.5">
            terneros — relación <span className={`font-black ${ratioColor}`}>{fmt(ratio, 2)}:1</span>
          </p>
        </div>
        <div className="shrink-0 grid grid-cols-2 gap-3 w-full md:w-auto">
          <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 text-center">
            <p className="text-xs text-slate-400 uppercase tracking-wider font-semibold">Sobrante</p>
            <p className={`font-mono font-bold text-xl ${calc.sobrante >= 0 ? "text-emerald-600" : "text-red-500"}`}>
              {fmtMoney(calc.sobrante)}
            </p>
          </div>
          <div className="rounded-xl bg-sky-50 border border-sky-200 px-4 py-3 text-center">
            <p className="text-xs text-sky-600 uppercase tracking-wider font-semibold">Flete compra</p>
            <p className="font-mono font-bold text-xl text-sky-700">{fmtMoney(gastos.fleteCompra)}</p>
            <p className="text-xs text-sky-400">incluido en cálculo</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB 1 — PROYECTO VIENTRES (con rentabilidad completa)
// ═══════════════════════════════════════════════════════════════════════════
function ProyectoVientres({ global, gastos, onDescarte }) {
  const { inmagVientres, precioNovilloInmag, inflacionMensual } = global;

  const [tipoCompra, setTipoCompra] = useState("terneras");
  const [inputs, setInputs] = useState({
    cantidad: 50,
    pesoCompra: 180,
    precioKgCompra: 1800,
    precioBulto: 350000,
    mesesRecriaPreServicio: 15,  // meses pre-servicio sin producir
    anosVidaUtil: 6,
    kgIatf: 8,
    // Destete
    pctDestete: 85,
    pesoTerneroDestetado: 160,
    precioTerneroKg: 2000,
    // Descarte al final de vida útil
    pesoVacaDescarte: 380,
    precioDescarteSalidaKg: 1600,
  });
  const set = (k) => (v) => setInputs((p) => ({ ...p, [k]: v }));

  const calc = useMemo(() => {
    // ── INVERSIÓN INICIAL ──────────────────────────────────────────────────
    const inversionInicial =
      tipoCompra === "terneras"
        ? inputs.cantidad * inputs.pesoCompra * inputs.precioKgCompra
        : inputs.cantidad * inputs.precioBulto;

    // ── COSTO RECRÍA PRE-SERVICIO (INMAG Vientres × meses × precio) ────────
    const costoRecriaPreServicio =
      inmagVientres * precioNovilloInmag * inputs.mesesRecriaPreServicio * inputs.cantidad;

    // ── COSTO PASTOREO DURANTE VIDA ÚTIL ──────────────────────────────────
    const mesesTotalesVida = inputs.anosVidaUtil * 12;
    const costoPastoreoVida =
      inmagVientres * precioNovilloInmag * mesesTotalesVida * inputs.cantidad;

    // ── COSTO IATF (anual durante vida útil) ──────────────────────────────
    const costoIatfTotal =
      inputs.kgIatf * precioNovilloInmag * inputs.anosVidaUtil * inputs.cantidad;

    // ── COSTO TOTAL DEL PROYECTO ───────────────────────────────────────────
    const costoTotalProyecto =
      inversionInicial + costoRecriaPreServicio + costoPastoreoVida + costoIatfTotal;

    const costoRetencionAnual = costoTotalProyecto / inputs.anosVidaUtil;
    const costoTotalPorVientre = costoTotalProyecto / inputs.cantidad;

    // ── INGRESOS ──────────────────────────────────────────────────────────
    // Terneros destetados por año: cantidad × %destete
    const ternerosAnuales = inputs.cantidad * (inputs.pctDestete / 100);
    const ingresoBrutoAnual = ternerosAnuales * inputs.pesoTerneroDestetado * inputs.precioTerneroKg;
    // Gastos de venta sobre terneros
    const gastoComisionVentaAnual = ingresoBrutoAnual * (gastos.comisionVenta / 100);
    const ingresoNetoAnual = ingresoBrutoAnual - gastos.fleteVenta - gastoComisionVentaAnual;
    const ingresoNetoVidaUtil = ingresoNetoAnual * inputs.anosVidaUtil;

    // Recupero por venta de vaca de descarte al final de vida útil
    const ingresoBrutoDescarte =
      inputs.cantidad * inputs.pesoVacaDescarte * inputs.precioDescarteSalidaKg;
    const gastoComisionDescarte = ingresoBrutoDescarte * (gastos.comisionVenta / 100);
    const recuperoDescarte = ingresoBrutoDescarte - gastos.fleteVenta - gastoComisionDescarte;

    // ── RENTABILIDAD ──────────────────────────────────────────────────────
    const ingresoTotalProyecto = ingresoNetoVidaUtil + recuperoDescarte;
    const margenNeto = ingresoTotalProyecto - costoTotalProyecto;
    const margenPorVientrePorAno = inputs.cantidad > 0 && inputs.anosVidaUtil > 0
      ? margenNeto / inputs.cantidad / inputs.anosVidaUtil
      : 0;
    const roiPct = costoTotalProyecto > 0 ? (margenNeto / costoTotalProyecto) * 100 : 0;

    // ── REF INFLACIÓN ─────────────────────────────────────────────────────
    const precioCompraRef =
      tipoCompra === "terneras"
        ? inputs.precioKgCompra
        : inputs.pesoCompra > 0 ? inputs.precioBulto / inputs.pesoCompra : 0;

    return {
      inversionInicial, costoRecriaPreServicio, costoPastoreoVida,
      costoIatfTotal, costoTotalProyecto, costoRetencionAnual, costoTotalPorVientre,
      ternerosAnuales, ingresoBrutoAnual, ingresoNetoAnual, ingresoNetoVidaUtil,
      recuperoDescarte, ingresoTotalProyecto, margenNeto, margenPorVientrePorAno,
      roiPct, precioCompraRef,
    };
  }, [inputs, tipoCompra, inmagVientres, precioNovilloInmag, gastos]);

  const margenPositivo = calc.margenNeto >= 0;

  return (
    <div className="space-y-5">
      {/* Tipo de compra */}
      <div>
        <SectionTitle icon="🐄" color="text-slate-600">Tipo de Compra</SectionTitle>
        <div className="inline-flex rounded-xl border border-slate-200 p-1 bg-slate-50 gap-1">
          {[{ id: "terneras", label: "Terneras", icon: "🐮" }, { id: "vacas", label: "Vacas Preñadas", icon: "🤰" }].map((t) => (
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
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <Field label="Cantidad de cabezas" value={inputs.cantidad} onChange={set("cantidad")} unit="cab" />
          <Field label="Peso de compra" value={inputs.pesoCompra} onChange={set("pesoCompra")} unit="kg"
            hint={tipoCompra === "vacas" ? "Ref. para inflación" : ""} />
          {tipoCompra === "terneras"
            ? <Field label="Precio por kg" value={inputs.precioKgCompra} onChange={set("precioKgCompra")} unit="$/kg" step={50} />
            : <Field label="Precio al bulto" value={inputs.precioBulto} onChange={set("precioBulto")} unit="$/cab" step={5000} hint="Precio fijo sin importar el peso" />
          }
          <Field label="Meses recría pre-servicio" value={inputs.mesesRecriaPreServicio} onChange={set("mesesRecriaPreServicio")} unit="meses"
            hint="Tiempo que come sin producir terneros" />
          <Field label="Años de vida útil" value={inputs.anosVidaUtil} onChange={set("anosVidaUtil")} unit="años" />
          <Field label="Costo IATF" value={inputs.kgIatf} onChange={set("kgIatf")} unit="kg INMAG"
            hint={`≈ ${fmtMoney(inputs.kgIatf * precioNovilloInmag)}/servicio/cab`} highlight />
        </div>
      </div>

      <Divider />

      {/* Destete y venta de terneros */}
      <div>
        <SectionTitle icon="🐣" color="text-amber-600">Producción Anual — Destete</SectionTitle>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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

      <Divider />

      {/* Recupero por descarte */}
      <div>
        <SectionTitle icon="🔄" color="text-orange-600">Recupero — Venta de Descarte (Fin Vida Útil)</SectionTitle>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <Field label="Peso vaca al descarte" value={inputs.pesoVacaDescarte} onChange={set("pesoVacaDescarte")} unit="kg" />
          <Field label="Precio venta descarte" value={inputs.precioDescarteSalidaKg} onChange={set("precioDescarteSalidaKg")} unit="$/kg" step={50} />
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

      {/* Resultados — costos */}
      <SectionTitle icon="📊" color="text-emerald-600">Desglose de Costos del Proyecto</SectionTitle>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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

      {/* Costo total */}
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 grid grid-cols-3 gap-4">
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
          { label: "Costo total del proyecto", value: -calc.costoTotalProyecto, plus: false },
        ].map((row, i) => (
          <div key={i} className={`flex justify-between text-sm ${i === 2 ? "border-t border-slate-200 pt-2" : ""}`}>
            <span className={i === 2 ? "text-slate-600 font-semibold" : "text-slate-500"}>
              {row.plus ? "+" : "−"} {row.label}
            </span>
            <span className={`font-mono font-semibold ${row.value >= 0 ? "text-slate-700" : "text-red-500"}`}>
              {fmtMoney(Math.abs(row.value))}
            </span>
          </div>
        ))}
        <div className={`flex justify-between text-base font-black border-t-2 pt-2 mt-1
          ${margenPositivo ? "border-emerald-300" : "border-red-300"}`}>
          <span className={margenPositivo ? "text-emerald-700" : "text-red-600"}> = Margen Neto Total</span>
          <span className={`font-mono text-2xl ${margenPositivo ? "text-emerald-600" : "text-red-500"}`}>
            {fmtMoney(calc.margenNeto)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
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

      {inflacionMensual > 0 && (
        <InflationIndicator
          precioCompra={calc.precioCompraRef}
          precioVenta={inputs.precioTerneroKg}
          inflacionMensual={inflacionMensual}
          meses={inputs.anosVidaUtil * 12}
          label="Vientres (vida útil completa)"
        />
      )}

      {/* Botón descarte */}
      <div className="pt-1">
        <div className="rounded-xl border-2 border-dashed border-orange-300 bg-orange-50 p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            <p className="font-bold text-orange-800 text-sm">🔄 Simular descarte a engorde</p>
            <p className="text-xs text-orange-600 mt-0.5">
              Pasá la vaca de descarte ({fmt(inputs.pesoVacaDescarte)} kg, {inputs.cantidad} cab) al Comparador.
            </p>
          </div>
          <button
            onClick={() => onDescarte({ pesoIngreso: inputs.pesoVacaDescarte, cantidad: inputs.cantidad })}
            className="shrink-0 bg-orange-500 hover:bg-orange-600 text-white font-black text-sm px-5 py-3 rounded-xl transition-all shadow-md flex items-center gap-2">
            Pasar descarte a Engorde →
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB 2 — COMPARADOR INVERNADA VS FEEDLOT
// ═══════════════════════════════════════════════════════════════════════════

// Línea de tiempo interactiva de suplementación
function TimelineSuplementacion({ mesesRecria, mesesActivos, onChange, costoMensual, cantidad }) {
  const total = Math.min(Math.max(1, mesesRecria), 36);
  const activos = mesesActivos.filter((m) => m <= total);
  const toggle = (mes) => {
    const next = activos.includes(mes) ? activos.filter((m) => m !== mes) : [...activos, mes];
    onChange(next);
  };
  const costoTotal = activos.length * costoMensual * cantidad;
  return (
    <div className="bg-teal-50 border border-teal-200 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-black uppercase tracking-widest text-teal-700">🌾 Suplementación Estratégica — Seleccioná los meses</p>
        <span className="text-xs font-bold bg-teal-100 text-teal-700 px-2 py-0.5 rounded-full border border-teal-300">
          {activos.length} de {total} meses activos
        </span>
      </div>
      <p className="text-xs text-teal-600">Hacé clic en los meses donde darás suplemento (bache forrajero).</p>
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: total }, (_, i) => i + 1).map((mes) => {
          const isOn = activos.includes(mes);
          return (
            <button
              key={mes}
              onClick={() => toggle(mes)}
              className={`w-12 h-12 rounded-xl text-xs font-black border-2 transition-all select-none touch-manipulation active:scale-95
                ${isOn
                  ? "bg-emerald-500 border-emerald-600 text-white shadow-md shadow-emerald-200"
                  : "bg-white border-slate-200 text-slate-400 hover:border-slate-300 hover:text-slate-500"}`}>
              <span className="block text-center leading-none">{mes}</span>
              {isOn && <span className="block text-center text-emerald-200 leading-none" style={{fontSize: "8px"}}>✓</span>}
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs text-teal-600 font-semibold uppercase tracking-wider">Costo suplemento / mes / cab</p>
          <div className="relative mt-1">
            <input type="number" min={0} value={costoMensual}
              onChange={(e) => {}}
              readOnly
              className="w-full rounded-lg border border-teal-200 bg-white px-3 py-2 text-sm font-mono text-teal-800 pr-10
                [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none opacity-70 cursor-default" />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-teal-400">$/mes</span>
          </div>
          <p className="text-xs text-teal-500 italic mt-0.5">Editá abajo ↓</p>
        </div>
        <div className="flex flex-col justify-end">
          <div className={`rounded-lg border px-3 py-2 ${costoTotal > 0 ? "bg-teal-100 border-teal-300" : "bg-white border-slate-200"}`}>
            <p className="text-xs text-teal-700 font-semibold uppercase tracking-wider">Costo total suplementación</p>
            <p className="font-mono font-bold text-teal-800 text-xl">{fmtMoney(costoTotal)}</p>
            <p className="text-xs text-teal-500">{activos.length} m × ${fmt(costoMensual)} × {cantidad} cab</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// GastosComerciales2 = mismo componente, alias para el contexto del Comparador
const GastosComerciales2 = GastosComerciales;

function ComparadorInvernada({ global, gastos, setGastos, descarteData }) {
  const { inmagInvernada, precioNovilloInmag, inflacionMensual } = global;

  const [base, setBase] = useState({
    cantidad: descarteData?.cantidad ?? 100,
    pesoIngreso: descarteData?.pesoIngreso ?? 200,
    precioCompraKg: 1800,
  });

  const [opA, setOpA] = useState({
    gpvDiaria: 0.6,
    mesesRecria: 8,
    precioVentaKg: 2100,
    mesesSuplementActivos: [],   // array de números de mes
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

  useEffect(() => {
    if (descarteData) {
      setBase((p) => ({ ...p, cantidad: descarteData.cantidad, pesoIngreso: descarteData.pesoIngreso }));
      setOpBPesoOverride(null);
    }
  }, [descarteData]);

  const calc = useMemo(() => {
    // ── GASTOS COMPRA ─────────────────────────────────────────────────────
    const inversionBruta = base.cantidad * base.pesoIngreso * base.precioCompraKg;
    const gastoComisionCompra = inversionBruta * (gastos.comisionCompra / 100);
    const inversionBase = inversionBruta + gastos.fleteCompra + gastoComisionCompra;
    const gastosCompra = gastos.fleteCompra + gastoComisionCompra;

    // ── OPCIÓN A — Invernada ──────────────────────────────────────────────
    const diasPasto = opA.mesesRecria * 30;
    const gpvTotalA = opA.gpvDiaria * diasPasto;
    const pesoSalidaA = base.pesoIngreso + gpvTotalA;

    const costoPastoreoA = inmagInvernada * precioNovilloInmag * opA.mesesRecria * base.cantidad;
    const costoKgPastoCalc = gpvTotalA * base.cantidad > 0 ? costoPastoreoA / (gpvTotalA * base.cantidad) : 0;

    // Suplementación — basada en meses activos (timeline)
    const mesesSuplValidos = opA.mesesSuplementActivos.filter((m) => m <= opA.mesesRecria);
    const costoSuplementacionA = mesesSuplValidos.length * opA.costoSuplementoMensual * base.cantidad;
    const costoOperativoA = costoPastoreoA + costoSuplementacionA;

    const ingresoBrutoA = base.cantidad * pesoSalidaA * opA.precioVentaKg;
    const gastoComisionVentaA = ingresoBrutoA * (gastos.comisionVenta / 100);
    const gastosVentaA = gastos.fleteVenta + gastoComisionVentaA;
    const ingresoNetoA = ingresoBrutoA - gastosVentaA;
    const margenA = ingresoNetoA - inversionBase - costoOperativoA;
    const margenPorCabA = margenA / base.cantidad;

    // ── OPCIÓN B — Feedlot ────────────────────────────────────────────────
    const pesoIngresoB = opBPesoOverride !== null ? opBPesoOverride : pesoSalidaA;
    const gpvTotalB = opB.gpvDiaria * opB.diasEncierre;
    const pesoSalidaB = pesoIngresoB + gpvTotalB;

    const costoTotalDiario = opB.costoRacionDiaria + opB.costoHoteleriadiaria;
    const costoRacionPorAnimal = opB.costoRacionDiaria * opB.diasEncierre;
    const costoHoteleriaPorAnimal = opB.costoHoteleriadiaria * opB.diasEncierre;
    const costoOperativoB = costoTotalDiario * opB.diasEncierre * base.cantidad;

    const ingresoBrutoB = base.cantidad * pesoSalidaB * opB.precioVentaKg;
    const gastoComisionVentaB = ingresoBrutoB * (gastos.comisionVenta / 100);
    const gastosVentaB = gastos.fleteVenta + gastoComisionVentaB;
    const ingresoNetoB = ingresoBrutoB - gastosVentaB;

    // Costo de oportunidad = ingreso neto que resignamos al no vender en invernada
    const inversionB = ingresoNetoA;
    const margenB = ingresoNetoB - inversionB - costoOperativoB;
    const margenPorCabB = margenB / base.cantidad;

    // Eficiencia
    const costoKgGanadoB = opB.gpvDiaria > 0 ? opB.costoRacionDiaria / opB.gpvDiaria : 0;
    const margenPorKgB = opB.precioVentaKg - costoKgGanadoB;

    const ganadorA = margenA >= margenB;

    return {
      inversionBruta, inversionBase, gastosCompra,
      a: { gpvTotal: gpvTotalA, pesoSalida: pesoSalidaA, costoKgPasto: costoKgPastoCalc,
           costoPastoreo: costoPastoreoA, mesesSuplActivos: mesesSuplValidos.length,
           costoSuplementacion: costoSuplementacionA, costoOperativo: costoOperativoA,
           ingresoBruto: ingresoBrutoA, gastosVenta: gastosVentaA, ingresoNeto: ingresoNetoA,
           margen: margenA, margenPorCab: margenPorCabA },
      b: { pesoIngreso: pesoIngresoB, gpvTotal: gpvTotalB, pesoSalida: pesoSalidaB,
           costoRacionPorAnimal, costoHoteleriaPorAnimal, costoOperativo: costoOperativoB,
           inversionB, ingresoBruto: ingresoBrutoB, gastosVenta: gastosVentaB, ingresoNeto: ingresoNetoB,
           margen: margenB, margenPorCab: margenPorCabB, costoKgGanado: costoKgGanadoB, margenPorKg: margenPorKgB },
      ganadorA,
    };
  }, [base, gastos, opA, opB, opBPesoOverride, inmagInvernada, precioNovilloInmag]);

  const mesesFeedlot = opB.diasEncierre / 30;

  return (
    <div className="space-y-5">
      {/* BASE */}
      <SectionTitle icon="📋" color="text-slate-600">Datos de Compra — Base Común</SectionTitle>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Field label="Cantidad de terneros" value={base.cantidad} onChange={setB("cantidad")} unit="cab" />
        <Field label="Peso de ingreso" value={base.pesoIngreso} onChange={setB("pesoIngreso")} unit="kg" />
        <Field label="Precio de compra" value={base.precioCompraKg} onChange={setB("precioCompraKg")} unit="$/kg" step={50} />
      </div>

      <GastosComerciales2 gastos={gastos} setGastos={setGastos} />

      {/* Inversión descompuesta */}
      <div className="grid grid-cols-3 gap-3">
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

      {/* DOS COLUMNAS */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">

        {/* OPCIÓN A — INVERNADA */}
        <div className="space-y-4">
          <SectionTitle icon="🌿" color="text-green-700">Opción A — Invernada a Campo</SectionTitle>

          {/* Meses destacado */}
          <div className="bg-green-600 rounded-xl p-4 text-white">
            <p className="text-xs font-black uppercase tracking-widest text-green-200 mb-2">⏱ Tiempo de recría</p>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <input type="number" min={1} max={36} value={opA.mesesRecria}
                  onChange={(e) => setA("mesesRecria")(Number(e.target.value))}
                  className="w-full rounded-lg border-2 border-green-400 bg-green-700 text-white font-mono font-black text-3xl px-4 py-2 text-center
                    [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none focus:outline-none focus:ring-2 focus:ring-white/50" />
              </div>
              <div className="text-right">
                <p className="text-green-200 text-sm font-semibold">meses</p>
                <p className="text-white font-mono font-bold text-xl">{fmt(opA.mesesRecria * 30)} días</p>
              </div>
            </div>
          </div>

          {/* GPV */}
          <div className="bg-green-50 border border-green-100 rounded-xl p-4 space-y-3">
            <p className="text-xs font-black uppercase tracking-widest text-green-700">Ganancia de Peso Vivo</p>
            <Field label="GPV diaria a pasto" value={opA.gpvDiaria} onChange={setA("gpvDiaria")} unit="kg/día" step={0.1} />
            <div className="grid grid-cols-3 gap-2">
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

          {/* Pastoreo INMAG */}
          <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 space-y-2">
            <p className="text-xs font-black uppercase tracking-widest text-amber-700">🌾 Costo Pastoreo (INMAG Invernada)</p>
            <p className="text-xs text-amber-600">
              {fmt(inmagInvernada)} kg/mes × ${fmt(precioNovilloInmag)}/kg × {opA.mesesRecria} m × {base.cantidad} cab
            </p>
            <div className="grid grid-cols-2 gap-2">
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

          {/* Suplementación — timeline interactiva */}
          <TimelineSuplementacion
            mesesRecria={opA.mesesRecria}
            mesesActivos={opA.mesesSuplementActivos}
            onChange={(next) => setA("mesesSuplementActivos")(next)}
            costoMensual={opA.costoSuplementoMensual}
            cantidad={base.cantidad}
          />
          <Field label="Costo suplemento / mes / cab" value={opA.costoSuplementoMensual}
            onChange={setA("costoSuplementoMensual")} unit="$/mes" step={500} />

          {/* Costo operativo total A */}
          <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 flex justify-between items-center">
            <span className="text-xs font-black uppercase tracking-widest text-green-700">Costo Operativo Total A</span>
            <span className="font-mono font-bold text-green-800 text-xl">{fmtMoney(calc.a.costoOperativo)}</span>
          </div>

          <Field label="Precio de venta estimado" value={opA.precioVentaKg} onChange={setA("precioVentaKg")} unit="$/kg" step={50} />

          {/* Desglose ingreso neto A */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-1.5">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-500">Ingreso Neto Invernada</p>
            <div className="flex justify-between text-xs text-slate-500">
              <span>Ingreso bruto</span>
              <span className="font-mono">{fmtMoney(calc.a.ingresoBruto)}</span>
            </div>
            <div className="flex justify-between text-xs text-red-400">
              <span>− Gastos de venta</span>
              <span className="font-mono">−{fmtMoney(calc.a.gastosVenta)}</span>
            </div>
            <div className="flex justify-between text-sm font-bold border-t border-slate-200 pt-1.5 text-slate-800">
              <span>= Ingreso neto</span>
              <span className="font-mono text-emerald-700">{fmtMoney(calc.a.ingresoNeto)}</span>
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

          {/* Concepto inversión B */}
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-3">
            <p className="text-xs font-black uppercase tracking-widest text-blue-700 mb-1">📌 Costo de Oportunidad</p>
            <p className="text-xs text-blue-600 leading-relaxed">
              No hay nueva compra. El costo de oportunidad es el <strong>ingreso neto de Invernada</strong> ({fmtMoney(calc.a.ingresoNeto)}) resignado al seguir engordando.
            </p>
          </div>

          {/* Peso ingreso feedlot — auto */}
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

          {/* GPV */}
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 space-y-3">
            <p className="text-xs font-black uppercase tracking-widest text-blue-700">Ganancia de Peso Vivo</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="GPV diaria en corral" value={opB.gpvDiaria} onChange={setO("gpvDiaria")} unit="kg/día" step={0.1} />
              <Field label="Días de encierre" value={opB.diasEncierre} onChange={setO("diasEncierre")} unit="días" />
            </div>
            <div className="grid grid-cols-2 gap-2">
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

          {/* Costos feedlot */}
          <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 space-y-3">
            <p className="text-xs font-black uppercase tracking-widest text-indigo-700">💡 Costos Operativos del Corral</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Costo ración / animal / día" value={opB.costoRacionDiaria} onChange={setO("costoRacionDiaria")} unit="$/día" step={100} highlight />
              <Field label="Costo hotelería / animal / día" value={opB.costoHoteleriadiaria} onChange={setO("costoHoteleriadiaria")} unit="$/día" step={100} />
            </div>
            <div className="grid grid-cols-3 gap-2">
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

            {/* Eficiencia */}
            <div className="border-t border-indigo-200 pt-3">
              <p className="text-xs font-bold text-indigo-600 uppercase tracking-wider mb-1">Margen por Kg Ganado</p>
              <p className="text-xs text-indigo-500 mb-2">Precio venta − (Ración/día ÷ GPV/día)</p>
              <div className="grid grid-cols-3 gap-2">
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
                  <p className={`font-mono font-bold text-xl ${calc.b.margenPorKg >= 0 ? "text-emerald-700" : "text-red-600"}`}>
                    {fmtMoney(calc.b.margenPorKg, 0)}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <Field label="Precio de venta gordo" value={opB.precioVentaKg} onChange={setO("precioVentaKg")} unit="$/kg" step={50} />

          {/* Desglose ingreso neto B */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-1.5">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-500">Ingreso Neto Feedlot</p>
            <div className="flex justify-between text-xs text-slate-500">
              <span>Ingreso bruto</span><span className="font-mono">{fmtMoney(calc.b.ingresoBruto)}</span>
            </div>
            <div className="flex justify-between text-xs text-red-400">
              <span>− Gastos de venta</span><span className="font-mono">−{fmtMoney(calc.b.gastosVenta)}</span>
            </div>
            <div className="flex justify-between text-sm font-bold border-t border-slate-200 pt-1.5">
              <span>= Ingreso neto</span>
              <span className="font-mono text-emerald-700">{fmtMoney(calc.b.ingresoNeto)}</span>
            </div>
          </div>

          {inflacionMensual > 0 && (
            <InflationIndicator precioCompra={base.precioCompraKg} precioVenta={opB.precioVentaKg}
              inflacionMensual={inflacionMensual} meses={mesesFeedlot} label="Feedlot" />
          )}
        </div>
      </div>

      <Divider />

      {/* TABLA COMPARATIVA */}
      <SectionTitle icon="⚖️" color="text-slate-600">Comparación de Resultados</SectionTitle>

      <div className="rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
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
              <p className={`font-mono font-black text-3xl tabular-nums ${win ? "text-emerald-600" : margen < 0 ? "text-red-500" : "text-slate-700"}`}>
                {fmtMoney(margen)}
              </p>
              <p className={`text-xs font-mono mt-1 ${win ? "text-emerald-500" : "text-slate-400"}`}>
                {fmtMoney(pCab)} por cabeza
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Winner banner */}
      <div className={`rounded-xl border px-5 py-4 flex items-center gap-4 ${calc.a.margen === calc.b.margen ? "border-slate-300 bg-slate-50" : "border-emerald-300 bg-emerald-50"}`}>
        <span className="text-3xl">{calc.a.margen === calc.b.margen ? "⚖️" : "🏆"}</span>
        <div>
          <p className="font-bold text-slate-800">
            {calc.a.margen === calc.b.margen
              ? "Ambas opciones arrojan el mismo resultado"
              : `${calc.ganadorA ? "Invernada a Campo" : "Terminación en Feedlot"} es la opción más rentable`}
          </p>
          {calc.a.margen !== calc.b.margen && (
            <p className="text-sm text-slate-500 mt-0.5">
              Diferencia de{" "}
              <span className="font-mono font-bold text-emerald-700">{fmtMoney(Math.abs(calc.a.margen - calc.b.margen))}</span>{" "}
              en el margen total &nbsp;·&nbsp;{" "}
              <span className="font-mono font-bold text-emerald-700">{fmtMoney(Math.abs(calc.a.margenPorCab - calc.b.margenPorCab))}</span>{" "}
              por cabeza
            </p>
          )}
          {!calc.ganadorA && calc.b.margen > 0 && (
            <p className="text-xs text-slate-400 mt-1">
              El Feedlot genera <span className="font-semibold text-blue-600">{fmtMoney(calc.b.margen)}</span> adicionales
              por encima del ingreso garantizado por la Invernada.
            </p>
          )}
        </div>
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
  const inc = () => onChange(numVal + step);
  const dec = () => onChange(Math.max(0, numVal - step));
  return (
    <div className="flex flex-col gap-1">
      <label className={`text-xs font-semibold tracking-wider uppercase ${labelColor}`}>{label}</label>
      <div className={`flex items-stretch rounded-xl border-2 ${borderColor} overflow-hidden`}>
        <button onClick={dec}
          className={`w-10 shrink-0 bg-white/60 hover:bg-white active:bg-white/40 ${textColor} font-black text-lg flex items-center justify-center transition-all touch-manipulation select-none`}>−</button>
        <input type="number" min={0} step={step} value={value}
          onChange={(e) => onChange(Math.max(0, Number(e.target.value)))}
          className={`flex-1 bg-transparent text-center text-sm font-mono font-bold ${textColor} py-2.5
            [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none focus:outline-none`} />
        <span className={`flex items-center px-2 text-xs font-mono ${labelColor} opacity-70`}>{unit}</span>
        <button onClick={inc}
          className={`w-10 shrink-0 bg-white/60 hover:bg-white active:bg-white/40 ${textColor} font-black text-lg flex items-center justify-center transition-all touch-manipulation select-none`}>+</button>
      </div>
    </div>
  );
}

function GlobalPanel({ global, setGlobal }) {
  const set = (k) => (v) => setGlobal((p) => ({ ...p, [k]: v }));
  return (
    <div className="rounded-2xl border-2 border-emerald-200 bg-gradient-to-r from-emerald-50 to-teal-50 p-5 mb-6 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <span className="w-7 h-7 rounded-lg bg-emerald-500 flex items-center justify-center text-white text-xs font-black">★</span>
        <div>
          <p className="text-xs font-black uppercase tracking-widest text-emerald-700">Variables Globales — Afectan toda la app</p>
          <p className="text-xs text-emerald-600">INMAG diferenciado por sistema · precio único · inflación</p>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white/80 rounded-xl border border-violet-200 p-3 space-y-2">
          <div className="flex items-center gap-1.5">
            <span>🐄</span>
            <span className="text-xs font-black uppercase tracking-widest text-violet-700">INMAG Vientres</span>
          </div>
          <GInput label="kg / mes / animal" value={global.inmagVientres} onChange={set("inmagVientres")} unit="kg/mes" borderColor="border-violet-300" textColor="text-violet-800" />
          <div className="bg-violet-50 rounded-lg px-3 py-1.5">
            <p className="text-xs text-violet-500">Costo pastoreo / mes / cab</p>
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
            <p className="text-xs text-green-500">Costo pastoreo / mes / cab</p>
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
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
const TABS = [
  { id: "vientres", label: "Proyecto Vientres", icon: "🐄", sub: "Cría & rentabilidad" },
  { id: "invernada", label: "Comparador", icon: "⚖️", sub: "Invernada vs Feedlot" },
];

export default function EstrategiaComercial() {
  const [activeTab, setActiveTab] = useState("vientres");
  const [descarteData, setDescarteData] = useState(null);

  const [global, setGlobal] = useState({
    inmagVientres: 10,
    inmagInvernada: 8,
    precioNovilloInmag: 1800,
    inflacionMensual: 4,
  });

  // Gastos comerciales: estado compartido entre módulos
  const [gastos, setGastos] = useState({
    fleteCompra: 0,
    comisionCompra: 3,
    fleteVenta: 0,
    comisionVenta: 3,
  });

  const handleDescarte = (data) => {
    setDescarteData(data);
    setActiveTab("invernada");
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans antialiased">
      <div className="max-w-5xl mx-auto px-4 md:px-8 py-10">

        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center text-white font-black text-sm shadow">V</div>
            <span className="text-xs font-bold tracking-[0.25em] uppercase text-emerald-600">VacaApp</span>
          </div>
          <h1 className="text-3xl md:text-4xl font-black tracking-tight text-slate-900 leading-none">Estrategia Comercial</h1>
          <p className="text-slate-400 text-sm mt-2">Simulá escenarios de compra y encontrá la opción más rentable antes de invertir.</p>
        </div>

        {/* Global panel */}
        <GlobalPanel global={global} setGlobal={setGlobal} />

        {/* Gastos comerciales globales (siempre visible) */}
        <div className="mb-6">
          <GastosComerciales gastos={gastos} setGastos={setGastos} />
        </div>

        {/* Poder de Compra */}
        <div className="mb-6">
          <PoderDeCompra gastos={gastos} />
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-slate-200">
          {TABS.map((tab) => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`group flex items-center gap-2 px-5 py-3 text-sm font-semibold rounded-t-lg border-b-2 transition-all -mb-px
                ${activeTab === tab.id ? "border-emerald-500 text-emerald-700 bg-white" : "border-transparent text-slate-400 hover:text-slate-600 hover:bg-white/60"}`}>
              <span>{tab.icon}</span>
              <span>{tab.label}</span>
              <span className={`hidden md:inline text-xs font-normal ${activeTab === tab.id ? "text-emerald-400" : "text-slate-300"}`}>— {tab.sub}</span>
              {tab.id === "invernada" && descarteData && (
                <span className="bg-orange-400 text-white text-xs font-black px-1.5 py-0.5 rounded-full">🔄</span>
              )}
            </button>
          ))}
        </div>

        <div className="bg-white border border-slate-200 border-t-0 rounded-b-2xl rounded-tr-2xl p-6 md:p-8 shadow-sm">
          {activeTab === "vientres"
            ? <ProyectoVientres global={global} gastos={gastos} onDescarte={handleDescarte} />
            : <ComparadorInvernada global={global} gastos={gastos} setGastos={setGastos} descarteData={descarteData} />
          }
        </div>

        <p className="text-center text-xs text-slate-300 mt-6">
          Los cálculos son estimativos. Consultá con tu asesor antes de tomar decisiones de inversión.
        </p>
      </div>
    </div>
  );
}
