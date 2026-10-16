import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// The APK carries the repo's release version, read from the root package.json
// rather than kept here, so a release tag cannot ship an APK that says
// something else. scripts/check-release-version.js already holds the tag to
// that file. versionCode must only ever grow: MAJOR*10000 + MINOR*100 + PATCH.
val releaseVersion = (JsonSlurper().parse(rootDir.resolve("../package.json")) as Map<*, *>)["version"] as String
val releaseVersionCode = releaseVersion.substringBefore('-').split('.').map(String::toInt)
    .let { (major, minor, patch) -> major * 10000 + minor * 100 + patch }

// Release signing comes from the environment, never from a file in the repo.
// Without it the release APK is built unsigned, which compiles but will not
// install. CI refuses to publish one; see .github/workflows/release.yml.
val releaseKeystore = System.getenv("ZOIA_ANDROID_KEYSTORE")?.takeIf { it.isNotBlank() }

android {
    namespace = "im.zoia"
    compileSdk = 34

    defaultConfig {
        applicationId = "im.zoia"
        minSdk = 29
        targetSdk = 34
        versionCode = releaseVersionCode
        versionName = releaseVersion

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("ZOIA_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ZOIA_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ZOIA_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            if (releaseKeystore != null) signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            applicationIdSuffix = ".debug"
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
    }
}

dependencies {
    // Core Android & Lifecycle
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
    implementation("androidx.activity:activity-compose:1.9.3")

    // Jetpack Compose & Material 3
    implementation(platform("androidx.compose:compose-bom:2024.10.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    // LiveKit Android SDK (Official WebRTC Client)
    implementation("io.livekit:livekit-android:2.12.0")

    // Network & JSON
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // Secure Storage (Android Keystore + EncryptedSharedPreferences)
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // Testing
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}
