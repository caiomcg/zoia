package im.zoia.auth

import android.os.Build
import im.zoia.api.ApiException
import im.zoia.api.SessionResponse
import im.zoia.api.ZoiaApiClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed class SessionState {
    object Initial : SessionState()
    object Loading : SessionState()

    /** Not signed in. `message` says why, when it was not by choice. */
    data class SignedOut(val message: String? = null) : SessionState()

    /** Signed in, but an admin has not approved the account yet. Nothing else is reachable. */
    data class Pending(val email: String) : SessionState()

    data class Authenticated(
        val deviceName: String,
        val deviceId: String,
        val role: String = "user",
    ) : SessionState() {
        val isAdmin: Boolean get() = role == "admin" || role == "super_admin"
    }

    /** The server could not be reached. The stored credential is kept: waiting is what fixes this. */
    data class Error(val message: String) : SessionState()
}

/** The result of a sign-in, a sign-up or a code: nothing, or what to show. */
sealed class AuthResult {
    object Ok : AuthResult()
    data class Failed(val message: String) : AuthResult()
}

/**
 * Who this device is signed in as, and getting it signed in. A device signs
 * in to an account once, with an email and a password, and keeps the device
 * credential it gets; after that, each launch only proves the credential
 * still works, since it may have been signed out, replaced or its account
 * disabled. See ADR 0031.
 */
