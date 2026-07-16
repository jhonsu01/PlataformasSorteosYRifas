"use client";

// Rejilla interactiva de números: filtrar, buscar y COMPRAR desde la web.
//
// La lectura del estado (quién compró qué) viene de GitHub y se renderiza en el
// servidor; este componente añade la capa interactiva. Comprar SÍ llama al
// backend (reservar → Wompi o pago manual), igual que el APK: el repo es para
// verificar, la API para transaccionar.

import { useEffect, useMemo, useState } from "react";
import { copFormat, padNum } from "../../lib/rifas.js";

export default function NumerosCliente({
  slug, min, max, priceCents, activa, sold, winner, backendBase,
}) {
  const vendidos = useMemo(() => new Map(sold.map((s) => [s.number, s])), [sold]);
  const [filtro, setFiltro] = useState(winner ? "GANADOR" : "TODOS");
  const [busqueda, setBusqueda] = useState("");
  const [comprar, setComprar] = useState(null); // número elegido

  const numeros = useMemo(() => {
    const q = busqueda.trim();
    const out = [];
    for (let n = min; n <= max; n++) {
      const etiqueta = padNum(n, max);
      if (q && !etiqueta.includes(q)) continue;
      const s = vendidos.has(n);
      const esGanador = winner?.number === n;
      const ok =
        filtro === "VENDIDOS" ? s :
        filtro === "LIBRES" ? !s && !esGanador :
        filtro === "GANADOR" ? esGanador :
        true;
      if (ok) out.push(n);
    }
    return out;
  }, [min, max, busqueda, filtro, vendidos, winner]);

  return (
    <>
      <div className="controls">
        <input
          className="buscador"
          inputMode="numeric"
          placeholder="Buscar número…"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value.replace(/\D/g, ""))}
        />
        <div className="chips">
          <Chip label="Todos" on={filtro === "TODOS"} onClick={() => setFiltro("TODOS")} />
          <Chip label="Vendidos" dot="var(--accent)" on={filtro === "VENDIDOS"} onClick={() => setFiltro("VENDIDOS")} />
          <Chip label="Libres" dot="var(--panel)" on={filtro === "LIBRES"} onClick={() => setFiltro("LIBRES")} />
          {winner && <Chip label="Ganador" dot="var(--gold)" on={filtro === "GANADOR"} onClick={() => setFiltro("GANADOR")} />}
        </div>
      </div>

      {numeros.length === 0 ? (
        <p className="mut" style={{ marginTop: 16 }}>No hay números en este filtro.</p>
      ) : (
        <div className="grid-nums">
          {numeros.map((n) => {
            const s = vendidos.get(n);
            const esGanador = winner?.number === n;
            const libre = !s && !esGanador;
            return (
              <button
                key={n}
                type="button"
                className={`num${esGanador ? " win" : s ? " sold" : ""}`}
                title={s ? `${padNum(n, max)} — ${s.buyer}${s.city ? ` · ${s.city}` : ""}` : `${padNum(n, max)} — libre`}
                onClick={() => { if (libre && activa) setComprar(n); }}
                style={{ cursor: libre && activa ? "pointer" : "default" }}
              >
                {padNum(n, max)}
              </button>
            );
          })}
        </div>
      )}

      {activa && (
        <p className="mut small" style={{ marginTop: 14 }}>
          Toca un número libre para comprarlo.
        </p>
      )}

      {comprar != null && (
        <CompraModal
          slug={slug} numero={comprar} max={max} priceCents={priceCents}
          backendBase={backendBase} onClose={() => setComprar(null)}
        />
      )}
    </>
  );
}

function Chip({ label, dot, on, onClick }) {
  return (
    <button type="button" className={`fchip${on ? " on" : ""}`} onClick={onClick}>
      {dot && <i className="fdot" style={{ background: dot }} />}
      {label}
    </button>
  );
}

// --------------------------- Compra ---------------------------

/** Reduce la imagen del comprobante antes de subirla (backend corta en ~1,2 MB). */
function comprimir(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("No se pudo leer la imagen"));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("El archivo no es una imagen válida"));
      img.onload = () => {
        const escala = Math.min(1, 1280 / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * escala);
        c.height = Math.round(img.height * escala);
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.82));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

