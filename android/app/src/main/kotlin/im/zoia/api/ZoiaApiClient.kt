package im.zoia.api

import im.zoia.auth.CredentialStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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
data class SignupRequest(val email: String, val password: String)

@Serializable
data class SignupResponse(val status: String)

@Serializable
data class LoginRequest(val email: String, val password: String, val deviceName: String)

@Serializable
data class ResetRequest(val code: String, val password: String)

@Serializable
data class ResetResponse(val ok: Boolean, val email: String)

@Serializable
data class DeviceSessionRequest(val deviceCredential: String)

/**
 * Who a session is, as a login, `/api/device/session` and `/api/session` all
 * describe it: this machine (`id`) and the account it is signed in to. A
 * login also carries the device credential, returned that once.
 */
@Serializable
data class SessionResponse(
    val name: String,
    val id: String,
    val avatar: String? = null,
    val accountId: String,
    val email: String,
    val role: String,
    val status: String,
    val pendingApprovals: Int? = null,
    val deviceCredential: String? = null,
    val deviceId: String? = null,
)

@Serializable
data class OkResponse(val ok: Boolean = true)

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
    val avatar: String? = null,
    /** "admin" or "super_admin" from the server's own records; absent for a user. */
    val role: String? = null
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

/** Who is asking, as the server sees them now: a role given or taken shows within a poll. */
@Serializable
data class RoomsYou(val role: String, val pendingApprovals: Int? = null)

@Serializable
data class RoomsResponse(val rooms: List<RoomInfo>, val max: Int = 5, val you: RoomsYou? = null)

@Serializable
data class RenameRequest(val name: String)

@Serializable
data class RenameResponse(val ok: Boolean, val name: String)

@Serializable
data class CreateRoomRequest(val name: String)

@Serializable
data class CreateRoomResponse(val room: RoomInfo)

class ApiException(val statusCode: Int, message: String) : IOException("HTTP $statusCode: $message") {
    /** The server's refusal code, such as `invalid_login`, when it sent one. */
    val code: String? = try {
        Json.parseToJsonElement(message).jsonObject["error"]?.jsonPrimitive?.content
    } catch (_: Exception) {
        null
    }
}

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

    /** Forgets the session cookie, as signing out must. */
    fun clearCookies() {
        cookieStore.clear()
    }

    // ---- accounts (ADR 0031) ----
    // These take the server explicitly: before a sign-in succeeds there is no
    // stored one. The password goes to the server and nowhere else.

    suspend fun signup(serverUrl: String, email: String, password: String): SignupResponse =
        withContext(Dispatchers.IO) {
            val body = json.encodeToString(SignupRequest(email, password))
            executeCall(post("$serverUrl/api/signup", body))
        }

    suspend fun login(serverUrl: String, email: String, password: String, deviceName: String): SessionResponse =
        withContext(Dispatchers.IO) {
            val body = json.encodeToString(LoginRequest(email, password, deviceName))
            executeCall(post("$serverUrl/api/login", body))
        }

    /** Spends a reset code from an admin. Every machine of the account is signed out by it. */
    suspend fun redeemCode(serverUrl: String, code: String, password: String): ResetResponse =
        withContext(Dispatchers.IO) {
            val body = json.encodeToString(ResetRequest(code, password))
            executeCall(post("$serverUrl/api/reset", body))
        }

    /** Who this machine is now: approved yet, its role, still allowed in at all. */
    suspend fun session(): SessionResponse =
        withContext(Dispatchers.IO) {
            val baseUrl = credentialStore.getServerUrl()
                ?: throw IllegalStateException("Servidor não configurado.")
            executeCall(Request.Builder().url("$baseUrl/api/session").get().build())
        }

    /** Signs this machine out for good, so it stops holding one of the account's seats. */
    suspend fun forgetDevice(): OkResponse =
        withContext(Dispatchers.IO) {
            val baseUrl = credentialStore.getServerUrl()
                ?: throw IllegalStateException("Servidor não configurado.")
            executeCall(post("$baseUrl/api/device/forget", "{}"))
        }

    private fun post(url: String, body: String): Request =
        Request.Builder().url(url).post(body.toRequestBody(mediaTypeJson)).build()

    suspend fun deviceSession(deviceCredential: String): SessionResponse =
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
