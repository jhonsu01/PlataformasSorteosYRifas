// Portada: lista las rifas publicadas. Server Component + ISR.
//
// La fuente es GitHub (los repos de la organizacion), no el backend: si el
// backend se cae, esta pagina sigue mostrando los sorteos y su estado.

import Link from "next/link";
import { listRifas, copFormat, statusEs, accentOf, accentInk, OWNER_NAME } from "../lib/rifas.js";

export const revalidate = 60;

export const metadata = {
  title: "Sorteos y Rifas",
  description: "Sorteos con estado público y verificable en GitHub.",
};

export default async function Home() {
  const rifas = await listRifas();
  const activas = rifas.filter((r) => r.raffle.status === "ACTIVE").length;

  return (
    <main>
      <header className="hero">
        <div className="wrap hero-inner">
          <div className="eyebrow">Estado público y verificable</div>
          <h1 className="display">Sorteos y Rifas</h1>
          <p className="hero-prize">
            Cada sorteo publica su estado en un repositorio público. No tienes que confiar
            en nadie: puedes verificar la historia completa tú mismo.
          </p>

          {rifas.length > 0 && (
            <div className="stats" style={{ maxWidth: 480 }}>
              <div className="stat">
                <div className="stat-n">{rifas.length}</div>
                <div className="stat-l">Sorteos</div>
              </div>
              <div className="stat">
                <div className="stat-n">{activas}</div>
                <div className="stat-l">Activos</div>
              </div>
            </div>
          )}
        </div>
      </header>

      <section className="section">
        <div className="wrap">
          {rifas.length === 0 ? (
            <p className="mut">Aún no hay sorteos publicados.</p>
          ) : (
            <div className="cards">
              {rifas.map(({ slug, raffle, sold }) => {
                const { min, max } = raffle.numberRange;
                const total = max - min + 1;
                const accent = accentOf(raffle);
                const cover = raffle.media?.cover;
                const valor = raffle.prizeTotalCents || 0;
                return (
                  <Link
                    href={`/${slug}`}
                    key={slug}
                    className="card"
                    // Cada tarjeta lleva el acento de SU rifa: la portada es un
                    // escaparate de marcas distintas, no de una sola.
                    style={{ "--accent": accent, "--accent-ink": accentInk(accent) }}
                  >
                    {cover && <img className="card-img" src={cover} alt={raffle.title} loading="lazy" />}
                    <div className="card-body">
                      <span className={`chip${raffle.status === "ACTIVE" ? " on" : ""}`}>
                        {statusEs(raffle.status)}
                      </span>
                      <h2 style={{ fontSize: "1.25rem", textTransform: "none" }}>{raffle.title}</h2>
                      <p className="small mut" style={{ margin: 0 }}>{raffle.prize}</p>
                      {valor > 0 && (
                        <p className="small" style={{ margin: 0, color: "var(--accent)", fontWeight: 700 }}>
                          Valor del premio: {copFormat(valor)}
                        </p>
                      )}
                      <div className="card-foot">
                        <span className="mut">{sold.length} de {total} vendidos</span>
                        <b>{copFormat(raffle.priceCents)}</b>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}

          <div className="note" style={{ marginTop: 40 }}>
            <strong>¿Cómo se verifica?</strong>
            <p style={{ marginBottom: 0 }}>
              Cada venta queda como un <em>commit</em> en{" "}
              <a href={`https://github.com/${OWNER_NAME}`} target="_blank" rel="noreferrer">
                github.com/{OWNER_NAME}
              </a>
              . El historial es público y no se puede reescribir sin dejar rastro.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
