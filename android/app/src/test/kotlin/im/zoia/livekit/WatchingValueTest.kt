package im.zoia.livekit

import org.junit.Assert.assertEquals
import org.junit.Test

/** What a viewer announces as watching: the desktop's format, so either can read it (ADR 0037). */
class WatchingValueTest {
    @Test
    fun `the people on screen, sorted and comma separated`() {
        assertEquals("alice,bob", watchingValue(listOf("bob", "alice")))
    }

    @Test
    fun `nobody on screen is an empty value, which clears the attribute`() {
        assertEquals("", watchingValue(emptyList()))
    }
}
