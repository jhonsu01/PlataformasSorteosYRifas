// Detalle de una rifa. TODO se lee de GitHub (ISR), nunca del backend: el
// sorteo debe poder verificarse aunque el backend este apagado.

import Link from "next/link";
import { notFound } from "next/navigation";
import Countdown from "../Countdown.jsx";
import {
  getRifa, listRifas, copFormat, padNum, statusEs, accentOf, accentInk, regimeEs,
} from "../../lib/rifas.js";

export const revalidate = 60;

const fecha = (d) =>
  new Date(d).toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" });
const fechaLarga = (d) =>
  new Date(d).toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

export async function generateStaticParams() {
  const rifas = await listRifas();
  return rifas.map((r) => ({ slug: r.slug }));
}

export async function generateMetadata({ params }) {
  const r = await getRifa(params.slug);
  if (!r) return { title: "Sorteo no encontrado" };
  const { raffle } = r;
  const cover = raffle.media?.cover;
  return {
    title: `${raffle.title} — Sorteos y Rifas`,
    description: raffle.prize,
    // Para que al compartir el enlace por WhatsApp salga la foto del premio:
    // es como se difunde una rifa en la practica.
    openGraph: {
      title: raffle.title,
      description: raffle.prize,
      images: cover ? [cover] : [],
    },
  };
}

