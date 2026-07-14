// Web publica (Server Component + ISR). Lee SOLO el JSON publico del repo
// GitHub de la rifa: sin datos personales (privacidad por diseno).

const RAW_BASE =
  process.env.NEXT_PUBLIC_GITHUB_RAW_BASE ||
  "https://raw.githubusercontent.com/jhonsu01/PlataformasSorteosYRifas/main/examples/sorteo-demo/public";

async function getJson(path) {
  try {
    const res = await fetch(`${RAW_BASE}/${path}`, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function copFormat(cents) {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format((cents || 0) / 100);
}

export default async function Home() {
  const raffle = await getJson("raffle.json");
  const numbers = await getJson("numbers.json");
  const draw = await getJson("draw.json");

  if (!raffle) {
    return (
      <main style={{ maxWidth: 800, margin: "80px auto", padding: 24, textAlign: "center" }}>
        <h1>Sorteos y Rifas</h1>
        <p style={{ color: "#6b7280" }}>Aún no hay un sorteo publicado en esta URL.</p>
      </main>
    );
  }

  const sold = numbers?.sold || [];
  const soldSet = new Map(sold.map((s) => [s.number, s]));
  const total = raffle.numberRange.max - raffle.numberRange.min + 1;
  const winnerNumber = draw?.winner?.number ?? null;
  const numbersList = [];
  for (let n = raffle.numberRange.min; n <= raffle.numberRange.max; n++) numbersList.push(n);

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", paddingBottom: 60 }}>
      <header
        style={{
          background: "linear-gradient(135deg, #7c3aed, #db2777)",
          color: "#fff",
          padding: "40px 28px",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 30 }}>{raffle.title}</h1>
        <p style={{ margin: 6, fontSize: 16 }}>Premio: {raffle.prize}</p>
        {raffle.description && <p style={{ opacity: 0.9 }}>{raffle.description}</p>}
        <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
          <Pill>{copFormat(raffle.priceCents)} / número</Pill>
          <Pill>Estado: {raffle.status}</Pill>
          <Pill>
            Vendidos: {sold.length} de {total}
          </Pill>
        </div>
      </header>

      {draw?.winner && (
        <div style={{ background: "#fbbf24", padding: "18px 28px", fontWeight: 600 }}>
          🏆 Ganador: Número {draw.winner.number} — {draw.winner.buyer}
        </div>
      )}

      <section style={{ padding: 28 }}>
        <h2 style={{ fontSize: 18 }}>Números</h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))",
            gap: 8,
            marginTop: 12,
          }}
        >
          {numbersList.map((n) => {
            const s = soldSet.get(n);
            const isWinner = winnerNumber === n;
            const bg = isWinner ? "#fbbf24" : s ? "#7c3aed" : "#edeaf5";
            const fg = s || isWinner ? "#fff" : "#6b7280";
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
                <div style={{ fontWeight: 700 }}>{n}</div>
                {s && <div style={{ fontSize: 9, opacity: 0.9 }}>{s.buyer}</div>}
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function Pill({ children }) {
  return (
    <span
      style={{
        background: "rgba(255,255,255,0.2)",
        padding: "6px 12px",
        borderRadius: 999,
        fontSize: 13,
      }}
    >
      {children}
    </span>
  );
}
