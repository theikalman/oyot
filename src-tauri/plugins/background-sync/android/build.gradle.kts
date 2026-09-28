plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.ajiyakin.oyot.backgroundsync"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    // The periodic background run (ADR 0034, decision 5).
    implementation("androidx.work:work-runtime:2.10.2")
    // Whether the app is on screen, for the whole process rather than one
    // activity. Tauri already depends on it.
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    implementation(project(":tauri-android"))
}
