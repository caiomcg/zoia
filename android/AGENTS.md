# android/AGENTS.md

**On hold since 2026-10-28:** work is focused on the Windows and macOS desktop app. Don't plan,
build or verify Android changes unless asked. Spec: [SPEC-android.md](../SPEC-android.md).

The Android viewer watches and never publishes (Kotlin, Compose, LiveKit Android SDK).

## Building (from WSL)

Needs the SDK at `~/Android/Sdk` and OpenJDK 17. Set both explicitly: `~/Android/android-env.sh`
points `ANDROID_HOME` at `~/Android`, not the SDK, and the build then fails to find it.

```bash
cd android
export ANDROID_HOME=$HOME/Android/Sdk JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
./gradlew --no-daemon :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

Install over USB with the **Windows** `adb.exe` (`adb.exe install -r <apk>`); WSL's `adb` does
not see USB devices. Release APKs are signed in CI only (`release.yml`).

## When Android is active again

Android shows whatever the desktop publishes. A change to what the desktop sends (track sources,
the `-gpu` ingress, metadata, a new kind of picture) must be checked against
`app/src/main/kotlin/im/zoia/livekit/LiveKitRoomManager.kt`. The LiveKit Android SDK has no
`ScreenShareAudio` source; match on "not `MICROPHONE`" instead.
