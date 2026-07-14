package com.sorteosyrifas.cliente

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.NumberFormat
import java.util.Locale

// ---------------------------------------------------------------------------
// Modelo publico (coincide con packages/schemas). NUNCA incluye datos privados.
// ---------------------------------------------------------------------------
data class Raffle(
    val title: String,
    val prize: String,
    val description: String,
    val priceCents: Long,
    val currency: String,
    val min: Int,
    val max: Int,
    val status: String,
)

data class Sold(
    val number: Int,
    val buyer: String,       // "Juan S." — seudonimo publico
)

data class DrawWinner(
    val number: Int,
    val buyer: String,
)

private val BrandViolet = Color(0xFF7C3AED)
private val BrandPink = Color(0xFFDB2777)
private val Gold = Color(0xFFFBBF24)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    RaffleScreen()
                }
            }
        }
    }
}

@Composable
fun RaffleScreen() {
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var raffle by remember { mutableStateOf<Raffle?>(null) }
    var sold by remember { mutableStateOf<List<Sold>>(emptyList()) }
    var winner by remember { mutableStateOf<DrawWinner?>(null) }

    LaunchedEffect(Unit) {
        try {
            val base = BuildConfig.RAW_BASE
            val raffleJson = JSONObject(fetch("$base/raffle.json"))
            val numbersJson = JSONObject(fetch("$base/numbers.json"))
            raffle = parseRaffle(raffleJson)
            sold = parseSold(numbersJson)
            winner = tryFetchWinner("$base/draw.json")
            error = null
        } catch (e: Exception) {
            error = e.message ?: "No se pudo cargar el sorteo."
        } finally {
            loading = false
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        when {
            loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                CircularProgressIndicator(color = BrandViolet)
            }
            error != null -> ErrorView(error!!)
            raffle != null -> Content(raffle!!, sold, winner)
        }
    }
}

@Composable
private fun ErrorView(msg: String) {
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("No se pudo cargar", fontWeight = FontWeight.Bold, fontSize = 20.sp)
        Spacer(Modifier.height(8.dp))
        Text(msg, textAlign = TextAlign.Center, color = Color.Gray)
    }
}

@Composable
private fun Content(raffle: Raffle, sold: List<Sold>, winner: DrawWinner?) {
    val soldByNumber = remember(sold) { sold.associateBy { it.number } }
    val total = (raffle.max - raffle.min + 1).coerceAtLeast(0)
    // Inset inferior (barra de navegacion) para que la ultima fila no quede tapada.
    val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()

    Column(Modifier.fillMaxSize()) {
        Header(raffle, sold.size, total)
        if (winner != null) WinnerBanner(winner)
        Legend()
        LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 56.dp),
            contentPadding = PaddingValues(16.dp, 16.dp, 16.dp, 16.dp + navBottom),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.fillMaxSize(),
        ) {
            val numbers = (raffle.min..raffle.max).toList()
            items(numbers) { n ->
                NumberCell(
                    number = n,
                    sold = soldByNumber[n],
                    isWinner = winner?.number == n,
                )
            }
        }
    }
}

@Composable
private fun Header(raffle: Raffle, soldCount: Int, total: Int) {
    Box(
        Modifier
            .fillMaxWidth()
            // El gradiente cubre TODO el Box (incluida el area de la barra de estado);
            // windowInsetsPadding empuja el contenido debajo de la barra de estado.
            .background(Brush.verticalGradient(listOf(BrandViolet, BrandPink)))
            .windowInsetsPadding(WindowInsets.statusBars)
            .padding(20.dp)
    ) {
        Column {
            Text(raffle.title, color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(4.dp))
            Text("Premio: ${raffle.prize}", color = Color.White, fontSize = 15.sp)
            if (raffle.description.isNotBlank()) {
                Spacer(Modifier.height(2.dp))
                Text(raffle.description, color = Color.White.copy(alpha = 0.85f), fontSize = 13.sp)
            }
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Pill("${formatCop(raffle.priceCents)} / número")
                Spacer(Modifier.width(8.dp))
                Pill("Estado: ${statusEs(raffle.status)}")
            }
            Spacer(Modifier.height(8.dp))
            Text(
                "Vendidos: $soldCount de $total",
                color = Color.White,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
            )
        }
    }
}

