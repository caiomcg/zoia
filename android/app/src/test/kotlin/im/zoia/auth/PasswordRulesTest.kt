package im.zoia.auth

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The server's own cases, from server/test/accounts.test.js. */
class PasswordRulesTest {
    @Test
    fun `six characters with an uppercase, a lowercase, a digit and a symbol`() {
        assertTrue(PasswordRules.isStrong("Ab1-xy"))
        assertTrue("letters beyond ASCII count", PasswordRules.isStrong("Ção-9x"))
    }

    @Test
    fun `each missing kind is refused`() {
        for (bad in listOf("Ab1-x", "abcde1-", "ABCDE1-", "Abcdef-", "Abcdef1")) {
            assertFalse(bad, PasswordRules.isStrong(bad))
        }
    }
}