class SessionManager(
    private val apiClient: ZoiaApiClient,
    private val credentialStore: CredentialStore
) {
    private val _sessionState = MutableStateFlow<SessionState>(SessionState.Initial)
    val sessionState: StateFlow<SessionState> = _sessionState.asStateFlow()

    fun getSavedDisplayName(): String? = credentialStore.getLastDisplayName() ?: credentialStore.getDeviceName()

    /** The server to start the sign-in screen with: the one last signed in to. */
    fun getLastServerUrl(): String? = credentialStore.getLastServerUrl()

    private fun stateOf(session: SessionResponse): SessionState =
        if (session.status == "pending") {
            SessionState.Pending(session.email)
        } else {
            SessionState.Authenticated(deviceName = session.name, deviceId = session.id, role = session.role)
        }

    /** Signed out by the server: the device is gone, or the account disabled. */
    private fun refusedBy(e: Exception): Boolean =
        e is ApiException && (e.statusCode == 401 || e.statusCode == 403)

    private fun forget(message: String?) {
        credentialStore.clear()
        apiClient.clearCookies()
        _sessionState.value = SessionState.SignedOut(message)
    }

    suspend fun restoreSession() {
        val credential = credentialStore.getDeviceCredential()
        if (!credentialStore.hasCredential() || credential == null) {
            _sessionState.value = SessionState.SignedOut()
            return
        }
        _sessionState.value = SessionState.Loading
        try {
            _sessionState.value = stateOf(apiClient.deviceSession(credential))
        } catch (e: Exception) {
            if (e is kotlin.coroutines.cancellation.CancellationException) throw e
            if (refusedBy(e)) {
                val disabled = (e as ApiException).code == "account_disabled"
                forget(if (disabled) MESSAGE_DISABLED else MESSAGE_SIGNED_OUT)
            } else {
                _sessionState.value = SessionState.Error(e.message ?: "Erro ao falar com o servidor.")
            }
        }
    }

    /**
     * Asks the server who this device is now: approved, made or unmade an
     * admin, or signed out from elsewhere. An unreachable server changes
     * nothing; a refusal signs out here too.
     */
    suspend fun refresh() {
        if (_sessionState.value !is SessionState.Authenticated && _sessionState.value !is SessionState.Pending) return
        try {
            _sessionState.value = stateOf(apiClient.session())
        } catch (e: Exception) {
            if (e is kotlin.coroutines.cancellation.CancellationException) throw e
            if (refusedBy(e)) forget(MESSAGE_SIGNED_OUT)
        }
    }

    suspend fun signIn(server: String, email: String, password: String): AuthResult {
        val serverUrl = try {
            ServerUrl.normalize(server)
        } catch (e: ServerUrlException) {
            return AuthResult.Failed(e.message ?: "Endereço inválido.")
        }
        return try {
            val deviceName = "${Build.MANUFACTURER} ${Build.MODEL}".trim().ifEmpty { "Android" }
            val result = apiClient.login(serverUrl, email.trim(), password, deviceName)
            val credential = result.deviceCredential ?: return AuthResult.Failed("Resposta inesperada do servidor.")
            credentialStore.saveSignIn(serverUrl, credential, result.name)
            _sessionState.value = stateOf(result)
            AuthResult.Ok
        } catch (e: Exception) {
            if (e is kotlin.coroutines.cancellation.CancellationException) throw e
            AuthResult.Failed(messageFor(e))
        }
    }

    /** Creates the account, pending approval, and signs in to it straight away. */
    suspend fun signUp(server: String, email: String, password: String): AuthResult {
        val serverUrl = try {
            ServerUrl.normalize(server)
        } catch (e: ServerUrlException) {
            return AuthResult.Failed(e.message ?: "Endereço inválido.")
        }
        try {
            apiClient.signup(serverUrl, email.trim(), password)
        } catch (e: Exception) {
            if (e is kotlin.coroutines.cancellation.CancellationException) throw e
            return AuthResult.Failed(messageFor(e))
        }
        return signIn(serverUrl, email, password)
    }

    /** Spends a reset code from an admin, then signs in with the new password. */
    suspend fun redeem(server: String, code: String, password: String): AuthResult {
        val serverUrl = try {
            ServerUrl.normalize(server)
        } catch (e: ServerUrlException) {
            return AuthResult.Failed(e.message ?: "Endereço inválido.")
        }
        val email = try {
            apiClient.redeemCode(serverUrl, code.trim(), password).email
        } catch (e: Exception) {
            if (e is kotlin.coroutines.cancellation.CancellationException) throw e
            return AuthResult.Failed(messageFor(e))
        }
        return signIn(serverUrl, email, password)
    }

    suspend fun renameDevice(newName: String): Result<String> {
        return try {
            val response = apiClient.renameDevice(newName)
            credentialStore.saveDeviceName(response.name)
            val current = _sessionState.value
            if (current is SessionState.Authenticated) {
                _sessionState.value = current.copy(deviceName = response.name)
            }
            Result.success(response.name)
        } catch (e: Exception) {
            if (e is kotlin.coroutines.cancellation.CancellationException) throw e
            val errorMsg = when {
                e is ApiException && e.statusCode == 409 -> "Este nome já está em uso por outra pessoa."
                e is ApiException && e.statusCode == 400 -> "Nome inválido ou muito longo (máx. 32 caracteres)."
                else -> e.message ?: "Falha ao alterar nome."
            }
            Result.failure(Exception(errorMsg, e))
        }
    }

    /**
     * Signs this device out, and asks the server to forget it so it stops
     * holding one of the account's seats. Local state goes either way: an
     * unreachable server is no reason to stay signed in.
     */
    suspend fun signOut() {
        try {
            apiClient.forgetDevice()
        } catch (e: Exception) {
            if (e is kotlin.coroutines.cancellation.CancellationException) throw e
        }
        forget(null)
    }

    companion object {
        private const val MESSAGE_SIGNED_OUT = "Este aparelho foi desconectado. Entre de novo para continuar."
        private const val MESSAGE_DISABLED = "Sua conta está desativada. Fale com um admin se for engano."

        /** Words for the server's refusal codes; the same ones the desktop app knows. */
        fun messageFor(e: Exception): String {
            if (e !is ApiException) return "Não foi possível falar com o servidor. Confira o endereço e sua conexão."
            return when (e.code) {
                "invalid_login" -> "Esse e-mail e senha não correspondem a nenhuma conta."
                "too_many_attempts" -> "Tentativas demais. Espere alguns minutos e tente de novo."
                "account_disabled" -> "Esta conta está desativada."
                "invalid_email" -> "Isso não parece um endereço de e-mail."
                "weak_password" -> "Use pelo menos ${PasswordRules.MIN_LENGTH} caracteres, com uma letra maiúscula, uma minúscula, um número e um símbolo."
                "email_taken" -> "Já existe uma conta com esse e-mail."
                "signup_closed" -> "O cadastro está fechado no momento. Tente mais tarde."
                "invalid_code" -> "Esse código está errado, já foi usado ou expirou. Peça um novo a um admin."
                // A server from before accounts: its login only took invite keys.
                "invalid_key" -> "Esse servidor ainda não tem contas."
                else -> if (e.statusCode == 404) "Esse servidor ainda não tem contas." else "Algo deu errado (${e.code ?: e.statusCode})."
            }
        }
    }
}
