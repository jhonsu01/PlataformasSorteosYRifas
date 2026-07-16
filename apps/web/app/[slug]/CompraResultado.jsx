"use client";

// Banner que aparece al volver de Wompi (?compra=<id>). Sondea el estado de la
// compra y lo muestra. El webhook es quien confirma la venta server-side; esto
// solo le da al comprador una respuesta visible mientras tanto.

import { useEffect, useState } from "react";

export default function CompraResultado({ purchaseId, backendBase }) {
  const [estado, setEstado] = useState("consultando"); // consultando | PENDING | APPROVED | REJECTED | error

  useEffect(() => {
    let vivo = true;
    let intentos = 0;
    const tick = async () => {
      try {
        const r = await fetch(`${backendBase}/api/purchases/${purchaseId}`);
        const d = await r.json();
        if (!vivo) return;
        if (d.status && d.status !== "PENDING") { setEstado(d.status); return; }
        setEstado("PENDING");
      } catch {
        if (vivo) setEstado("error");
      }
      // Wompi puede tardar unos segundos en confirmar por webhook: se reintenta.
      if (vivo && intentos++ < 8) setTimeout(tick, 2500);
    };
    tick();
    return () => { vivo = false; };
  }, [purchaseId, backendBase]);

  const info = {
    consultando: { icon: "⏳", t: "Verificando tu pago…", c: "var(--accent)" },
    PENDING: { icon: "⏳", t: "Pago en proceso. Si ya pagaste, tu número quedará confirmado en un momento.", c: "var(--accent)" },
    APPROVED: { icon: "✅", t: "¡Pago aprobado! Tu número quedó confirmado. Gracias por participar.", c: "var(--ok)" },
    REJECTED: { icon: "⚠️", t: "El pago no se completó. El número quedó libre de nuevo; puedes intentarlo otra vez.", c: "var(--gold)" },
    error: { icon: "⏳", t: "No pudimos consultar el estado ahora mismo. Revísalo en un momento.", c: "var(--mut)" },
  }[estado];

  return (
    <div className="wrap" style={{ paddingTop: 20 }}>
      <div className="note" style={{ borderColor: info.c }}>
        <strong>{info.icon} {info.t}</strong>
      </div>
    </div>
  );
}
