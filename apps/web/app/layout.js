export const metadata = {
  title: "Sorteos y Rifas",
  description: "Estado público del sorteo — números vendidos y ganador.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body style={{ margin: 0, fontFamily: "system-ui, Segoe UI, sans-serif", background: "#f6f5fb", color: "#1f2937" }}>
        {children}
      </body>
    </html>
  );
}
