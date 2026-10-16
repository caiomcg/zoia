package im.zoia.auth

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.URI

@Serializable
data class Invite(
    val serverUrl: String,
    val pairingToken: String
)

class InviteException(message: String) : Exception(message)

object InviteParser {
    private val tokenRegex = Regex("^zpair_[0-9a-f]{8}_[A-Za-z0-9_-]{32,}$")
    private val loopbackHosts = setOf("localhost", "127.0.0.1", "[::1]", "::1")
    private val json = Json { ignoreUnknownKeys = true }

    fun parse(content: String): Invite {
        val root = try {
            json.parseToJsonElement(content).jsonObject
        } catch (e: Exception) {
            throw InviteException("O arquivo de convite não contém um JSON válido.")
        }

        val rawServerUrl = root["serverUrl"]?.jsonPrimitive?.content?.trim()
            ?: throw InviteException("O convite não possui o campo 'serverUrl'.")

        val rawToken = root["pairingToken"]?.jsonPrimitive?.content?.trim()
            ?: throw InviteException("O convite não possui o campo 'pairingToken'.")

        if (!tokenRegex.matches(rawToken)) {
            throw InviteException("O token de pareamento está em um formato inválido.")
        }

        val normalizedUrl = normalizeUrl(rawServerUrl)
        return Invite(serverUrl = normalizedUrl, pairingToken = rawToken)
    }

    private fun normalizeUrl(raw: String): String {
        val uri = try {
            URI(raw)
        } catch (e: Exception) {
            throw InviteException("\"$raw\" não é uma URL válida. Esperado algo como https://zoia.exemplo.com")
        }

        val scheme = uri.scheme?.lowercase()
        if (scheme != "https" && scheme != "http") {
            throw InviteException("A URL do servidor deve iniciar com https:// (ou http:// em localhost).")
        }

        val host = uri.host ?: throw InviteException("URL inválida sem hostname.")
        if (scheme == "http" && host !in loopbackHosts) {
            throw InviteException("Conexão insegura http:// só é permitida em localhost/loopback.")
        }

        if (!uri.query.isNullOrEmpty() || !uri.fragment.isNullOrEmpty()) {
            throw InviteException("A URL do servidor não deve conter parâmetros de busca (?) ou âncoras (#).")
        }

        val portPart = if (uri.port != -1 && uri.port != 80 && uri.port != 443) ":${uri.port}" else ""
        return "$scheme://$host$portPart"
    }
}
