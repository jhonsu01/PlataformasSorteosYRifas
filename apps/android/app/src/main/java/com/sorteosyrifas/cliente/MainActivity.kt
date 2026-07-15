package com.sorteosyrifas.cliente

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
// `items` existe en lazy y en lazy.grid con el mismo nombre: importar ambos sin
// alias es ambiguo y no compila.
import androidx.compose.foundation.lazy.items as columnItems
import androidx.compose.foundation.lazy.grid.items as gridItems
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.NumberFormat
import java.util.Locale

// ---------------------------------------------------------------------------
// Modelo publico (packages/schemas). Nunca incluye datos privados.
// ---------------------------------------------------------------------------
data class Raffle(
    val title: String, val prize: String, val description: String,
    val priceCents: Long, val min: Int, val max: Int, val status: String,
)
data class Sold(val number: Int, val buyer: String)
data class DrawWinner(val number: Int, val buyer: String)

/** Resumen para el selector de rifas (GET /api/raffles). */
data class RaffleSummary(
    val slug: String, val title: String, val status: String,
    val sold: Int, val total: Int, val priceCents: Long, val max: Int,
)

/** Compra propia guardada en el dispositivo (ver MisNumeros). */
data class MiCompra(val purchaseId: String, val slug: String, val number: Int)

/** Estado vivo de una compra propia (GET /api/purchases/:id). */
data class EstadoCompra(val number: Int, val status: String)

data class Checkout(
    val purchaseId: String, val reference: String, val amountInCents: Long,
    val publicKey: String, val integritySignature: String,
)

private val BrandViolet = Color(0xFF7C3AED)
private val BrandPink = Color(0xFFDB2777)
private val Gold = Color(0xFFFBBF24)
private val FreeGray = Color(0xFFEDEAF5)

private const val REDIRECT_URL = "https://sorteosyrifas.app/resultado"

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { MaterialTheme { Surface(Modifier.fillMaxSize()) { App() } } }
    }
}

// ---------------------------------------------------------------------------
// Compras propias: se guardan en el dispositivo. No hay cuentas de usuario, y
// preguntar al backend "que compro este telefono" seria un buscador de datos de
// terceros. Asi cada quien solo ve lo suyo, sin identificarse.
// ---------------------------------------------------------------------------
private fun guardarMiCompra(prefs: SharedPreferences, c: MiCompra) {
    val arr = JSONArray(prefs.getString("misCompras", "[]"))
    arr.put(JSONObject().apply {
        put("purchaseId", c.purchaseId); put("slug", c.slug); put("number", c.number)
    })
    prefs.edit().putString("misCompras", arr.toString()).apply()
}

private fun leerMisCompras(prefs: SharedPreferences, slug: String): List<MiCompra> {
    val arr = JSONArray(prefs.getString("misCompras", "[]"))
    return buildList {
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            if (o.getString("slug") == slug) {
                add(MiCompra(o.getString("purchaseId"), o.getString("slug"), o.getInt("number")))
            }
        }
    }
}

@Composable
fun App() {
    val ctx = LocalContext.current
    val prefs = remember { ctx.getSharedPreferences("sorteos", Context.MODE_PRIVATE) }

    var backendBase by remember { mutableStateOf(prefs.getString("backendBase", BuildConfig.BACKEND_BASE) ?: "") }
    var slug by remember { mutableStateOf(prefs.getString("slug", "") ?: "") }
    var showSettings by remember { mutableStateOf(false) }

    fun elegir(s: String) {
        slug = s
        prefs.edit().putString("slug", s).apply()
    }

    Box(Modifier.fillMaxSize()) {
        if (slug.isBlank()) {
            // Sin rifa elegida: el usuario escoge de la lista, no escribe nada.
            PickerScreen(backendBase, onElegir = { elegir(it) }, onSettings = { showSettings = true })
        } else {
            RaffleScreen(
                backendBase = backendBase, slug = slug, prefs = prefs,
                onCambiarRifa = { elegir("") },
            )
        }

        if (showSettings) SettingsDialog(
            backendBase = backendBase,
            onDismiss = { showSettings = false },
            onSave = { b ->
                backendBase = b.trimEnd('/')
                prefs.edit().putString("backendBase", backendBase).apply()
                showSettings = false
                elegir("") // al cambiar de backend, la rifa anterior ya no aplica
            },
        )
    }
}

