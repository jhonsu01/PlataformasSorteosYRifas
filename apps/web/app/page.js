// Portada: lista las rifas publicadas. Server Component + ISR.

import Link from "next/link";
import { listRifas, copFormat, statusEs, OWNER_NAME } from "../lib/rifas.js";

export const revalidate = 60;

export const metadata = {
  title: "Sorteos y Rifas",
  description: "Sorteos con estado público y verificable.",
};

export default async function Home() {
  const rifas = await listRifas();

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", paddingBottom: 60 }}>
      <header
        style={{
          background: "linear-gradient(135deg,#7c3aed,#db2777)",
          color: "#fff",
          padding: "48px 28px",
        }}
      >
        <div style={{ fontSize: 40 }}>🎟️</div>
        <h1 style={{ margin: "10px 0 6px", fontSize: 32 }}>Sorteos y Rifas</h1>
        <p style={{ margin: 0, opacity: 0.92, fontSize: 15 }}>
          Cada sorteo publica su estado en un repositorio público. Puedes verificar la
          historia completa tú mismo.
        </p>
      </header>

      <section style={{ padding: 28 }}>
        {rifas.length === 0 ? (
          <p style={{ color: "#6b7280" }}>Aún no hay sorteos publicados.</p>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))",
              gap: 18,
            }}
          >
            {rifas.map(({ slug, raffle, sold }) => {
              const total = raffle.numberRange.max - raffle.numberRange.min + 1;
              const pct = total ? Math.round((sold.length / total) * 100) : 0;
              return (
                <Link
                  key={slug}
                  href={`/${slug}`}
                  style={{
                    textDecoration: "none",
                    color: "inherit",
                    border: "1px solid #ece9f5",
                    borderRadius: 16,
                    padding: 20,
                    background: "#fff",
                    display: "block",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong style={{ fontSize: 17 }}>{raffle.title}</strong>
                    <span
                      style={{
                        background: raffle.status === "ACTIVE" ? "#7c3aed" : "#9ca3af",
                        color: "#fff",
                        borderRadius: 999,
                        padding: "3px 10px",
                        fontSize: 11,
                        height: "fit-content",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {statusEs(raffle.status)}
                    </span>
                  </div>
                  <p style={{ color: "#6b7280", fontSize: 14, margin: "8px 0" }}>{raffle.prize}</p>
                  <p style={{ color: "#6b7280", fontSize: 13, margin: 0 }}>
                    {copFormat(raffle.priceCents)} por número · {sold.length} de {total} vendidos
                  </p>
                  <div style={{ height: 8, background: "#ece9f5", borderRadius: 999, marginTop: 12 }}>
                    <div
                      style={{
                        height: "100%",
                        width: `${pct}%`,
                        background: "linear-gradient(90deg,#7c3aed,#db2777)",
                        borderRadius: 999,
                      }}
                    />
                  </div>
                </Link>
              );
            })}
          </div>
        )}

        <p style={{ marginTop: 32, fontSize: 13, color: "#6b7280" }}>
          Esta web lee directamente de{" "}
          <a
            href={`https://github.com/${OWNER_NAME}`}
            style={{ color: "#7c3aed" }}
            target="_blank"
            rel="noreferrer"
          >
            github.com/{OWNER_NAME}
          </a>
          . No depende de ningún servidor del organizador: aunque se apague, los datos
          siguen ahí y su historial no se puede reescribir sin dejar rastro.
        </p>
      </section>
    </main>
  );
}
