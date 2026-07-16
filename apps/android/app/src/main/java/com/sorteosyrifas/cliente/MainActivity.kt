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
import androidx.compose.foundation.lazy.grid.GridItemSpan
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import coil.compose.AsyncImage
import kotlinx.coroutines.withContext
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
    // Vitrina del premio. Todos opcionales: una rifa creada antes de la v1.6.0
    // no los trae y la app debe seguir funcionando igual.
    val cover: String? = null,
    val prizeTotalCents: Long = 0,
    val prizeItems: List<PrizeItem> = emptyList(),
    // Responsable de la rifa (transparencia legal). Publico: viene en raffle.json.
    val organizer: Organizer = Organizer(),
)

/** Quien convoca la rifa y bajo que regimen. Todo opcional (rifas viejas). */
data class Organizer(
    val name: String = "",
    val regime: String = "",
    val authorization: String = "",
    val documents: List<String> = emptyList(),
)

/** Una cosa de las que componen el premio, con su valor. */
data class PrizeItem(val name: String, val description: String, val valueCents: Long)

/** Un medio de pago manual: "Nequi" -> "3200000000" ("A nombre de..."). */
data class PaymentMethod(val label: String, val value: String, val hint: String)

/**
 * Como se le paga a esta rifa (GET /api/raffles/:slug/payment).
 *
 * NO sale de raffle.json: los datos de cuenta no se publican al repo publico
 * (su historial es inmutable). Los sirve el backend a quien va a comprar.
 */
data class PaymentInfo(
    val gatewayEnabled: Boolean,
    val manualEnabled: Boolean,
    val methods: List<PaymentMethod>,
)

data class Sold(val number: Int, val buyer: String)
data class DrawWinner(val number: Int, val buyer: String)

/** Resumen para el selector de rifas (GET /api/raffles). */
data class RaffleSummary(
    val slug: String, val title: String, val status: String,
    val sold: Int, val total: Int, val priceCents: Long, val max: Int,
    val cover: String? = null,
    val prizeTotalCents: Long = 0,
)

/** Compra propia guardada en el dispositivo (ver MisNumeros). */
data class MiCompra(val purchaseId: String, val slug: String, val number: Int)

/**
 * Estado vivo de una compra propia (GET /api/purchases/:id).
 *
 * `method` y `hasReceipt` son lo que permite ofrecerle subir el comprobante al
 * que cerro el dialogo de pago y se fue a mirar otros numeros: sin ellos se
 * quedaba sin forma de mandarlo y habia que rechazarle la compra.
 */
data class EstadoCompra(
    val purchaseId: String,
    val number: Int,
    val status: String,
    val method: String = "",
    val hasReceipt: Boolean = false,
) {
    /** Le falta el comprobante y todavia esta a tiempo de mandarlo. */
    val puedeSubirComprobante: Boolean
        get() = status == "PENDING" && method == "MANUAL" && !hasReceipt
}

data class Checkout(
    val purchaseId: String, val reference: String, val amountInCents: Long,
    val publicKey: String, val integritySignature: String,
)

private val BrandViolet = Color(0xFF7C3AED)
private val BrandPink = Color(0xFFDB2777)
private val Gold = Color(0xFFFBBF24)
private val FreeGray = Color(0xFFEDEAF5)
// Apartado por otro: ni libre ni vendido. Ambar apagado para que se distinga del
// violeta de "vendido" sin gritar tanto como el oro del ganador.
private val Apartado = Color(0xFFD9CBA8)

private const val REDIRECT_URL = "https://sorteosyrifas.app/resultado"
private const val KOFI_URL = "https://ko-fi.com/V7V81LV7GX"

