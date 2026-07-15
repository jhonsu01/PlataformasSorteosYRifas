import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// --- Version gestionada externamente (el workflow de release inyecta el tag) ---
val appVersionName = (project.findProperty("appVersionName") as String?) ?: "1.0.0"
val appVersionCode = ((project.findProperty("appVersionCode") as String?) ?: "1").toInt()

// URL raw del repo GitHub que sirve el JSON publico de la rifa (privacidad por diseno).
// Un replicador puede sobreescribirla con -PrawBase=... sin tocar el codigo.
val rawBase = (project.findProperty("rawBase") as String?)
    ?: "https://raw.githubusercontent.com/jhonsu01/PlataformasSorteosYRifas/main/examples/sorteo-demo/public"

// URL del backend por defecto (para comprar). Vacia = solo consulta; el usuario
// puede fijarla desde los ajustes (⚙) de la app sin recompilar.
val backendBase = (project.findProperty("backendBase") as String?) ?: ""

android {
    namespace = "com.sorteosyrifas.cliente"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.sorteosyrifas.cliente"
        minSdk = 24
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
        buildConfigField("String", "RAW_BASE", "\"$rawBase\"")
        buildConfigField("String", "BACKEND_BASE", "\"$backendBase\"")
    }

    // Firma de release: si hay keystore (CI), firma de verdad; si no, usa la de debug
    // para que `assembleRelease` siga produciendo un APK instalable en local.
    val keystoreFile = System.getenv("KEYSTORE_FILE")
    signingConfigs {
        create("release") {
            if (keystoreFile != null && file(keystoreFile).exists()) {
                storeFile = file(keystoreFile)
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KEY_ALIAS")
                keyPassword = System.getenv("KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = if (keystoreFile != null && file(keystoreFile).exists()) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
