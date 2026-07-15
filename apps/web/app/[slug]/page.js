// Detalle de una rifa: numeros vendidos y ganador. Todo leido de GitHub (ISR).

import Link from "next/link";
import { notFound } from "next/navigation";
import { getRifa, listRifas, copFormat, padNum, statusEs } from "../../lib/rifas.js";

export const revalidate = 60;

export async function generateStaticParams() {
  const rifas = await listRifas();
  return rifas.map((r) => ({ slug: r.slug }));
}

export async function generateMetadata({ params }) {
  const r = await getRifa(params.slug);
  if (!r) return { title: "Sorteo no encontrado" };
  return { title: `${r.raffle.title} — Sorteos y Rifas`, description: r.raffle.prize };
}

export default async function RifaPage({ params }) {
  const data = await getRifa(params.slug);
  if (!data) notFound();

  const { raffle, sold, draw, repoUrl } = data;
  const vendidos = new Map(sold.map((s) => [s.number, s]));
  const { min, max } = raffle.numberRange;
  const total = max - min + 1;
  const ganador = draw?.winner ?? raffle.winner ?? null;

  const numeros = [];
  for (let n = min; n <= max; n++) numeros.push(n);

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", paddingBottom: 60 }}>
      <header style={{ background: "linear-gradient(135deg,#7c3aed,#db2777)", color: "#fff", padding: "28px" }}>
        <Link href="/" style={{ color: "#fff", opacity: 0.85, fontSize: 13, textDecoration: "none" }}>
          ← Todos los sorteos
        </Link>
        <h1 style={{ margin: "12px 0 6px", fontSize: 30 }}>{raffle.title}</h1>
        <p style={{ margin: 0, fontSize: 16 }}>Premio: {raffle.prize}</p>
        {raffle.description && (
          <p style={{ opacity: 0.9, fontSize: 14, marginTop: 6 }}>{raffle.description}</p>
        )}
        <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
          <Pill>{copFormat(raffle.priceCents)} / número</Pill>
          <Pill>Estado: {statusEs(raffle.status)}</Pill>
          <Pill>
            Vendidos: {sold.length} de {total}
          </Pill>
        </div>
      </header>

      {ganador && (
        <div style={{ background: "#fbbf24", padding: "18px 28px", fontWeight: 600, fontSize: 17 }}>
          🏆 Ganador: número {padNum(ganador.number, max)} — {ganador.buyer}
        </div>
      )}

      <section style={{ padding: 28 }}>
        <div style={{ display: "flex", gap: 18, marginBottom: 14, fontSize: 13, color: "#6b7280" }}>
          <Legend color="#7c3aed" label="Vendido" />
          <Legend color="#edeaf5" label="Libre" />
          <Legend color="#fbbf24" label="Ganador" />
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill,minmax(68px,1fr))",
            gap: 8,
          }}
        >
          {numeros.map((n) => {
            const s = vendidos.get(n);
            const esGanador = ganador?.number === n;
            const bg = esGanador ? "#fbbf24" : s ? "#7c3aed" : "#edeaf5";
            const fg = s || esGanador ? "#fff" : "#6b7280";
            return (
              <div
                key={n}
                title={s ? s.buyer : "Libre"}
                style={{
                  background: bg,
                  color: fg,
                  borderRadius: 12,
                  padding: "10px 4px",
                  textAlign: "center",
                  aspectRatio: "1",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 14 }}>{padNum(n, max)}</div>
                {s && <div style={{ fontSize: 9, opacity: 0.9 }}>{s.buyer}</div>}
              </div>
            );
          })}
        </div>

        <div
          style={{
            marginTop: 32,
            padding: 18,
            border: "1px solid #ece9f5",
            borderRadius: 14,
            fontSize: 13,
            color: "#6b7280",
          }}
        >
          <strong style={{ color: "#1f2937" }}>Verifica este sorteo tú mismo</strong>
          <p style={{ margin: "8px 0" }}>
            Cada venta queda registrada como un <em>commit</em>. El historial es público y no
            se puede reescribir sin dejar rastro.
          </p>
          <a href={repoUrl} target="_blank" rel="noreferrer" style={{ color: "#7c3aed" }}>
            📖 Ver el historial completo en GitHub →
          </a>
          <p style={{ margin: "12px 0 0", fontSize: 12 }}>
            Solo se publica el nombre y la inicial del apellido de cada comprador. Nunca su
            documento, teléfono, correo ni comprobante de pago.
          </p>
        </div>
      </section>
    </main>
  );
}

function Pill({ children }) {
  return (
    <span style={{ background: "rgba(255,255,255,0.2)", padding: "6px 12px", borderRadius: 999, fontSize: 13 }}>
      {children}
    </span>
  );
}

function Legend({ color, label }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 12, height: 12, borderRadius: "50%", background: color, display: "inline-block" }} />
      {label}
    </span>
  );
}
