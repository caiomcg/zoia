package im.zoia.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class InviteParserTest {

    @Test
    fun `parses valid invite json successfully`() {
        val validJson = """
            {
                "serverUrl": "https://zoia.example.com",
                "pairingToken": "zpair_01234567_abcdefghijklmnopqrstuvwxyz012345"
            }
        """.trimIndent()

        val invite = InviteParser.parse(validJson)
        assertEquals("https://zoia.example.com", invite.serverUrl)
        assertEquals("zpair_01234567_abcdefghijklmnopqrstuvwxyz012345", invite.pairingToken)
    }

    @Test
    fun `normalizes trailing slash in serverUrl`() {
        val jsonWithSlash = """
            {
                "serverUrl": "https://zoia.example.com/",
                "pairingToken": "zpair_01234567_abcdefghijklmnopqrstuvwxyz012345"
            }
        """.trimIndent()

        val invite = InviteParser.parse(jsonWithSlash)
        assertEquals("https://zoia.example.com", invite.serverUrl)
    }

    @Test
    fun `allows http only for localhost`() {
        val localhostJson = """
            {
                "serverUrl": "http://localhost:3000",
                "pairingToken": "zpair_01234567_abcdefghijklmnopqrstuvwxyz012345"
            }
        """.trimIndent()

        val invite = InviteParser.parse(localhostJson)
        assertEquals("http://localhost:3000", invite.serverUrl)

        val insecureRemoteJson = """
            {
                "serverUrl": "http://insecure.example.com",
                "pairingToken": "zpair_01234567_abcdefghijklmnopqrstuvwxyz012345"
            }
        """.trimIndent()

        assertThrows(InviteException::class.java) {
            InviteParser.parse(insecureRemoteJson)
        }
    }

    @Test
    fun `rejects invalid token format`() {
        val badTokenJson = """
            {
                "serverUrl": "https://zoia.example.com",
                "pairingToken": "invalid_token_format"
            }
        """.trimIndent()

        assertThrows(InviteException::class.java) {
            InviteParser.parse(badTokenJson)
        }
    }
}
