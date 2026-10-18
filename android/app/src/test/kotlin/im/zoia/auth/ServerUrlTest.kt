package im.zoia.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** The address a password is about to follow. Same cases as the desktop's. */
class ServerUrlTest {
    @Test
    fun `an https origin is kept, without a trailing slash`() {
        assertEquals("https://zoia.example.com", ServerUrl.normalize("https://zoia.example.com/"))
        assertEquals("https://zoia.example.com", ServerUrl.normalize("  https://zoia.example.com  "))
    }

    @Test
    fun `an address without a scheme is taken as https`() {
        assertEquals("https://zoia.example.com", ServerUrl.normalize("zoia.example.com"))
    }

    @Test
    fun `a port is kept, the default one dropped`() {
        assertEquals("https://zoia.example.com:8443", ServerUrl.normalize("zoia.example.com:8443"))
        assertEquals("https://zoia.example.com", ServerUrl.normalize("https://zoia.example.com:443"))
    }

    @Test
    fun `plain http only on loopback`() {
        assertEquals("http://localhost:3000", ServerUrl.normalize("http://localhost:3000"))
        assertThrows(ServerUrlException::class.java) { ServerUrl.normalize("http://zoia.example.com") }
    }

    @Test
    fun `anything after the host is refused rather than dropped`() {
        for (bad in listOf(
            "https://zoia.example.com/?k=secret",
            "https://zoia.example.com/#x",
            "https://user:pass@zoia.example.com",
            "https://zoia.example.com/api",
            "ftp://zoia.example.com",
            "   ",
        )) {
            assertThrows(bad, ServerUrlException::class.java) { ServerUrl.normalize(bad) }
        }
    }
}
