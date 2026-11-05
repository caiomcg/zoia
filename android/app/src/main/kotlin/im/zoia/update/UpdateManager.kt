package im.zoia.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import im.zoia.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

data class UpdateInfo(
    val version: String,
    val versionCode: Int,
    val downloadUrl: String,
    val fileName: String,
    val releaseNotes: String,
    val isUnsigned: Boolean = false
)

sealed class UpdateState {
    object Idle : UpdateState()
    object Checking : UpdateState()
    data class UpdateAvailable(val info: UpdateInfo) : UpdateState()
    data class UpToDate(val currentVersion: String) : UpdateState()
    data class Downloading(
        val progress: Float,
        val bytesDownloaded: Long,
        val totalBytes: Long,
        val info: UpdateInfo
    ) : UpdateState()
    data class ReadyToInstall(val apkFile: File, val info: UpdateInfo) : UpdateState()
    data class Error(val message: String, val canRetry: Boolean = true) : UpdateState()
}

class UpdateManager(
    private val context: Context,
    private val httpClient: OkHttpClient
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _updateState = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val updateState: StateFlow<UpdateState> = _updateState.asStateFlow()

    companion object {
        private const val TAG = "ZoiaUpdateManager"
        private const val GITHUB_REPO = "caiomcg/zoia"
        private const val API_LATEST_RELEASE = "https://api.github.com/repos/$GITHUB_REPO/releases/latest"
        private const val HTML_LATEST_RELEASE = "https://github.com/$GITHUB_REPO/releases/latest"

        internal fun parseVersionCode(version: String): Int {
            val parts = version.removePrefix("v").split('.').mapNotNull { it.toIntOrNull() }
            return if (parts.size >= 3) {
                parts[0] * 10000 + parts[1] * 100 + parts[2]
            } else if (parts.size == 2) {
                parts[0] * 10000 + parts[1] * 100
            } else {
                parts.firstOrNull() ?: 0
            }
        }

        internal fun compareSemVer(v1: String, v2: String): Int {
            val p1 = v1.removePrefix("v").split('.').mapNotNull { it.toIntOrNull() }
            val p2 = v2.removePrefix("v").split('.').mapNotNull { it.toIntOrNull() }
            for (i in 0 until maxOf(p1.size, p2.size)) {
                val num1 = p1.getOrElse(i) { 0 }
                val num2 = p2.getOrElse(i) { 0 }
                if (num1 != num2) return num1.compareTo(num2)
            }
            return 0
        }

        internal fun isNewerVersion(
            remoteCode: Int,
            remoteVersion: String,
            currentCode: Int = BuildConfig.VERSION_CODE,
            currentVersion: String = BuildConfig.VERSION_NAME
        ): Boolean {
            if (remoteCode > currentCode) return true
            if (remoteCode == currentCode && remoteVersion != currentVersion) {
                return compareSemVer(remoteVersion, currentVersion) > 0
            }
            return false
        }
    }

    /**
     * Checks if a new release is available on GitHub.
     * @param silent If true, do not emit [UpdateState.UpToDate] or [UpdateState.Error] to avoid disturbing the user on app startup.
     */
    fun checkForUpdates(silent: Boolean = false) {
        if (_updateState.value is UpdateState.Checking || _updateState.value is UpdateState.Downloading) {
            return
        }

        scope.launch {
            if (!silent) {
                _updateState.value = UpdateState.Checking
            }

            try {
                val updateInfo = fetchLatestRelease()
                if (updateInfo != null && isNewerVersion(updateInfo.versionCode, updateInfo.version)) {
                    Log.i(TAG, "Update available: ${updateInfo.version} (current: ${BuildConfig.VERSION_NAME})")
                    _updateState.value = UpdateState.UpdateAvailable(updateInfo)
                } else {
                    Log.i(TAG, "App is up to date (${BuildConfig.VERSION_NAME})")
                    if (!silent) {
                        _updateState.value = UpdateState.UpToDate(BuildConfig.VERSION_NAME)
                    } else if (_updateState.value is UpdateState.Checking) {
                        _updateState.value = UpdateState.Idle
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to check for updates", e)
                if (!silent) {
                    _updateState.value = UpdateState.Error(
                        e.message ?: "Falha ao verificar atualizações."
                    )
                }
            }
        }
    }

    private suspend fun fetchLatestRelease(): UpdateInfo? = withContext(Dispatchers.IO) {
        // Attempt 1: GitHub API
        try {
            val request = Request.Builder()
                .url(API_LATEST_RELEASE)
                .header("Accept", "application/vnd.github.v3+json")
                .header("User-Agent", "Zoia-Android/${BuildConfig.VERSION_NAME}")
                .build()

            val response = httpClient.newCall(request).execute()
            if (response.isSuccessful) {
                val bodyString = response.body?.string() ?: return@withContext null
                val json = JSONObject(bodyString)
                val tagName = json.optString("tag_name")
                val releaseNotes = json.optString("body")
                val assets = json.optJSONArray("assets")

                var apkUrl: String? = null
                var apkName: String? = null
                var isUnsigned = false

                if (assets != null) {
                    for (i in 0 until assets.length()) {
                        val asset = assets.getJSONObject(i)
                        val name = asset.optString("name")
                        val url = asset.optString("browser_download_url")
                        if (name.endsWith(".apk", ignoreCase = true)) {
                            if (!name.contains("unsigned", ignoreCase = true)) {
                                apkUrl = url
                                apkName = name
                                isUnsigned = false
                                break
                            } else if (apkUrl == null) {
                                apkUrl = url
                                apkName = name
                                isUnsigned = true
                            }
                        }
                    }
                }

                if (apkUrl != null && tagName.isNotEmpty()) {
                    val cleanVersion = tagName.removePrefix("v").substringBefore('-')
                    val vCode = parseVersionCode(cleanVersion)
                    return@withContext UpdateInfo(
                        version = cleanVersion,
                        versionCode = vCode,
                        downloadUrl = apkUrl,
                        fileName = apkName ?: "Zoia-$cleanVersion.apk",
                        releaseNotes = releaseNotes,
                        isUnsigned = isUnsigned
                    )
                }
            } else {
                Log.w(TAG, "GitHub API returned ${response.code}, trying fallback redirect...")
            }
        } catch (e: Exception) {
            Log.w(TAG, "GitHub API call failed: ${e.message}, trying fallback redirect...")
        }

        // Fallback: Query HTML release redirect to circumvent GitHub API rate limit
        try {
            val redirectRequest = Request.Builder()
                .url(HTML_LATEST_RELEASE)
                .header("User-Agent", "Zoia-Android/${BuildConfig.VERSION_NAME}")
                .build()

            val redirectResponse = httpClient.newCall(redirectRequest).execute()
            val finalUrl = redirectResponse.request.url.toString()
            if (finalUrl.contains("/tag/")) {
                val tag = finalUrl.substringAfterLast("/tag/")
                val cleanVersion = tag.removePrefix("v").substringBefore('-')
                val vCode = parseVersionCode(cleanVersion)
                val downloadUrl = "https://github.com/$GITHUB_REPO/releases/download/$tag/Zoia-$cleanVersion.apk"
                return@withContext UpdateInfo(
                    version = cleanVersion,
                    versionCode = vCode,
                    downloadUrl = downloadUrl,
                    fileName = "Zoia-$cleanVersion.apk",
                    releaseNotes = "Nova versão disponível: $tag"
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Fallback release check failed", e)
        }

        null
    }



    /**
     * Downloads the APK file to cache directory with progress reporting.
     */
    fun downloadUpdate(info: UpdateInfo) {
        scope.launch {
            _updateState.value = UpdateState.Downloading(
                progress = 0f,
                bytesDownloaded = 0,
                totalBytes = 0,
                info = info
            )

            try {
                val updatesDir = File(context.cacheDir, "updates").apply { mkdirs() }
                val targetFile = File(updatesDir, info.fileName)

                val request = Request.Builder()
                    .url(info.downloadUrl)
                    .header("User-Agent", "Zoia-Android/${BuildConfig.VERSION_NAME}")
                    .build()

                val response = httpClient.newCall(request).execute()
                if (!response.isSuccessful) {
                    throw IllegalStateException("Falha no download (HTTP ${response.code})")
                }

                val body = response.body ?: throw IllegalStateException("Corpo da resposta vazio")
                val totalBytes = body.contentLength()
                var downloadedBytes = 0L

                body.byteStream().use { input ->
                    FileOutputStream(targetFile).use { output ->
                        val buffer = ByteArray(8192)
                        var read: Int
                        var lastReported = 0

                        while (input.read(buffer).also { read = it } != -1) {
                            output.write(buffer, 0, read)
                            downloadedBytes += read

                            if (totalBytes > 0) {
                                val percent = ((downloadedBytes * 100) / totalBytes).toInt()
                                if (percent > lastReported) {
                                    lastReported = percent
                                    _updateState.value = UpdateState.Downloading(
                                        progress = downloadedBytes.toFloat() / totalBytes,
                                        bytesDownloaded = downloadedBytes,
                                        totalBytes = totalBytes,
                                        info = info
                                    )
                                }
                            }
                        }
                        output.flush()
                    }
                }

                Log.i(TAG, "Download finished successfully: ${targetFile.absolutePath} (${targetFile.length()} bytes)")
                _updateState.value = UpdateState.ReadyToInstall(targetFile, info)
            } catch (e: Exception) {
                Log.e(TAG, "Error downloading update APK", e)
                _updateState.value = UpdateState.Error(
                    "Erro ao baixar atualização: ${e.message ?: "Falha na conexão"}"
                )
            }
        }
    }

    /**
     * Triggers the Android package installer for the downloaded APK.
     */
    fun installUpdate(activityContext: Context, apkFile: File) {
        if (!apkFile.exists() || apkFile.length() == 0L) {
            _updateState.value = UpdateState.Error("Arquivo APK não encontrado ou corrompido.")
            return
        }

        // On Android 8.0+ verify permission to install unknown apps
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (!activityContext.packageManager.canRequestPackageInstalls()) {
                val settingsIntent = Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${activityContext.packageName}")
                ).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                activityContext.startActivity(settingsIntent)
                return
            }
        }

        try {
            val contentUri = FileProvider.getUriForFile(
                activityContext,
                "${activityContext.packageName}.fileprovider",
                apkFile
            )

            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(contentUri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activityContext.startActivity(installIntent)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to launch APK installation intent", e)
            _updateState.value = UpdateState.Error("Falha ao abrir instalador: ${e.message}")
        }
    }

    fun dismiss() {
        _updateState.value = UpdateState.Idle
    }
}