// Mismo texto que el README, la web y el admin.
private const val DISCLAIMER =
    "Sorteos y Rifas es software libre, entregado «tal cual», sin garantías. En la mayoría de " +
        "los países las rifas y sorteos están regulados por la ley. La persona u organización que " +
        "crea y opera cada sorteo es la única responsable de cumplir la normativa y obtener los " +
        "permisos de su jurisdicción, de recaudar y administrar los pagos, y de entregar el premio. " +
        "El autor del software no organiza sorteos ni se responsabiliza del uso que terceros den a " +
        "esta herramienta ni de la legalidad de los sorteos creados con ella. Este texto no " +
        "constituye asesoría legal."

private fun regimeEs(r: String) = when (r) {
    "REGULADA" -> "Sorteo regulado"
    "DESCENTRALIZADA" -> "Sorteo descentralizado"
    else -> null
}

/** Abre una URL en el navegador del sistema. */
private fun abrirUrl(ctx: android.content.Context, url: String) {
    runCatching {
        ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)))
    }
}

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
        Column {
            // Solo si la rifa tiene portada: sin foto no se deja un hueco gris.
            r.cover?.let { url ->
                AsyncImage(
                    model = url,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxWidth().aspectRatio(16f / 9f),
                )
            }
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
                if (r.prizeTotalCents > 0) {
                    Text(
                        "Premio: ${formatCop(r.prizeTotalCents)}",
                        color = BrandViolet, fontSize = 14.sp, fontWeight = FontWeight.Bold,
                    )
                }
                Text("${formatCop(r.priceCents)} por número", color = Color.Gray, fontSize = 13.sp)
                Text("Vendidos: ${r.sold} de ${r.total}", color = Color.Gray, fontSize = 13.sp)
            }
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
    // Pago manual en curso: numero + compra ya reservada, esperando comprobante.
    var manual by remember { mutableStateOf<Pair<Int, String>?>(null) }
    var subiendo by remember { mutableStateOf(false) }
    var pago by remember { mutableStateOf(PaymentInfo(true, true, emptyList())) }
    // Numeros apartados por otros AHORA MISMO. No estan en numbers.json (eso es
    // el estado publicado y una reserva dura minutos): se piden al backend.
    var apartados by remember { mutableStateOf<Set<Int>>(emptySet()) }

    LaunchedEffect(reload, backendBase, slug) {
        loading = true
        try {
            val base = publicBase(backendBase, slug)
            val rJson = JSONObject(httpGet("$base/raffle.json"))
            val nJson = JSONObject(httpGet("$base/numbers.json"))
            raffle = parseRaffle(rJson)
            sold = parseSold(nJson)
            winner = parseWinner(rJson) ?: tryDrawJson(base)
            // Los medios de pago no estan en raffle.json (no se publican al repo):
            // se piden aparte. Si falla, se deja el valor por defecto y la compra
            // sigue: no vale la pena tumbar la pantalla entera por esto.
            pago = runCatching { fetchPaymentInfo(backendBase, slug) }.getOrDefault(pago)
            // Si falla, la rejilla los pinta libres y el 409 lo explica: no vale
            // la pena tumbar la pantalla por un dato de conveniencia.
            apartados = runCatching { fetchHeld(backendBase, slug) }.getOrDefault(emptySet())
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
                raffle = raffle!!, sold = sold, winner = winner, apartados = apartados,
                onCambiarRifa = onCambiarRifa,
                onMisNumeros = { showMisNumeros = true },
                onPickNumber = { n ->
                    when {
                        raffle!!.status != "ACTIVE" -> busyMsg = "El sorteo no está activo."
                        // Se avisa ANTES de intentar reservar. El backend lo
                        // rechazaria igual, pero el comprador merece saberlo sin
                        // tener que llenar el formulario para nada.
                        n in apartados -> busyMsg =
                            "El número ${padNum(n, raffle!!.max)} está apartado por otra persona " +
                                "o esperando que se verifique un pago. Si no se completa volverá " +
                                "a quedar libre; mientras tanto, elige otro."
                        else -> buyNumber = n
                    }
                },
            )
        }

        buyNumber?.let { n ->
            PurchaseDialog(
                etiqueta = padNum(n, raffle!!.max), priceCents = raffle!!.priceCents,
                pago = pago,
                onDismiss = { buyNumber = null },
                onConfirm = { first, last, phone, metodo ->
                    buyNumber = null
                    busyMsg = "Reservando número ${padNum(n, raffle!!.max)}…"
                    scope.launch {
                        try {
                            val c = reserve(backendBase, slug, n, first, last, phone, metodo)
                            // Se guarda ANTES de pagar: si el pago queda pendiente,
                            // el comprador igual puede seguirlo en "Mis números".
                            guardarMiCompra(prefs, MiCompra(c.purchaseId, slug, n))
                            busyMsg = null
                            if (metodo == "MANUAL") {
                                manual = n to c.purchaseId
                            } else if (c.publicKey.isBlank()) {
                                busyMsg = "El sorteo no tiene pagos configurados todavía."
                            } else checkout = c
                        } catch (e: Exception) {
                            busyMsg = "No se pudo reservar: ${e.message}"
                        }
                    }
                },
            )
        }

        manual?.let { (n, purchaseId) ->
            val ctx = LocalContext.current
            ManualPaymentDialog(
                etiqueta = padNum(n, raffle!!.max),
                priceCents = raffle!!.priceCents,
                metodos = pago.methods,
                subiendo = subiendo,
                onDismiss = {
                    manual = null
                    // No se pierde: el numero sigue reservado y la compra quedo en
                    // "Mis números", asi que puede volver y subirlo mas tarde.
                    busyMsg = "Tu número ${padNum(n, raffle!!.max)} sigue apartado. " +
                        "Puedes subir el comprobante desde \"Mis números\"."
                },
                onSubirComprobante = { uri ->
                    subiendo = true
                    scope.launch {
                        try {
                            val bytes = withContext(Dispatchers.IO) { comprimirComprobante(ctx, uri) }
                            val msg = uploadReceipt(backendBase, purchaseId, bytes)
                            manual = null
                            busyMsg = msg
                            reload++
                        } catch (e: Exception) {
                            busyMsg = "No se pudo enviar el comprobante: ${e.message}"
                        } finally {
                            subiendo = false
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
            onPagar = { n, purchaseId ->
                // Reabre la pantalla de pago de una compra que YA existe: no se
                // reserva de nuevo (el numero ya es suyo), solo se retoma.
                showMisNumeros = false
                manual = n to purchaseId
            },
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
    raffle: Raffle, sold: List<Sold>, winner: DrawWinner?, apartados: Set<Int>,
    onCambiarRifa: () -> Unit, onMisNumeros: () -> Unit, onPickNumber: (Int) -> Unit,
) {
    val soldByNumber = remember(sold) { sold.associateBy { it.number } }
    val total = (raffle.max - raffle.min + 1).coerceAtLeast(0)
    val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()

    Column(Modifier.fillMaxSize()) {
        Header(raffle, sold.size, total, onCambiarRifa, onMisNumeros)
        if (winner != null) WinnerBanner(winner, raffle.max)
        Legend(hayApartados = apartados.isNotEmpty())
        LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 62.dp),
            contentPadding = PaddingValues(16.dp, 16.dp, 16.dp, 16.dp + navBottom),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.fillMaxSize(),
        ) {
            gridItems((raffle.min..raffle.max).toList()) { n ->
                val s = soldByNumber[n]
                NumberCell(padNum(n, raffle.max), s, winner?.number == n, n in apartados) {
                    if (s == null) onPickNumber(n)
                }
            }
            // Pie a lo ancho de toda la rejilla: responsable + descargo legal.
            item(span = { GridItemSpan(maxLineSpan) }) {
                RaffleFooter(raffle.organizer)
            }
        }
    }
}

@Composable
private fun RaffleFooter(organizer: Organizer) {
    val ctx = LocalContext.current
    val regimen = regimeEs(organizer.regime)
    Column(Modifier.fillMaxWidth().padding(top = 20.dp)) {
        // Bloque del responsable: solo si el organizador declaro algo.
        if (organizer.name.isNotBlank() || regimen != null) {
            Column(
                Modifier.fillMaxWidth()
                    .background(FreeGray, RoundedCornerShape(14.dp))
                    .padding(16.dp)
            ) {
                Text("Responsable de este sorteo", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                if (organizer.name.isNotBlank()) {
                    Text(organizer.name, fontSize = 15.sp, modifier = Modifier.padding(top = 4.dp))
                }
                if (regimen != null) {
                    Text(regimen, fontSize = 12.sp, color = BrandViolet, fontWeight = FontWeight.Medium)
                }
                if (organizer.authorization.isNotBlank()) {
                    Text(organizer.authorization, fontSize = 12.sp, color = Color.Gray, modifier = Modifier.padding(top = 4.dp))
                }
                organizer.documents.forEachIndexed { i, url ->
                    Text(
                        "Documento ${i + 1} ↗",
                        fontSize = 12.sp, color = BrandViolet,
                        modifier = Modifier.padding(top = 4.dp).clickable { abrirUrl(ctx, url) },
                    )
                }
                Text(
                    "La organización y la legalidad de este sorteo son responsabilidad de quien lo convoca.",
                    fontSize = 11.sp, color = Color.Gray, modifier = Modifier.padding(top = 8.dp),
                )
            }
        }
        Text(
            "Software libre «tal cual». El organizador es el único responsable de la legalidad, " +
                "los pagos y la entrega del premio.",
            fontSize = 10.sp, color = Color.Gray,
            modifier = Modifier.padding(top = 12.dp),
        )
    }
}

@Composable
private fun Header(
    raffle: Raffle, soldCount: Int, total: Int,
    onCambiarRifa: () -> Unit, onMisNumeros: () -> Unit,
) {
    Box(Modifier.fillMaxWidth()) {
        // La portada va DETRAS del degradado, que se vuelve semitransparente para
        // dejarla ver. Sin portada el degradado es opaco: si fuera translucido
        // siempre, se veria el blanco del Surface por debajo.
        raffle.cover?.let { url ->
            AsyncImage(
                model = url,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.matchParentSize(),
            )
        }
        val degradado = if (raffle.cover != null) {
            Brush.verticalGradient(listOf(BrandViolet.copy(alpha = 0.86f), BrandPink.copy(alpha = 0.94f)))
        } else {
            Brush.verticalGradient(listOf(BrandViolet, BrandPink))
        }
        Box(
            Modifier.fillMaxWidth()
                .background(degradado)
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
            // El comprador ve cuanto vale lo que puede ganar ANTES de pagar.
            if (raffle.prizeTotalCents > 0) {
                Spacer(Modifier.height(8.dp))
                Text(
                    "Valor del premio: ${formatCop(raffle.prizeTotalCents)}",
                    color = Gold, fontSize = 16.sp, fontWeight = FontWeight.Bold,
                )
                if (raffle.prizeItems.size > 1) {
                    Text(
                        "${raffle.prizeItems.size} ítems incluidos",
                        color = Color.White.copy(alpha = 0.85f), fontSize = 12.sp,
                    )
                }
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
}

// ---------------------------------------------------------------------------
// Mis números
// ---------------------------------------------------------------------------
@Composable
private fun MisNumerosDialog(
    backendBase: String, prefs: SharedPreferences, slug: String, max: Int,
    onPagar: (Int, String) -> Unit,
    onDismiss: () -> Unit,
) {
    val mias = remember { leerMisCompras(prefs, slug) }
    var loading by remember { mutableStateOf(true) }
    var estados by remember { mutableStateOf<List<EstadoCompra>>(emptyList()) }

    LaunchedEffect(Unit) {
        estados = mias.map { c ->
            try {
                val o = JSONObject(httpGet("$backendBase/api/purchases/${c.purchaseId}"))
                EstadoCompra(
                    purchaseId = c.purchaseId,
                    number = o.getInt("number"),
                    status = o.getString("status"),
                    method = o.optString("method", ""),
                    hasReceipt = o.optBoolean("hasReceipt", false),
                )
            } catch (_: Exception) {
                EstadoCompra(c.purchaseId, c.number, "DESCONOCIDO")
            }
        }
        loading = false
    }

    // Los que esperan comprobante van ARRIBA: es lo unico aqui que pide accion.
    val ordenados = estados.sortedByDescending { it.puedeSubirComprobante }

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
                else -> Column(Modifier.verticalScroll(rememberScrollState())) {
                    Text(
                        "Se guardan en este dispositivo. Si desinstalas la app o cambias de " +
                            "teléfono, esta lista se pierde (tu compra no).",
                        fontSize = 11.sp, color = Color.Gray,
                    )
                    Spacer(Modifier.height(12.dp))
                    ordenados.forEach { e ->
                        Column(Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(
                                    Modifier.background(colorEstado(e.status), RoundedCornerShape(10.dp))
                                        .padding(horizontal = 12.dp, vertical = 8.dp)
                                ) { Text(padNum(e.number, max), color = Color.White, fontWeight = FontWeight.Bold) }
                                Spacer(Modifier.width(12.dp))
                                Text(
                                    if (e.puedeSubirComprobante) "Falta tu comprobante" else textoEstado(e.status),
                                    fontSize = 14.sp,
                                    modifier = Modifier.weight(1f),
                                )
                            }
                            // El camino de vuelta: si cerro el dialogo de pago y se
                            // fue a mirar otros numeros, aqui lo recupera. Sin esto
                            // se quedaba sin forma de mandarlo y al administrador le
                            // tocaba RECHAZARLE la compra para liberar el numero.
                            if (e.puedeSubirComprobante) {
                                Button(
                                    onClick = { onPagar(e.number, e.purchaseId) },
                                    modifier = Modifier.padding(start = 56.dp, top = 4.dp),
                                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp),
                                ) { Text("Ver datos de pago y subir", fontSize = 12.sp) }
                            }
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
private fun Legend(hayApartados: Boolean) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        LegendItem(BrandViolet, "Vendido")
        LegendItem(FreeGray, "Libre")
        // Solo si los hay: una leyenda con un color que no esta en pantalla confunde.
        if (hayApartados) LegendItem(Apartado, "Apartado")
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
private fun NumberCell(
    etiqueta: String, sold: Sold?, isWinner: Boolean, apartado: Boolean, onClick: () -> Unit,
) {
    val bg = when {
        isWinner -> Gold
        sold != null -> BrandViolet
        // Apartado: se ve tomado pero se deja tocar, para poder explicar por que
        // no esta disponible. Un numero muerto que no responde no ensena nada.
        apartado -> Apartado
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
            when {
                sold != null -> Text(
                    sold.buyer, color = fg.copy(alpha = 0.9f), fontSize = 8.sp,
                    maxLines = 1, textAlign = TextAlign.Center,
                )
                // No se dice QUIEN lo aparto: el backend tampoco lo revela.
                apartado -> Text(
                    "apartado", color = fg.copy(alpha = 0.8f), fontSize = 7.sp,
                    maxLines = 1, textAlign = TextAlign.Center,
                )
            }
        }
    }
}

@Composable
private fun PurchaseDialog(
    etiqueta: String, priceCents: Long,
    pago: PaymentInfo,
    onDismiss: () -> Unit,
    onConfirm: (String, String, String, String) -> Unit,
) {
    var first by remember { mutableStateOf("") }
    var last by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    // Si la rifa solo acepta uno, no se pregunta: se usa ese.
    var metodo by remember {
        mutableStateOf(if (pago.gatewayEnabled) "WOMPI" else "MANUAL")
    }
    val puedeElegir = pago.gatewayEnabled && pago.manualEnabled

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Comprar número $etiqueta") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
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

                if (puedeElegir) {
                    Spacer(Modifier.height(14.dp))
                    Text("¿Cómo quieres pagar?", fontWeight = FontWeight.Medium, fontSize = 13.sp)
                    Row(
                        Modifier.selectableGroup().padding(top = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        MetodoChip("Tarjeta / PSE", metodo == "WOMPI") { metodo = "WOMPI" }
                        Spacer(Modifier.width(8.dp))
                        MetodoChip("Transferencia", metodo == "MANUAL") { metodo = "MANUAL" }
                    }
                    if (metodo == "MANUAL") {
                        Text(
                            "Pagas por Nequi o transferencia y subes el comprobante. " +
                                "Un administrador lo verifica.",
                            fontSize = 11.sp, color = Color.Gray, modifier = Modifier.padding(top = 6.dp),
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = first.isNotBlank() && last.isNotBlank(),
                onClick = { onConfirm(first.trim(), last.trim(), phone.trim(), metodo) },
            ) { Text(if (metodo == "MANUAL") "Ver datos de pago" else "Ir a pagar") }
        },
        dismissButton = { TextButton(onDismiss) { Text("Cancelar") } },
    )
}

@Composable
private fun MetodoChip(texto: String, activo: Boolean, onClick: () -> Unit) {
    Box(
        Modifier
            .selectable(selected = activo, onClick = onClick, role = Role.RadioButton)
            .background(
                if (activo) BrandViolet else FreeGray,
                RoundedCornerShape(20.dp),
            )
            .padding(horizontal = 14.dp, vertical = 8.dp)
    ) {
        Text(
            texto,
            color = if (activo) Color.White else Color.Gray,
            fontSize = 12.sp,
            fontWeight = if (activo) FontWeight.Bold else FontWeight.Normal,
        )
    }
}

// ---------------------------------------------------------------------------
// Pago manual
// ---------------------------------------------------------------------------

/**
 * Paga tu mismo y manda el pantallazo.
 *
 * El numero ya esta reservado a nombre de esta compra. En cuanto sube el
 * comprobante deja de expirar: queda retenido hasta que un administrador lo
 * verifique. Por eso se le dice explicitamente, o creeria que puede perderlo.
 */
@Composable
private fun ManualPaymentDialog(
    etiqueta: String,
    priceCents: Long,
    metodos: List<PaymentMethod>,
    onSubirComprobante: (android.net.Uri) -> Unit,
    onDismiss: () -> Unit,
    subiendo: Boolean,
) {
    val portapapeles = LocalClipboardManager.current
    var copiado by remember { mutableStateOf<String?>(null) }

    // Selector de fotos del sistema: NO pide permiso de almacenamiento (el
    // usuario elige la foto y solo esa se comparte con la app).
    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri -> if (uri != null) onSubirComprobante(uri) }

    AlertDialog(
        onDismissRequest = { if (!subiendo) onDismiss() },
        title = { Text("Paga el número $etiqueta") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(
                    "Transfiere ${formatCop(priceCents)} a cualquiera de estas cuentas:",
                    fontSize = 14.sp,
                )
                Spacer(Modifier.height(12.dp))

                metodos.forEach { m ->
                    Card(
                        Modifier.fillMaxWidth().padding(bottom = 8.dp),
                        colors = CardDefaults.cardColors(containerColor = FreeGray),
                    ) {
                        Row(
                            Modifier.padding(12.dp).fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(m.label, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                                Text(m.value, fontSize = 16.sp, fontWeight = FontWeight.Medium)
                                if (m.hint.isNotBlank()) {
                                    Text(m.hint, fontSize = 11.sp, color = Color.Gray)
                                }
                            }
                            TextButton(onClick = {
                                // Copiar SOLO el dato, sin la etiqueta: se pega
                                // directo en Nequi sin tener que limpiarlo.
                                portapapeles.setText(AnnotatedString(m.value))
                                copiado = m.label
                            }) { Text(if (copiado == m.label) "✓ Copiado" else "Copiar") }
                        }
                    }
                }

                Spacer(Modifier.height(8.dp))
                Text(
                    "Tu número ${etiqueta} ya está apartado. Sube el comprobante y " +
                        "queda reservado hasta que lo verifiquemos.",
                    fontSize = 12.sp, color = Color.Gray,
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = !subiendo,
                onClick = {
                    picker.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                    )
                },
            ) { Text(if (subiendo) "Enviando…" else "Subir comprobante") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !subiendo) { Text("Después") } },
    )
}

@Composable
private fun SettingsDialog(backendBase: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var b by remember { mutableStateOf(backendBase) }
    val ctx = LocalContext.current
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Ajustes avanzados") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(
                    "La app ya viene configurada. Cambia esto solo si el organizador " +
                        "te indicó otro servidor.",
                    fontSize = 12.sp, color = Color.Gray,
                )
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(b, { b = it }, label = { Text("Servidor") }, singleLine = true)

                Spacer(Modifier.height(20.dp))
                Text("Apoyo", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                Text(
                    // Se aclara que es apoyo al SOFTWARE, no un pago de la rifa: el
                    // comprador no debe confundirlo con la compra de un número.
                    "Esta app es software libre y gratuito. Apoyar es voluntario y va al " +
                        "desarrollo de la app, no a ningún sorteo.",
                    fontSize = 11.sp, color = Color.Gray, modifier = Modifier.padding(top = 2.dp),
                )
                Button(
                    onClick = { abrirUrl(ctx, KOFI_URL) },
                    modifier = Modifier.padding(top = 8.dp),
                ) { Text("☕ Apoyar el desarrollo") }

                Spacer(Modifier.height(20.dp))
                Text("Descargo de responsabilidad", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                Text(DISCLAIMER, fontSize = 10.sp, color = Color.Gray, modifier = Modifier.padding(top = 4.dp))
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
                    // opt*: una rifa sin premio montado sigue apareciendo.
                    cover = o.optString("cover").ifBlank { null },
                    prizeTotalCents = o.optLong("prizeTotalCents", 0),
                )
            )
        }
    }
}

/**
 * Numeros apartados ahora mismo por otras personas.
 *
 * No salen de numbers.json (ese es el estado publicado y una reserva dura
 * minutos): los sirve el backend. Solo numeros, sin identidad.
 */
private suspend fun fetchHeld(backendBase: String, slug: String): Set<Int> {
    val arr = JSONObject(httpGet("$backendBase/api/raffles/$slug/held")).getJSONArray("held")
    return buildSet { for (i in 0 until arr.length()) add(arr.getInt(i)) }
}

private suspend fun fetchPaymentInfo(backendBase: String, slug: String): PaymentInfo {
    val o = JSONObject(httpGet("$backendBase/api/raffles/$slug/payment"))
    val arr = o.optJSONArray("paymentMethods")
    return PaymentInfo(
        // Por defecto TRUE: una rifa creada antes de la v1.7.0 no trae los campos
        // y debe seguir comportandose como siempre (pasarela disponible).
        gatewayEnabled = o.optBoolean("gatewayEnabled", true),
        manualEnabled = o.optBoolean("manualEnabled", true),
        methods = buildList {
            for (i in 0 until (arr?.length() ?: 0)) {
                val m = arr!!.getJSONObject(i)
                add(
                    PaymentMethod(
                        label = m.optString("label", ""),
                        value = m.optString("value", ""),
                        hint = m.optString("hint", ""),
                    )
                )
            }
        },
    )
}

/**
 * Reduce el pantallazo antes de subirlo.
 *
 * Un screenshot de un movil moderno son 2-4 MB. El backend corta en 1,2 MB y
 * Vercel el cuerpo entero en ~4,5 MB (y base64 infla un 33%). 1280 px de ancho
 * basta de sobra para leer un comprobante de Nequi y deja el archivo en ~150 KB.
 */
private fun comprimirComprobante(ctx: android.content.Context, uri: android.net.Uri): ByteArray {
    val bitmap = ctx.contentResolver.openInputStream(uri).use { input ->
        android.graphics.BitmapFactory.decodeStream(input)
    } ?: throw Exception("No se pudo leer la imagen")

    val maxLado = 1280
    val escala = minOf(1f, maxLado.toFloat() / maxOf(bitmap.width, bitmap.height))
    val escalado = if (escala < 1f) {
        android.graphics.Bitmap.createScaledBitmap(
            bitmap, (bitmap.width * escala).toInt(), (bitmap.height * escala).toInt(), true,
        )
    } else bitmap

    val out = java.io.ByteArrayOutputStream()
    escalado.compress(android.graphics.Bitmap.CompressFormat.JPEG, 82, out)
    return out.toByteArray()
}

/** Sube el comprobante. A partir de aqui el numero queda retenido para el admin. */
private suspend fun uploadReceipt(backendBase: String, purchaseId: String, bytes: ByteArray): String {
    val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
    val body = JSONObject().apply { put("base64", b64); put("mime", "image/jpeg") }
    val r = JSONObject(httpPost("$backendBase/api/purchases/$purchaseId/receipt", body.toString(), 30_000))
    return r.optString("mensaje", "Comprobante enviado")
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

private suspend fun reserve(
    backendBase: String, slug: String, number: Int,
    first: String, last: String, phone: String,
    method: String = "WOMPI",
): Checkout {
    val body = JSONObject().apply {
        put("number", number)
        put("method", method)
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

/**
 * @param timeoutMs por defecto 10 s. Subir el comprobante manda ~200 KB: por
 * datos moviles flojos eso pasa de 10 s facil, y el comprador veria un error
 * cuando en realidad solo iba lento.
 */
private suspend fun httpPost(urlStr: String, body: String, timeoutMs: Int = 10_000): String = withContext(Dispatchers.IO) {
    val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
        connectTimeout = timeoutMs; readTimeout = timeoutMs; requestMethod = "POST"
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
    // opt* en todo lo nuevo: las rifas creadas antes de la v1.6.0 no traen estos
    // campos y un get* estricto reventaria el parseo de una rifa que funciona.
    val items = o.optJSONArray("prizeItems")
    return Raffle(
        title = o.getString("title"),
        prize = o.getString("prize"),
        description = o.optString("description", ""),
        priceCents = o.getLong("priceCents"),
        min = range.getInt("min"),
        max = range.getInt("max"),
        status = o.getString("status"),
        cover = o.optJSONObject("media")?.optString("cover")?.ifBlank { null },
        prizeTotalCents = o.optLong("prizeTotalCents", 0),
        organizer = o.optJSONObject("organizer")?.let { org ->
            val docs = org.optJSONArray("documents")
            Organizer(
                name = org.optString("name", ""),
                regime = org.optString("regime", ""),
                authorization = org.optString("authorization", ""),
                documents = buildList { for (i in 0 until (docs?.length() ?: 0)) add(docs!!.getString(i)) },
            )
        } ?: Organizer(),
        prizeItems = buildList {
            for (i in 0 until (items?.length() ?: 0)) {
                val item = items!!.getJSONObject(i)
                add(
                    PrizeItem(
                        name = item.optString("name", ""),
                        description = item.optString("description", ""),
                        valueCents = item.optLong("valueCents", 0),
                    )
                )
            }
        },
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