// ---------------------------------------------------------------------------
// Selector de rifas
// ---------------------------------------------------------------------------
@Composable
private fun PickerScreen(backendBase: String, onElegir: (String) -> Unit, onSettings: () -> Unit) {
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var rifas by remember { mutableStateOf<List<RaffleSummary>>(emptyList()) }

    LaunchedEffect(backendBase) {
        loading = true
        try {
            rifas = fetchRaffles(backendBase)
            error = null
            // Si solo hay una, no hacemos elegir al usuario: entramos directo.
            if (rifas.size == 1) onElegir(rifas.first().slug)
        } catch (e: Exception) {
            error = e.message ?: "No se pudo cargar la lista de sorteos."
        } finally {
            loading = false
        }
    }

    Column(Modifier.fillMaxSize()) {
        Box(
            Modifier.fillMaxWidth()
                .background(Brush.verticalGradient(listOf(BrandViolet, BrandPink)))
                .windowInsetsPadding(WindowInsets.statusBars)
                .padding(20.dp)
        ) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text("Sorteos y Rifas", color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
                    Text("Elige el sorteo que te interesa", color = Color.White.copy(alpha = 0.9f), fontSize = 14.sp)
                }
                Text("⚙", color = Color.White, fontSize = 22.sp, modifier = Modifier.clickable { onSettings() })
            }
        }

        when {
            loading -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator(color = BrandViolet) }
            error != null -> Column(
                Modifier.fillMaxSize().padding(24.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("No se pudo conectar", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                Spacer(Modifier.height(8.dp))
                Text(error!!, textAlign = TextAlign.Center, color = Color.Gray, fontSize = 13.sp)
                Spacer(Modifier.height(16.dp))
                Button(onSettings) { Text("Ajustes") }
            }
            rifas.isEmpty() -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                Text("Aún no hay sorteos publicados.", color = Color.Gray)
            }
            else -> LazyColumn(
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                columnItems(rifas) { r -> RaffleCard(r) { onElegir(r.slug) } }
            }
        }
    }
}

@Composable
private fun RaffleCard(r: RaffleSummary, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable { onClick() },
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = Color.White),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(r.title, fontWeight = FontWeight.Bold, fontSize = 17.sp, modifier = Modifier.weight(1f))
                Box(
                    Modifier.background(
                        if (r.status == "ACTIVE") BrandViolet else Color.Gray,
                        RoundedCornerShape(20.dp)
                    ).padding(horizontal = 10.dp, vertical = 4.dp)
                ) { Text(statusEs(r.status), color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Medium) }
            }
            Spacer(Modifier.height(8.dp))
            Text("${formatCop(r.priceCents)} por número", color = Color.Gray, fontSize = 13.sp)
            Text("Vendidos: ${r.sold} de ${r.total}", color = Color.Gray, fontSize = 13.sp)
        }
    }
}

