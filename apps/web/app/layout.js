import "./globals.css";

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
      <body>{children}</body>
    </html>
  );
}
