package im.zoia.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateVersionTest {

    @Test
    fun parseVersionCode_standardSemanticVersions() {
        assertEquals(1406, UpdateManager.parseVersionCode("0.14.6"))
        assertEquals(1407, UpdateManager.parseVersionCode("v0.14.7"))
        assertEquals(10000, UpdateManager.parseVersionCode("1.0.0"))
        assertEquals(10203, UpdateManager.parseVersionCode("1.2.3"))
    }

    @Test
    fun compareSemVer_correctOrdering() {
        assertTrue(UpdateManager.compareSemVer("0.14.7", "0.14.6") > 0)
        assertTrue(UpdateManager.compareSemVer("0.14.6", "0.14.7") < 0)
        assertEquals(0, UpdateManager.compareSemVer("0.14.6", "0.14.6"))
        assertTrue(UpdateManager.compareSemVer("1.0.0", "0.14.6") > 0)
        assertTrue(UpdateManager.compareSemVer("0.15.0", "0.14.99") > 0)
    }

    @Test
    fun isNewerVersion_detectsAvailableUpdates() {
        // Newer version code
        assertTrue(
            UpdateManager.isNewerVersion(
                remoteCode = 1407,
                remoteVersion = "0.14.7",
                currentCode = 1406,
                currentVersion = "0.14.6"
            )
        )

        // Same version
        assertFalse(
            UpdateManager.isNewerVersion(
                remoteCode = 1406,
                remoteVersion = "0.14.6",
                currentCode = 1406,
                currentVersion = "0.14.6"
            )
        )

        // Older version
        assertFalse(
            UpdateManager.isNewerVersion(
                remoteCode = 1405,
                remoteVersion = "0.14.5",
                currentCode = 1406,
                currentVersion = "0.14.6"
            )
        )

        // Major bump
        assertTrue(
            UpdateManager.isNewerVersion(
                remoteCode = 10000,
                remoteVersion = "1.0.0",
                currentCode = 1406,
                currentVersion = "0.14.6"
            )
        )
    }
}
