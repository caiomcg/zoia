package im.zoia.auth

import im.zoia.api.ApiException
import im.zoia.api.ZoiaApiClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed class SessionState {
    object Initial : SessionState()
    object Unpaired : SessionState()
    object Loading : SessionState()
    data class Authenticated(val deviceName: String, val deviceId: String) : SessionState()
    data class Error(val message: String) : SessionState()
}

class SessionManager(
    private val apiClient: ZoiaApiClient,
    private val credentialStore: CredentialStore
) {
    private val _sessionState = MutableStateFlow<SessionState>(SessionState.Initial)
    val sessionState: StateFlow<SessionState> = _sessionState.asStateFlow()

    fun getSavedDisplayName(): String? = credentialStore.getLastDisplayName() ?: credentialStore.getDeviceName()

    suspend fun restoreSession() {
        if (!credentialStore.hasCredential()) {
            _sessionState.value = SessionState.Unpaired
            return
        }

        val credential = credentialStore.getDeviceCredential()!!
        _sessionState.value = SessionState.Loading

        try {
            val response = apiClient.deviceSession(credential)
            _sessionState.value = SessionState.Authenticated(
                deviceName = response.name,
                deviceId = response.id
            )
        } catch (e: Exception) {
            if (e is ApiException && e.statusCode == 401) {
                // Credential was revoked on server
                credentialStore.clear()
                _sessionState.value = SessionState.Unpaired
            } else {
                _sessionState.value = SessionState.Error(
                    e.message ?: "Erro ao restaurar sessão com o servidor."
                )
            }
        }
    }

    suspend fun pairWithInvite(invite: Invite, deviceName: String): Result<Unit> {
        _sessionState.value = SessionState.Loading
        return try {
            val pairResponse = apiClient.pair(
                serverUrl = invite.serverUrl,
                pairingToken = invite.pairingToken,
                deviceName = deviceName
            )

            credentialStore.savePairing(
                serverUrl = invite.serverUrl,
                deviceCredential = pairResponse.deviceCredential,
                deviceName = pairResponse.name
            )

            // Re-authenticate session
            val sessionResponse = apiClient.deviceSession(pairResponse.deviceCredential)
            _sessionState.value = SessionState.Authenticated(
                deviceName = sessionResponse.name,
                deviceId = sessionResponse.id
            )
            Result.success(Unit)
        } catch (e: Exception) {
            if (e is kotlin.coroutines.cancellation.CancellationException) throw e
            val msg = when {
                e is ApiException && e.statusCode == 401 -> "Convite inválido ou expirado."
                e is ApiException && e.statusCode == 409 -> "Este convite já atingiu o limite de ativações (já está em uso em outro aparelho)."
                e is ApiException && e.statusCode == 429 -> "Limite de tentativas excedido. Tente novamente mais tarde."
                else -> e.message ?: "Falha ao parear com o servidor."
            }
            _sessionState.value = SessionState.Error(msg)
            Result.failure(e)
        }
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
                e is ApiException && e.statusCode == 409 -> "Este nome já está em uso por outro dispositivo."
                e is ApiException && e.statusCode == 400 -> "Nome inválido ou muito longo (máx. 32 caracteres)."
                else -> e.message ?: "Falha ao alterar nome."
            }
            Result.failure(Exception(errorMsg, e))
        }
    }

    fun unpair() {
        credentialStore.clear()
        _sessionState.value = SessionState.Unpaired
    }
}
