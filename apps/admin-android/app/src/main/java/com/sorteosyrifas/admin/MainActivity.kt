package com.sorteosyrifas.admin

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

/**
 * Admin en Android: un WebView que carga la MISMA interfaz del admin de escritorio
 * (apps/admin-windows/src, copiada a los assets en cada build). No se reimplementa
 * nada: login, 2FA, rifas, comprobantes, ganadores y apoyo son exactamente los del
 * escritorio, y se inicia sesion con las mismas credenciales.
 *
 * La UI se sirve desde un origen https VIRTUAL (appassets.androidplatform.net) via
 * WebViewAssetLoader: asi el `fetch` al backend (que responde CORS `*`) y el
 * `localStorage` (donde vive el refresh token) se comportan como en una web real.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    // Selector de archivos para <input type=file> (subir imagenes del premio).
    private val fileChooser =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            fileCallback?.onReceiveValue(uris)
            fileCallback = null
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT,
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true       // localStorage: sesion persistente
            settings.mediaPlaybackRequiresUserGesture = false

            webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                    assetLoader.shouldInterceptRequest(request.url)

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url
                    // La UI del admin vive en appassets; cualquier otro host (Ko-fi,
                    // GitHub, la web publica de una rifa) se abre en el navegador.
                    if (url.host == "appassets.androidplatform.net") return false
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                    return true
                }

                override fun onPageFinished(view: WebView, url: String?) {
                    // El admin de escritorio pide la version y abre enlaces via
                    // comandos de Tauri, que aqui no existen. Se cubren dos huecos:
                    //  1) si no hay backend configurado, se fija el de fabrica;
                    //  2) se inyecta la version real en el pie.
                    view.evaluateJavascript(
                        """
                        (function(){
                          try {
                            if (!localStorage.getItem('srCfg')) {
                              localStorage.setItem('srCfg', JSON.stringify({
                                backendUrl: '${BuildConfig.DEFAULT_BACKEND}',
                                raffleSlug: 'sorteo-demo', pollSeconds: 15
                              }));
                              location.reload();
                              return;
                            }
                            var e = document.getElementById('app-version');
                            if (e) e.textContent = '${BuildConfig.VERSION_NAME}';
                          } catch (_) {}
                        })();
                        """.trimIndent(),
                        null,
                    )
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    webView: WebView,
                    callback: ValueCallback<Array<Uri>>,
                    params: FileChooserParams,
                ): Boolean {
                    fileCallback?.onReceiveValue(null)
                    fileCallback = callback
                    return runCatching { fileChooser.launch(params.createIntent()); true }
                        .getOrElse { fileCallback = null; false }
                }
            }
        }

        setContentView(web)

        // El boton "atras" navega dentro del WebView (p. ej. cerrar una vista)
        // antes de salir de la app.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })

        web.loadUrl("https://appassets.androidplatform.net/assets/index.html")
    }
}
