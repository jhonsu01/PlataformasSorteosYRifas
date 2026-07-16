import "./globals.css";
import { DISCLAIMER, KOFI_URL } from "../lib/rifas.js";

export const metadata = {
  title: "Sorteos y Rifas",
  description: "Estado público del sorteo — números vendidos y ganador, verificable en GitHub.",
};

// El navegador pinta la UI (barra de direcciones en movil) con este color; sin
// esto, una franja blanca corta la parte de arriba de un sitio oscuro.
export const viewport = {
  themeColor: "#0b0b0d",
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>
        {children}
        {/* Descargo en TODAS las paginas: la responsabilidad legal del sorteo es
            de quien lo opera, no del autor del software. */}
        <footer className="site-foot">
          <div className="wrap">
            <p className="foot-legal">⚖️ {DISCLAIMER}</p>
            <p className="foot-meta">
              Hecho con el framework libre{" "}
              <a href="https://github.com/jhonsu01/PlataformasSorteosYRifas" target="_blank" rel="noreferrer">
                Sorteos y Rifas
              </a>
              {" · "}
              <a href={KOFI_URL} target="_blank" rel="noreferrer">💜 Apoyar el proyecto</a>
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
