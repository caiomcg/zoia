package im.zoia.api

import im.zoia.auth.CredentialStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

@Serializable
data class PairRequest(val pairingToken: String, val deviceName: String)

@Serializable
data class PairResponse(val deviceCredential: String, val deviceId: String, val name: String)

@Serializable
data class DeviceSessionRequest(val deviceCredential: String)

@Serializable
data class DeviceSessionResponse(val name: String, val id: String, val avatar: String? = null)

@Serializable
data class TokenRequest(val room: String? = null)

@Serializable
data class TokenResponse(
    val token: String,
    val room: String,
    val wsUrl: String? = null,
    val url: String? = null
) {
    val liveKitUrl: String
        get() = wsUrl ?: url ?: ""
}

@Serializable
data class RoomParticipant(
    val identity: String,
    val name: String,
    val avatar: String? = null
)

@Serializable
data class RoomBroadcaster(
    val identity: String,
    val name: String
)

@Serializable
data class RoomInfo(
    val id: String,
    val name: String,
    val isDefault: Boolean = false,
    val participants: List<RoomParticipant> = emptyList(),
    val broadcasters: List<RoomBroadcaster> = emptyList()
)

@Serializable
data class RoomsResponse(val rooms: List<RoomInfo>, val max: Int = 5)

@Serializable
data class RenameRequest(val name: String)

@Serializable
data class RenameResponse(val ok: Boolean, val name: String)

@Serializable
data class CreateRoomRequest(val name: String)

@Serializable
data class CreateRoomResponse(val room: RoomInfo)

class ApiException(val statusCode: Int, message: String) : IOException("HTTP $statusCode: $message")

class ZoiaApiClient(private val credentialStore: CredentialStore) {
    private val json = Json { ignoreUnknownKeys = true }
    private val mediaTypeJson = "application/json; charset=utf-8".toMediaType()

    // In-memory cookie store for session cookies
    private val cookieStore = mutableMapOf<String, MutableList<Cookie>>()

    private val cookieJar = object : CookieJar {
        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
            val list = cookieStore.getOrPut(url.host) { mutableListOf() }
            cookies.forEach { newCookie ->
                list.removeAll { it.name == newCookie.name }
                list.add(newCookie)
            }
        }

        override fun loadForRequest(url: HttpUrl): List<Cookie> {
            return cookieStore[url.host] ?: emptyList()
        }
    }

    private val httpClient = OkHttpClient.Builder()
        .cookieJar(cookieJar)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    suspend fun pair(serverUrl: String, pairingToken: String, deviceName: String): PairResponse =
        withContext(Dispatchers.IO) {
            val body = json.encodeToString(PairRequest(pairingToken, deviceName))
            val request = Request.Builder()
                .url("$serverUrl/api/pair")
                .post(body.toRequestBody(mediaTypeJson))
                .build()

            executeCall(request)
        }

    suspend fun deviceSession(deviceCredential: String): DeviceSessionResponse =
        withContext(Dispatchers.IO) {
            val baseUrl = credentialStore.getServerUrl()
                ?: throw IllegalStateException("Servidor não configurado.")

            val body = json.encodeToString(DeviceSessionRequest(deviceCredential))
            val request = Request.Builder()
                .url("$baseUrl/api/device/session")
                .post(body.toRequestBody(mediaTypeJson))
                .build()

            executeCall(request)
        }

    suspend fun getToken(room: String? = null): TokenResponse =
        withContext(Dispatchers.IO) {
            val baseUrl = credentialStore.getServerUrl()
                ?: throw IllegalStateException("Servidor não configurado.")

            val body = json.encodeToString(TokenRequest(room))
            val request = Request.Builder()
                .url("$baseUrl/api/token")
                .post(body.toRequestBody(mediaTypeJson))
                .build()

            executeCall(request)
        }

    suspend fun getRooms(): RoomsResponse =
        withContext(Dispatchers.IO) {
            val baseUrl = credentialStore.getServerUrl()
                ?: throw IllegalStateException("Servidor não configurado.")

            val request = Request.Builder()
                .url("$baseUrl/api/rooms")
                .get()
                .build()

            executeCall(request)
        }

    suspend fun renameDevice(name: String): RenameResponse =
        withContext(Dispatchers.IO) {
            val baseUrl = credentialStore.getServerUrl()
                ?: throw IllegalStateException("Servidor não configurado.")

            val body = json.encodeToString(RenameRequest(name))
            val request = Request.Builder()
                .url("$baseUrl/api/name")
                .post(body.toRequestBody(mediaTypeJson))
                .build()

            executeCall(request)
        }

    suspend fun createRoom(name: String): CreateRoomResponse =
        withContext(Dispatchers.IO) {
            val baseUrl = credentialStore.getServerUrl()
                ?: throw IllegalStateException("Servidor não configurado.")

            val body = json.encodeToString(CreateRoomRequest(name))
            val request = Request.Builder()
                .url("$baseUrl/api/rooms")
                .post(body.toRequestBody(mediaTypeJson))
                .build()

            executeCall(request)
        }

    private inline fun <reified T> executeCall(request: Request): T {
        httpClient.newCall(request).execute().use { response ->
            val responseBody = response.body?.string() ?: ""
            if (!response.isSuccessful) {
                throw ApiException(response.code, responseBody)
            }
            return json.decodeFromString(responseBody)
        }
    }
}
