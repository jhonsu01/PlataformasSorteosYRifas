"use client";

// Cuenta atras hasta el cierre de ventas.
//
// Es cliente por necesidad: la pagina se sirve con ISR (se regenera cada 60 s),
// asi que un contador calculado en el servidor mostraria una hora congelada
// hasta la siguiente regeneracion.

import { useEffect, useState } from "react";

const restante = (endsAt) => Math.max(0, new Date(endsAt).getTime() - Date.now());

function partes(ms) {
  const s = Math.floor(ms / 1000);
  return {
    dias: Math.floor(s / 86400),
    horas: Math.floor((s % 86400) / 3600),
    min: Math.floor((s % 3600) / 60),
    seg: s % 60,
  };
}

export default function Countdown({ endsAt }) {
  // Arranca en null y se rellena tras montar: si el primer render del cliente
  // calculara la hora, no coincidiria con el HTML del servidor y React
  // reventaria con un error de hidratacion.
  const [ms, setMs] = useState(null);

  useEffect(() => {
    setMs(restante(endsAt));
    const t = setInterval(() => setMs(restante(endsAt)), 1000);
    return () => clearInterval(t);
  }, [endsAt]);

  if (ms === null) return <div className="cd" aria-hidden="true" style={{ minHeight: 64 }} />;
  if (ms === 0) return <p className="mut" style={{ margin: 0 }}>Las ventas están cerradas.</p>;

  const p = partes(ms);
  return (
    <div className="cd" role="timer" aria-live="off">
      <Box n={p.dias} l="Días" />
      <Box n={p.horas} l="Horas" />
      <Box n={p.min} l="Min" />
      <Box n={p.seg} l="Seg" />
    </div>
  );
}

function Box({ n, l }) {
  return (
    <div className="cd-box">
      <div className="cd-n">{String(n).padStart(2, "0")}</div>
      <div className="cd-l">{l}</div>
    </div>
  );
}