export default async function RifaPage({ params }) {
  const data = await getRifa(params.slug);
  if (!data) notFound();

  const { raffle, sold, draw, repoUrl } = data;
  const { min, max } = raffle.numberRange;
  const total = max - min + 1;
  const ganador = draw?.winner ?? raffle.winner ?? null;
  const vendidos = new Map(sold.map((s) => [s.number, s]));

  const accent = accentOf(raffle);
  const media = raffle.media || {};
  const items = raffle.prizeItems || [];
  const destacados = items.filter((i) => i.featured);
  const totalPremio = raffle.prizeTotalCents || 0;
  const pct = total ? Math.round((sold.length / total) * 100) : 0;

  const numeros = [];
  for (let n = min; n <= max; n++) numeros.push(n);

  return (
    // El acento entra como variable CSS. Es hex validado en el backend Y
    // revalidado en accentOf: si no, seria CSS escrito desde la base de datos.
    <main style={{ "--accent": accent, "--accent-ink": accentInk(accent) }}>
      <header className="hero">
        {media.cover && (
          <div className="hero-bg" style={{ backgroundImage: `url(${media.cover})` }} />
        )}
        <div className="wrap hero-inner">
          <Link href="/" className="small mut" style={{ textDecoration: "none" }}>
            ← Todos los sorteos
          </Link>

          <div style={{ marginTop: 18 }} className="eyebrow">
            Sorteo oficial · {statusEs(raffle.status)}
          </div>
          <h1 className="display">{raffle.title}</h1>
          <p className="hero-prize">{raffle.prize}</p>
          {raffle.description && <p className="mut" style={{ maxWidth: "62ch" }}>{raffle.description}</p>}

          <div className="price-tag">
            <b>{copFormat(raffle.priceCents)}</b> por número · {total} números ·{" "}
            {padNum(min, max)} al {padNum(max, max)}
          </div>

          <div className="hero-cta">
            <a href="#numeros" className="btn">Ver los números</a>
            {items.length > 0 && <a href="#premio" className="btn btn-ghost">Ver el premio</a>}
          </div>

          <div className="stats">
            <div className="stat">
              <div className="stat-n">{sold.length}</div>
              <div className="stat-l">Vendidos</div>
            </div>
            <div className="stat">
              <div className="stat-n">{total - sold.length}</div>
              <div className="stat-l">Disponibles</div>
            </div>
            {totalPremio > 0 && (
              <div className="stat">
                <div className="stat-n" style={{ color: "var(--accent)" }}>{copFormat(totalPremio)}</div>
                <div className="stat-l">Valor del premio</div>
              </div>
            )}
            {raffle.endsAt && (
              <div className="stat">
                <div className="stat-n" style={{ fontSize: "1.05rem" }}>{fecha(raffle.endsAt)}</div>
                <div className="stat-l">Cierre de ventas</div>
              </div>
            )}
            {/* La fecha del sorteo es un hecho DISTINTO del cierre: las ventas
                cierran y la loteria externa juega despues. */}
            {raffle.drawAt && (
              <div className="stat">
                <div className="stat-n" style={{ fontSize: "1.05rem" }}>{fecha(raffle.drawAt)}</div>
                <div className="stat-l">Fecha del sorteo</div>
              </div>
            )}
          </div>

          <div className="bar" title={`${pct}% vendido`}>
            <i style={{ width: `${pct}%` }} />
          </div>

          {raffle.endsAt && raffle.status === "ACTIVE" && (
            <div style={{ marginTop: 26 }}>
              {/* El contador va al CIERRE, no al sorteo: es la fecha que le
                  importa a quien todavia puede comprar. */}
              <div className="stat-l" style={{ marginBottom: 8 }}>Cierra en</div>
              <Countdown endsAt={raffle.endsAt} />
              {raffle.drawAt && (
                <p className="small mut" style={{ marginTop: 12, marginBottom: 0 }}>
                  Se juega el <strong style={{ color: "var(--txt)" }}>{fechaLarga(raffle.drawAt)}</strong>
                </p>
              )}
            </div>
          )}
        </div>
      </header>

      {ganador && (
        <section className="section">
          <div className="wrap">
            <div className="winner">
              <div className="stat-l" style={{ color: "#0b0b0d", opacity: 0.7 }}>Número ganador</div>
              <div className="winner-n">{padNum(ganador.number, max)}</div>
              <div>{ganador.buyer}</div>
            </div>
          </div>
        </section>
      )}

      {/* ---------------- El premio ---------------- */}
      {(items.length > 0 || media.youtubeId || media.gallery?.length) && (
        <section className="section" id="premio">
          <div className="wrap">
            <div className="section-head">
              <div className="eyebrow">Lo que se gana</div>
              <h2>El premio</h2>
            </div>

            {totalPremio > 0 && (
              <div className="total-card">
                <div className="stat-l">Valor total del premio</div>
                <div className="total-n">{copFormat(totalPremio)}</div>
                <div className="small mut" style={{ marginTop: 8 }}>
                  Suma de los {items.length} {items.length === 1 ? "ítem" : "ítems"} listados abajo.
                </div>
              </div>
            )}

            {destacados.length > 0 && (
              <div className="feat-grid">
                {destacados.map((it, i) => (
                  <article className="feat" key={i}>
                    {it.imageUrl && <img className="feat-img" src={it.imageUrl} alt={it.name} loading="lazy" />}
                    <div className="feat-body">
                      <div className="feat-name">{it.name}</div>
                      {it.description && <div className="small mut">{it.description}</div>}
                      {it.valueCents > 0 && <div className="feat-val">{copFormat(it.valueCents)}</div>}
                    </div>
                  </article>
                ))}
              </div>
            )}

            {items.length > 0 && (
              <>
                <h3 style={{ marginTop: 44, fontSize: "1rem", letterSpacing: "0.1em", textTransform: "uppercase" }}>
                  Todo lo que incluye · {items.length} {items.length === 1 ? "ítem" : "ítems"}
                </h3>
                <div className="items">
                  {items.map((it, i) => (
                    <div className="item" key={i}>
                      <div>
                        <div>{it.name}</div>
                        {it.description && <div className="small mut">{it.description}</div>}
                      </div>
                      {it.valueCents > 0 && <div className="item-val">{copFormat(it.valueCents)}</div>}
                    </div>
                  ))}
                </div>
              </>
            )}

            {media.youtubeId && (
              <div style={{ marginTop: 44 }}>
                <div className="video">
                  {/* youtube-nocookie: no planta cookies de seguimiento en quien
                      solo vino a mirar una rifa. */}
                  <iframe
                    src={`https://www.youtube-nocookie.com/embed/${media.youtubeId}`}
                    title={`Video del premio: ${raffle.title}`}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                    loading="lazy"
                  />
                </div>
              </div>
            )}

            {media.gallery?.length > 0 && (
              <div className="gallery" style={{ marginTop: 24 }}>
                {media.gallery.map((src, i) => (
                  <img key={i} src={src} alt={`${raffle.title} — foto ${i + 1}`} loading="lazy" />
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ---------------- Numeros ---------------- */}
      <section className="section" id="numeros">
        <div className="wrap">
          <div className="section-head">
            <div className="eyebrow">{sold.length} de {total} vendidos</div>
            <h2>Los números</h2>
          </div>

          <div className="legend">
            <span><i className="dot" style={{ background: "var(--accent)" }} /> Vendido</span>
            <span><i className="dot" style={{ background: "var(--panel)", border: "1px solid var(--line)" }} /> Libre</span>
            {ganador && <span><i className="dot" style={{ background: "var(--gold)" }} /> Ganador</span>}
          </div>

          <div className="grid-nums">
            {numeros.map((n) => {
              const s = vendidos.get(n);
              const esGanador = ganador?.number === n;
              return (
                <div
                  key={n}
                  className={`num${esGanador ? " win" : s ? " sold" : ""}`}
                  title={s ? `${padNum(n, max)} — ${s.buyer}` : `${padNum(n, max)} — libre`}
                >
                  {padNum(n, max)}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ---------------- Participantes ---------------- */}
      {sold.length > 0 && (
        <section className="section">
          <div className="wrap">
            <div className="section-head">
              <div className="eyebrow">Transparencia total</div>
              <h2>Participantes confirmados</h2>
              <p className="mut small" style={{ marginTop: 10 }}>
                Números ya pagados y verificados. Cada uno corresponde a un commit en el
                repositorio público.
              </p>
            </div>
            <div className="people">
              {sold.map((s) => (
                <div className="person" key={s.number}>
                  <span>{s.buyer}</span>
                  <b>{padNum(s.number, max)}</b>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ---------------- Verificacion ---------------- */}
      <section className="section">
        <div className="wrap">
          <div className="note">
            <strong>Verifica este sorteo tú mismo</strong>
            <p>
              Esta página no te pide que confíes en nosotros. Cada venta queda registrada como
              un <em>commit</em> en un repositorio público: el historial no se puede reescribir
              sin dejar rastro, y sigue ahí aunque este sitio desaparezca.
            </p>
            <p>
              <a href={repoUrl} target="_blank" rel="noreferrer">
                📖 Ver el historial completo en GitHub →
              </a>
            </p>
            <p style={{ marginBottom: 0 }}>
              <strong>Privacidad:</strong> solo se publica el nombre y la inicial del apellido de
              cada comprador. Nunca su documento, teléfono, correo ni comprobante de pago.
            </p>
          </div>

          {/* Responsable del sorteo: quién lo convoca y bajo qué régimen. La
              responsabilidad legal es suya, no del software. */}
          <Responsable organizer={raffle.organizer} />
        </div>
      </section>
    </main>
  );
}

function Responsable({ organizer }) {
  const o = organizer || {};
  const regimen = regimeEs(o.regime);
  // Si el organizador no puso nada, no se inventa un bloque vacío: el descargo
  // general del pie ya cubre la responsabilidad.
  if (!o.name && !regimen) return null;
  return (
    <div className="note" style={{ marginTop: 18 }}>
      <strong>Responsable de este sorteo</strong>
      {o.name && <p style={{ margin: "8px 0 4px" }}>{o.name}</p>}
      {regimen && (
        <p className="small" style={{ margin: "0 0 8px" }}>
          <span className={`chip${o.regime === "REGULADA" ? " on" : ""}`}>{regimen}</span>
        </p>
      )}
      {o.authorization && (
        <p className="small mut" style={{ margin: "0 0 8px" }}>{o.authorization}</p>
      )}
      {o.documents?.length > 0 && (
        <p className="small" style={{ margin: 0 }}>
          Documentos:{" "}
          {o.documents.map((d, i) => (
            <span key={i}>
              {i > 0 && " · "}
              <a href={d} target="_blank" rel="noreferrer">documento {i + 1} ↗</a>
            </span>
          ))}
        </p>
      )}
      <p className="small mut" style={{ margin: "10px 0 0" }}>
        La organización y la legalidad de este sorteo son responsabilidad de quien lo convoca.
      </p>
    </div>
  );
}