// ---------------------------------------------------------------------------
// Pantalla de la rifa
// ---------------------------------------------------------------------------
@Composable
private fun RaffleScreen(
    backendBase: String, slug: String, prefs: SharedPreferences,
    onCambiarRifa: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var raffle by remember { mutableStateOf<Raffle?>(null) }
    var sold by remember { mutableStateOf<List<Sold>>(emptyList()) }
    var winner by remember { mutableStateOf<DrawWinner?>(null) }
    var reload by remember { mutableStateOf(0) }

    var buyNumber by remember { mutableStateOf<Int?>(null) }
    var checkout by remember { mutableStateOf<Checkout?>(null) }
    var busyMsg by remember { mutableStateOf<String?>(null) }
    var showMisNumeros by remember { mutableStateOf(false) }

    LaunchedEffect(reload, backendBase, slug) {
        loading = true
        try {
            val base = publicBase(backendBase, slug)
            val rJson = JSONObject(httpGet("$base/raffle.json"))
            val nJson = JSONObject(httpGet("$base/numbers.json"))
            raffle = parseRaffle(rJson)
            sold = parseSold(nJson)
            winner = parseWinner(rJson) ?: tryDrawJson(base)
            error = null
        } catch (e: Exception) {
            error = e.message ?: "No se pudo cargar el sorteo."
        } finally {
            loading = false
        }
    }

    Box(Modifier.fillMaxSize()) {
        when {
            loading -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator(color = BrandViolet) }
            error != null -> Column(
                Modifier.fillMaxSize().padding(24.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("No se pudo cargar", fontWeight = FontWeight.Bold, fontSize = 20.sp)
                Spacer(Modifier.height(8.dp))
                Text(error!!, textAlign = TextAlign.Center, color = Color.Gray)
                Spacer(Modifier.height(16.dp))
                Button(onCambiarRifa) { Text("Ver otros sorteos") }
            }
            raffle != null -> Content(
                raffle = raffle!!, sold = sold, winner = winner,
                onCambiarRifa = onCambiarRifa,
                onMisNumeros = { showMisNumeros = true },
                onPickNumber = { n ->
                    if (raffle!!.status != "ACTIVE") busyMsg = "El sorteo no está activo."
                    else buyNumber = n
                },
            )
        }

        buyNumber?.let { n ->
            PurchaseDialog(
                etiqueta = padNum(n, raffle!!.max), priceCents = raffle!!.priceCents,
                onDismiss = { buyNumber = null },
                onConfirm = { first, last, phone ->
                    buyNumber = null
                    busyMsg = "Reservando número ${padNum(n, raffle!!.max)}…"
                    scope.launch {
                        try {
                            val c = reserve(backendBase, slug, n, first, last, phone)
                            // Se guarda ANTES de pagar: si el pago queda pendiente,
                            // el comprador igual puede seguirlo en "Mis números".
                            guardarMiCompra(prefs, MiCompra(c.purchaseId, slug, n))
                            busyMsg = null
                            if (c.publicKey.isBlank()) {
                                busyMsg = "El sorteo no tiene pagos configurados todavía."
                            } else checkout = c
                        } catch (e: Exception) {
                            busyMsg = "No se pudo reservar: ${e.message}"
                        }
                    }
                },
            )
        }

        checkout?.let { c ->
            CheckoutScreen(
                url = wompiCheckoutUrl(c),
                onFinish = {
                    checkout = null
                    busyMsg = "Verificando el pago…"
                    scope.launch {
                        val st = pollPurchase(backendBase, c.purchaseId)
                        busyMsg = when (st) {
                            "APPROVED" -> "¡Pago aprobado! El número es tuyo."
                            "REJECTED" -> "El pago fue rechazado. El número quedó libre."
                            else -> "Pago en proceso. Puedes seguirlo en “Mis números”."
                        }
                        reload++
                    }
                },
                onCancel = { checkout = null },
            )
        }

        if (showMisNumeros) MisNumerosDialog(
            backendBase = backendBase, prefs = prefs, slug = slug,
            max = raffle?.max ?: 999,
            onDismiss = { showMisNumeros = false },
        )

        busyMsg?.let { msg ->
            AlertDialog(
                onDismissRequest = { busyMsg = null },
                confirmButton = { TextButton({ busyMsg = null }) { Text("Entendido") } },
                text = { Text(msg) },
            )
        }
    }
}

@Composable
private fun Content(
    raffle: Raffle, sold: List<Sold>, winner: DrawWinner?,
    onCambiarRifa: () -> Unit, onMisNumeros: () -> Unit, onPickNumber: (Int) -> Unit,
) {
    val soldByNumber = remember(sold) { sold.associateBy { it.number } }
    val total = (raffle.max - raffle.min + 1).coerceAtLeast(0)
    val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()

    Column(Modifier.fillMaxSize()) {
        Header(raffle, sold.size, total, onCambiarRifa, onMisNumeros)
        if (winner != null) WinnerBanner(winner, raffle.max)
        Legend()
        LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 62.dp),
            contentPadding = PaddingValues(16.dp, 16.dp, 16.dp, 16.dp + navBottom),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.fillMaxSize(),
        ) {
            gridItems((raffle.min..raffle.max).toList()) { n ->
                val s = soldByNumber[n]
                NumberCell(padNum(n, raffle.max), s, winner?.number == n) { if (s == null) onPickNumber(n) }
            }
        }
    }
}