@Composable
private fun Pill(text: String) {
    Box(
        Modifier
            .background(Color.White.copy(alpha = 0.2f), RoundedCornerShape(20.dp))
            .padding(horizontal = 12.dp, vertical = 6.dp)
    ) {
        Text(text, color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun WinnerBanner(winner: DrawWinner) {
    Card(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        colors = CardDefaults.cardColors(containerColor = Gold),
    ) {
        Column(Modifier.padding(16.dp)) {
            Text("🏆 ¡Tenemos ganador!", fontWeight = FontWeight.Bold, fontSize = 18.sp)
            Spacer(Modifier.height(4.dp))
            Text("Número ${winner.number} — ${winner.buyer}", fontSize = 15.sp)
        }
    }
}

@Composable
private fun Legend() {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        LegendItem(BrandViolet, "Vendido")
        LegendItem(Color(0xFFEDEAF5), "Libre")
        LegendItem(Gold, "Ganador")
    }
}

@Composable
private fun LegendItem(color: Color, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(14.dp).height(14.dp).background(color, CircleShape))
        Spacer(Modifier.width(6.dp))
        Text(label, fontSize = 12.sp, color = Color.Gray)
    }
}

@Composable
private fun NumberCell(number: Int, sold: Sold?, isWinner: Boolean) {
    val bg = when {
        isWinner -> Gold
        sold != null -> BrandViolet
        else -> Color(0xFFEDEAF5)
    }
    val fg = if (sold != null || isWinner) Color.White else Color(0xFF6B7280)
    Card(
        modifier = Modifier.aspectRatio(1f),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = bg),
    ) {
        Column(
            Modifier.fillMaxSize().padding(4.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                number.toString(),
                color = fg,
                fontWeight = FontWeight.Bold,
                fontSize = 16.sp,
            )
            if (sold != null) {
                Text(
                    sold.buyer,
                    color = fg.copy(alpha = 0.9f),
                    fontSize = 8.sp,
                    maxLines = 1,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Red + parsing (sin librerias externas: HttpURLConnection + org.json).
// ---------------------------------------------------------------------------
private suspend fun fetch(urlStr: String): String = withContext(Dispatchers.IO) {
    val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
        connectTimeout = 10_000
        readTimeout = 10_000
        requestMethod = "GET"
        setRequestProperty("Accept", "application/json")
    }
    try {
        if (conn.responseCode !in 200..299) {
            throw RuntimeException("HTTP ${conn.responseCode} en $urlStr")
        }
        conn.inputStream.bufferedReader().use { it.readText() }
    } finally {
        conn.disconnect()
    }
}

private suspend fun tryFetchWinner(url: String): DrawWinner? = try {
    val obj = JSONObject(fetch(url))
    val w = obj.optJSONObject("winner")
    if (w != null) DrawWinner(w.getInt("number"), w.getString("buyer")) else null
} catch (e: Exception) {
    null // draw.json aun no existe: sin ganador.
}

private fun parseRaffle(o: JSONObject): Raffle {
    val range = o.getJSONObject("numberRange")
    return Raffle(
        title = o.getString("title"),
        prize = o.getString("prize"),
        description = o.optString("description", ""),
        priceCents = o.getLong("priceCents"),
        currency = o.optString("currency", "COP"),
        min = range.getInt("min"),
        max = range.getInt("max"),
        status = o.getString("status"),
    )
}

private fun parseSold(o: JSONObject): List<Sold> {
    val arr = o.getJSONArray("sold")
    return buildList {
        for (i in 0 until arr.length()) {
            val s = arr.getJSONObject(i)
            add(Sold(s.getInt("number"), s.getString("buyer")))
        }
    }
}

private fun formatCop(cents: Long): String {
    val pesos = cents / 100.0
    val nf = NumberFormat.getCurrencyInstance(Locale("es", "CO"))
    nf.maximumFractionDigits = 0
    return nf.format(pesos)
}

private fun statusEs(status: String): String = when (status) {
    "ACTIVE" -> "Activo"
    "SALES_CLOSED" -> "Ventas cerradas"
    "DRAWN" -> "Sorteado"
    "POSTPONED" -> "Pospuesto"
    "ARCHIVED" -> "Archivado"
    "DRAFT" -> "Borrador"
    else -> status
}
