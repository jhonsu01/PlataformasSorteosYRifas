// Build script raiz. Los plugins reales se aplican en :app.
// Sin Compose: esta app es un WebView que carga la MISMA interfaz del admin de
// escritorio (apps/admin-windows/src). Asi "administrar desde el celular" es
// literalmente lo mismo del escritorio, sin reimplementar nada.
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