@Composable
private fun Header(
    raffle: Raffle, soldCount: Int, total: Int,
    onCambiarRifa: () -> Unit, onMisNumeros: () -> Unit,
) {
    Box(
        Modifier.fillMaxWidth()
            .background(Brush.verticalGradient(listOf(BrandViolet, BrandPink)))
            .windowInsetsPadding(WindowInsets.statusBars)
            .padding(20.dp)
    ) {
        Column {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(raffle.title, color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f))
                Text("⇄", color = Color.White, fontSize = 20.sp,
                    modifier = Modifier.clickable { onCambiarRifa() }.padding(horizontal = 8.dp))
            }
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
            Spacer(Modifier.height(10.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically) {
                Text("Vendidos: $soldCount de $total", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                Box(
                    Modifier.background(Color.White, RoundedCornerShape(20.dp))
                        .clickable { onMisNumeros() }
                        .padding(horizontal = 14.dp, vertical = 7.dp)
                ) { Text("🎫 Mis números", color = BrandViolet, fontSize = 13.sp, fontWeight = FontWeight.Bold) }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Mis números
// ---------------------------------------------------------------------------
@Composable
private fun MisNumerosDialog(
    backendBase: String, prefs: SharedPreferences, slug: String, max: Int, onDismiss: () -> Unit,
) {
    val mias = remember { leerMisCompras(prefs, slug) }
    var loading by remember { mutableStateOf(true) }
    var estados by remember { mutableStateOf<List<EstadoCompra>>(emptyList()) }

    LaunchedEffect(Unit) {
        estados = mias.mapNotNull { c ->
            try {
                val o = JSONObject(httpGet("$backendBase/api/purchases/${c.purchaseId}"))
                EstadoCompra(o.getInt("number"), o.getString("status"))
            } catch (_: Exception) {
                EstadoCompra(c.number, "DESCONOCIDO")
            }
        }
        loading = false
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onDismiss) { Text("Cerrar") } },
        title = { Text("🎫 Mis números") },
        text = {
            when {
                loading -> Box(Modifier.fillMaxWidth().padding(20.dp), Alignment.Center) {
                    CircularProgressIndicator(color = BrandViolet)
                }
                mias.isEmpty() -> Text(
                    "Todavía no has comprado números en este sorteo.\n\n" +
                        "Toca un número libre para comprarlo.",
                    fontSize = 14.sp, color = Color.Gray,
                )
                else -> Column {
                    Text(
                        "Se guardan en este dispositivo. Si desinstalas la app o cambias de " +
                            "teléfono, esta lista se pierde (tu compra no).",
                        fontSize = 11.sp, color = Color.Gray,
                    )
                    Spacer(Modifier.height(12.dp))
                    estados.forEach { e ->
                        Row(
                            Modifier.fillMaxWidth().padding(vertical = 5.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(
                                Modifier.background(colorEstado(e.status), RoundedCornerShape(10.dp))
                                    .padding(horizontal = 12.dp, vertical = 8.dp)
                            ) { Text(padNum(e.number, max), color = Color.White, fontWeight = FontWeight.Bold) }
                            Spacer(Modifier.width(12.dp))
                            Text(textoEstado(e.status), fontSize = 14.sp)
                        }
                    }
                }
            }
        },
    )
}

private fun colorEstado(s: String) = when (s) {
    "APPROVED" -> BrandViolet
    "PENDING" -> Gold
    else -> Color.Gray
}

private fun textoEstado(s: String) = when (s) {
    "APPROVED" -> "Pagado ✓ — el número es tuyo"
    "PENDING" -> "Pago en proceso…"
    "REJECTED" -> "Pago rechazado — número liberado"
    "VOID" -> "Venta anulada por el organizador"
    else -> "Estado no disponible"
}

// ---------------------------------------------------------------------------
@Composable
private fun Pill(text: String) {
    Box(
        Modifier.background(Color.White.copy(alpha = 0.2f), RoundedCornerShape(20.dp))
            .padding(horizontal = 12.dp, vertical = 6.dp)
    ) { Text(text, color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Medium) }
}

@Composable
private fun WinnerBanner(winner: DrawWinner, max: Int) {
    Card(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        colors = CardDefaults.cardColors(containerColor = Gold),
    ) {
        Column(Modifier.padding(16.dp)) {
            Text("🏆 ¡Tenemos ganador!", fontWeight = FontWeight.Bold, fontSize = 18.sp)
            Spacer(Modifier.height(4.dp))
            Text("Número ${padNum(winner.number, max)} — ${winner.buyer}", fontSize = 15.sp)
        }
    }
}

@Composable
private fun Legend() {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        LegendItem(BrandViolet, "Vendido"); LegendItem(FreeGray, "Libre"); LegendItem(Gold, "Ganador")
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
private fun NumberCell(etiqueta: String, sold: Sold?, isWinner: Boolean, onClick: () -> Unit) {
    val bg = when {
        isWinner -> Gold
        sold != null -> BrandViolet
        else -> FreeGray
    }
    val fg = if (sold != null || isWinner) Color.White else Color(0xFF6B7280)
    Card(
        modifier = Modifier.aspectRatio(1f).clickable(enabled = sold == null) { onClick() },
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = bg),
    ) {
        Column(
            Modifier.fillMaxSize().padding(4.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(etiqueta, color = fg, fontWeight = FontWeight.Bold, fontSize = 15.sp)
            if (sold != null) {
                Text(sold.buyer, color = fg.copy(alpha = 0.9f), fontSize = 8.sp, maxLines = 1, textAlign = TextAlign.Center)
            }
        }
    }
}

@Composable
private fun PurchaseDialog(
    etiqueta: String, priceCents: Long,
    onDismiss: () -> Unit, onConfirm: (String, String, String) -> Unit,
) {
    var first by remember { mutableStateOf("") }
    var last by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Comprar número $etiqueta") },
        text = {
            Column {
                Text("Precio: ${formatCop(priceCents)}", fontWeight = FontWeight.Medium)
                Spacer(Modifier.height(4.dp))
                Text(
                    "Solo se publicará tu nombre y la inicial del apellido.",
                    fontSize = 11.sp, color = Color.Gray,
                )
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(first, { first = it }, label = { Text("Nombre") }, singleLine = true)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(last, { last = it }, label = { Text("Apellido") }, singleLine = true)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(phone, { phone = it }, label = { Text("Teléfono") }, singleLine = true)
            }
        },
        confirmButton = {
            TextButton(
                enabled = first.isNotBlank() && last.isNotBlank(),
                onClick = { onConfirm(first.trim(), last.trim(), phone.trim()) },
            ) { Text("Ir a pagar") }
        },
        dismissButton = { TextButton(onDismiss) { Text("Cancelar") } },
    )
}

@Composable
private fun SettingsDialog(backendBase: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var b by remember { mutableStateOf(backendBase) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Ajustes avanzados") },
        text = {
            Column {
                Text(
                    "La app ya viene configurada. Cambia esto solo si el organizador " +
                        "te indicó otro servidor.",
                    fontSize = 12.sp, color = Color.Gray,
                )
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(b, { b = it }, label = { Text("Servidor") }, singleLine = true)
            }
        },
        confirmButton = { TextButton({ onSave(b.trim()) }) { Text("Guardar") } },
        dismissButton = { TextButton(onDismiss) { Text("Cancelar") } },
    )
}

/** Checkout de Wompi dentro de un WebView controlado. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun CheckoutScreen(url: String, onFinish: () -> Unit, onCancel: () -> Unit) {
    Column(Modifier.fillMaxSize().background(Color.White).windowInsetsPadding(WindowInsets.systemBars)) {
        Row(
            Modifier.fillMaxWidth().background(BrandViolet).padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Pago seguro · Wompi", color = Color.White, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            Text("Cancelar", color = Color.White, modifier = Modifier.clickable { onCancel() })
        }
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { context ->
                WebView(context).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                            val u = request?.url?.toString().orEmpty()
                            return if (u.startsWith(REDIRECT_URL)) { onFinish(); true } else false
                        }
                    }
                    loadUrl(url)
                }
            },
        )
    }
}

// ---------------------------------------------------------------------------
// Red
// ---------------------------------------------------------------------------
private fun publicBase(backendBase: String, slug: String): String =
    if (backendBase.isNotBlank()) "$backendBase/api/raffles/$slug/public" else BuildConfig.RAW_BASE

private suspend fun fetchRaffles(backendBase: String): List<RaffleSummary> {
    val arr = JSONObject(httpGet("$backendBase/api/raffles")).getJSONArray("raffles")
    return buildList {
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            add(
                RaffleSummary(
                    slug = o.getString("slug"),
                    title = o.getString("title"),
                    status = o.getString("status"),
                    sold = o.getInt("sold"),
                    total = o.getInt("total"),
                    priceCents = o.getLong("priceCents"),
                    max = o.getJSONObject("numberRange").getInt("max"),
                )
            )
        }
    }
}

private fun wompiCheckoutUrl(c: Checkout): String {
    fun e(s: String) = URLEncoder.encode(s, "UTF-8")
    return "https://checkout.wompi.co/p/" +
        "?public-key=${e(c.publicKey)}" +
        "&currency=COP" +
        "&amount-in-cents=${c.amountInCents}" +
        "&reference=${e(c.reference)}" +
        "&signature:integrity=${e(c.integritySignature)}" +
        "&redirect-url=${e(REDIRECT_URL)}"
}

private suspend fun reserve(backendBase: String, slug: String, number: Int, first: String, last: String, phone: String): Checkout {
    val body = JSONObject().apply {
        put("number", number)
        put("method", "WOMPI")
        put("buyer", JSONObject().apply {
            put("firstName", first); put("lastName", last); put("phone", phone)
        })
    }
    val res = JSONObject(httpPost("$backendBase/api/raffles/$slug/reserve", body.toString()))
    return Checkout(
        purchaseId = res.getString("purchaseId"),
        reference = res.getString("reference"),
        amountInCents = res.getLong("amountInCents"),
        publicKey = res.optString("publicKey", ""),
        integritySignature = res.optString("integritySignature", ""),
    )
}

private suspend fun pollPurchase(backendBase: String, purchaseId: String, attempts: Int = 8): String {
    repeat(attempts) {
        try {
            val st = JSONObject(httpGet("$backendBase/api/purchases/$purchaseId")).getString("status")
            if (st != "PENDING") return st
        } catch (_: Exception) { }
        delay(2000)
    }
    return "PENDING"
}

private suspend fun httpGet(urlStr: String): String = withContext(Dispatchers.IO) {
    val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
        connectTimeout = 10_000; readTimeout = 10_000; requestMethod = "GET"
        setRequestProperty("Accept", "application/json")
    }
    try {
        if (conn.responseCode !in 200..299) throw RuntimeException("HTTP ${conn.responseCode}")
        conn.inputStream.bufferedReader().use { it.readText() }
    } finally { conn.disconnect() }
}

private suspend fun httpPost(urlStr: String, body: String): String = withContext(Dispatchers.IO) {
    val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
        connectTimeout = 10_000; readTimeout = 10_000; requestMethod = "POST"
        doOutput = true
        setRequestProperty("Content-Type", "application/json")
        setRequestProperty("Accept", "application/json")
    }
    try {
        conn.outputStream.use { it.write(body.toByteArray()) }
        val code = conn.responseCode
        val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
            ?.bufferedReader()?.use { it.readText() } ?: ""
        if (code !in 200..299) {
            val msg = runCatching { JSONObject(text).getString("error") }.getOrDefault("HTTP $code")
            throw RuntimeException(msg)
        }
        text
    } finally { conn.disconnect() }
}

private suspend fun tryDrawJson(base: String): DrawWinner? = try {
    val w = JSONObject(httpGet("$base/draw.json")).optJSONObject("winner")
    if (w != null) DrawWinner(w.getInt("number"), w.getString("buyer")) else null
} catch (_: Exception) { null }

// ---------------------------------------------------------------------------
// Parsing / formato
// ---------------------------------------------------------------------------
private fun parseRaffle(o: JSONObject): Raffle {
    val range = o.getJSONObject("numberRange")
    return Raffle(
        title = o.getString("title"),
        prize = o.getString("prize"),
        description = o.optString("description", ""),
        priceCents = o.getLong("priceCents"),
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

private fun parseWinner(raffleJson: JSONObject): DrawWinner? {
    val w = raffleJson.optJSONObject("winner") ?: return null
    return DrawWinner(w.getInt("number"), w.getString("buyer"))
}

/**
 * Numero de rifa con ceros a la izquierda: 1 -> "001".
 * En Colombia el ganador suele salir de las ultimas 3 cifras de una loteria
 * externa, asi que "001" es un numero DISTINTO de "010" o "100".
 * El ancho sale del maximo del rango (999 -> 3 digitos, 99 -> 2).
 */
private fun padNum(n: Int, max: Int): String =
    n.toString().padStart(max.toString().length, '0')

private fun formatCop(cents: Long): String {
    val nf = NumberFormat.getCurrencyInstance(Locale("es", "CO"))
    nf.maximumFractionDigits = 0
    return nf.format(cents / 100.0)
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
