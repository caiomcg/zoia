package im.zoia.auth

import java.net.URI

class ServerUrlException(message: String) : Exception(message)

/**
 * The server address someone typed on the sign-in screen, as the app uses it:
 * an origin with no trailing slash. An address without a scheme is taken as
 * https. Plain http only on this device — the password follows the address
 * wherever it points. Mirrors desktop/src/main/server-url.ts.
 */
object ServerUrl {
    private val loopbackHosts = setOf("localhost", "127.0.0.1", "[::1]", "::1")
    private val hasScheme = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://")

    fun normalize(raw: String): String {
        val typed = raw.trim()
        if (typed.isEmpty()) throw ServerUrlException("Informe o endereço do servidor.")

        val uri = try {
            URI(if (hasScheme.containsMatchIn(typed)) typed else "https://$typed")
        } catch (e: Exception) {
            throw ServerUrlException("\"$typed\" não é um endereço válido. Esperado algo como zoia.exemplo.com")
        }

        val scheme = uri.scheme?.lowercase()
        if (scheme != "https" && scheme != "http") {
            throw ServerUrlException("O endereço do servidor deve usar https://.")
        }
        val host = uri.host ?: throw ServerUrlException("\"$typed\" não é um endereço válido.")
        if (scheme == "http" && host !in loopbackHosts) {
            throw ServerUrlException("http:// só é permitido neste aparelho (localhost). Use https://.")
        }
        if (!uri.rawQuery.isNullOrEmpty() || !uri.rawFragment.isNullOrEmpty() || uri.rawUserInfo != null ||
            (uri.rawPath ?: "").trim('/').isNotEmpty()
        ) {
            throw ServerUrlException("Use só o endereço do servidor, sem nada depois dele.")
        }

        val defaultPort = if (scheme == "https") 443 else 80
        val portPart = if (uri.port != -1 && uri.port != defaultPort) ":${uri.port}" else ""
        return "$scheme://$host$portPart"
    }
}
