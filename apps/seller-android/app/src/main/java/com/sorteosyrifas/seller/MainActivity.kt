package com.sorteosyrifas.seller

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

/**
 * App de VENDEDOR en Android: un WebView que carga la interfaz de vendedor
 * (apps/seller-web/src, copiada a los assets en cada build). Con permisos de
 * OPERATOR el vendedor solo ve sus rifas asignadas y verifica pagos manuales.
 *
 * La UI se sirve desde un origen https VIRTUAL (appassets.androidplatform.net) via
 * WebViewAssetLoader: asi el `fetch` al backend (CORS `*`) y el `localStorage`
 * (donde vive el refresh token) se comportan como en una web real.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView

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

            webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                    assetLoader.shouldInterceptRequest(request.url)

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url
                    // La UI vive en appassets; cualquier otro host se abre en el navegador.
                    if (url.host == "appassets.androidplatform.net") return false
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                    return true
                }

                override fun onPageFinished(view: WebView, url: String?) {
                    // Dos huecos que en la web cubre el entorno y aqui no:
                    //  1) si no hay backend configurado, se fija el de fabrica;
                    //  2) se inyecta la version real en el pie.
                    view.evaluateJavascript(
                        """
                        (function(){
                          try {
                            if (!localStorage.getItem('srSellerCfg')) {
                              localStorage.setItem('srSellerCfg', JSON.stringify({
                                backendUrl: '${BuildConfig.DEFAULT_BACKEND}'
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
        }

        setContentView(web)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })

        web.loadUrl("https://appassets.androidplatform.net/assets/index.html")
    }
}
