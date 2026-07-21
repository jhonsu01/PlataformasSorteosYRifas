plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Version gestionada externamente (el workflow de release inyecta el tag).
val appVersionName = (project.findProperty("appVersionName") as String?) ?: "1.0.0"
val appVersionCode = ((project.findProperty("appVersionCode") as String?) ?: "1").toInt()

// Backend por defecto: viene de fabrica para que el vendedor no tenga que escribir
// nada. Se puede cambiar con -PbackendBase=... o desde Ajustes dentro de la app.
val backendBase = (project.findProperty("backendBase") as String?)
    ?: "https://plataformas-sorteos-y-rifas.vercel.app"

// La UI del vendedor vive en apps/seller-web/src. Se copia a los assets en cada
// build: una sola fuente de verdad, sin copias que se desincronicen.
val syncSellerAssets by tasks.registering(Copy::class) {
    from("../../seller-web/src") {
        include("index.html", "main.js", "styles.css")
    }
    into("src/main/assets")
}
tasks.named("preBuild") { dependsOn(syncSellerAssets) }

android {
    namespace = "com.sorteosyrifas.seller"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.sorteosyrifas.seller"
        minSdk = 24
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
        buildConfigField("String", "DEFAULT_BACKEND", "\"$backendBase\"")
    }

    // Misma logica de firma que los demas APK: si hay keystore (CI) firma de
    // verdad; si no, usa la de debug para que el APK siga siendo instalable.
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
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
}