function CompraModal({ slug, numero, max, priceCents, backendBase, onClose }) {
  const [pago, setPago] = useState(null);        // { gatewayEnabled, manualEnabled, paymentMethods }
  const [error, setError] = useState(null);
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState("");
  const [metodo, setMetodo] = useState(null);
  const [paso, setPaso] = useState("form");       // form | manual | enviando | ok
  const [reserva, setReserva] = useState(null);   // { purchaseId, ... }
  const [copiado, setCopiado] = useState(null);

  useEffect(() => {
    fetch(`${backendBase}/api/raffles/${slug}/payment`)
      .then((r) => r.json())
      .then((p) => {
        setPago(p);
        setMetodo(p.gatewayEnabled ? "WOMPI" : "MANUAL");
      })
      .catch(() => setError("No se pudo conectar con el servidor de pagos."));
  }, [slug, backendBase]);

  const reservar = async (m) => {
    const res = await fetch(`${backendBase}/api/raffles/${slug}/reserve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        number: numero, method: m,
        buyer: { firstName: first.trim(), lastName: last.trim(), phone: phone.trim(), city: city.trim() },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "No se pudo reservar el número");
    return data;
  };

  const irAPagar = async () => {
    setError(null);
    try {
      if (metodo === "WOMPI") {
        const r = await reservar("WOMPI");
        // Se vuelve a esta pagina con ?compra=<id>; Wompi añade sus parámetros.
        const redirect = `${window.location.origin}${window.location.pathname}?compra=${r.purchaseId}`;
        const url = "https://checkout.wompi.co/p/?" + new URLSearchParams({
          "public-key": r.publicKey,
          currency: "COP",
          "amount-in-cents": String(r.amountInCents),
          reference: r.reference,
          "signature:integrity": r.integritySignature,
          "redirect-url": redirect,
        }).toString();
        window.location.href = url;
      } else {
        const r = await reservar("MANUAL");
        setReserva(r);
        setPaso("manual");
      }
    } catch (e) {
      setError(e.message);
    }
  };

  const subirComprobante = async (file) => {
    setPaso("enviando");
    setError(null);
    try {
      const base64 = await comprimir(file);
      const res = await fetch(`${backendBase}/api/purchases/${reserva.purchaseId}/receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base64 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "No se pudo enviar el comprobante");
      setPaso("ok");
    } catch (e) {
      setError(e.message);
      setPaso("manual");
    }
  };

  const puedeReservar = first.trim() && last.trim();

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-top">
          <h3 style={{ margin: 0 }}>Número {padNum(numero, max)}</h3>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>

        {error && <p className="err">{error}</p>}

        {paso === "form" && (
          <>
            <p className="mut small">{copFormat(priceCents)} · solo se publicará tu nombre, la inicial del apellido y tu ciudad.</p>
            <input className="inp" placeholder="Nombre" value={first} onChange={(e) => setFirst(e.target.value)} />
            <input className="inp" placeholder="Apellido" value={last} onChange={(e) => setLast(e.target.value)} />
            <input className="inp" placeholder="Teléfono" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <input className="inp" placeholder="Ciudad (opcional)" value={city} onChange={(e) => setCity(e.target.value)} />

            {pago && pago.gatewayEnabled && pago.manualEnabled && (
              <div className="metodos">
                <button type="button" className={`fchip${metodo === "WOMPI" ? " on" : ""}`} onClick={() => setMetodo("WOMPI")}>Tarjeta / PSE</button>
                <button type="button" className={`fchip${metodo === "MANUAL" ? " on" : ""}`} onClick={() => setMetodo("MANUAL")}>Transferencia</button>
              </div>
            )}

            <button className="btn" disabled={!puedeReservar || !pago} onClick={irAPagar} style={{ marginTop: 12, width: "100%" }}>
              {metodo === "MANUAL" ? "Ver datos de pago" : "Ir a pagar"}
            </button>
          </>
        )}

        {paso === "manual" && (
          <>
            <p className="mut small">Transfiere {copFormat(priceCents)} a cualquiera de estas cuentas y sube el comprobante:</p>
            {(pago?.paymentMethods || []).map((m, i) => (
              <div className="cuenta" key={i}>
                <div>
                  <div style={{ fontWeight: 700 }}>{m.label}</div>
                  <div>{m.value}</div>
                  {m.hint && <div className="mut small">{m.hint}</div>}
                </div>
                <button className="btn-ghost small" onClick={() => { navigator.clipboard?.writeText(m.value); setCopiado(m.label); }}>
                  {copiado === m.label ? "✓" : "Copiar"}
                </button>
              </div>
            ))}
            <label className="btn" style={{ marginTop: 12, width: "100%", textAlign: "center", cursor: "pointer" }}>
              Subir comprobante
              <input type="file" accept="image/*" hidden onChange={(e) => e.target.files[0] && subirComprobante(e.target.files[0])} />
            </label>
            <p className="mut small" style={{ marginTop: 8 }}>
              Tu número {padNum(numero, max)} queda apartado hasta que un administrador verifique el pago.
            </p>
          </>
        )}

        {paso === "enviando" && <p className="mut">Enviando comprobante…</p>}

        {paso === "ok" && (
          <div style={{ textAlign: "center", padding: "10px 0" }}>
            <div style={{ fontSize: 40 }}>✅</div>
            <p><strong>Comprobante recibido.</strong></p>
            <p className="mut small">Tu número {padNum(numero, max)} queda reservado hasta que se verifique el pago.</p>
            <button className="btn" onClick={onClose} style={{ marginTop: 8 }}>Entendido</button>
          </div>
        )}
      </div>
    </div>
  );
}
