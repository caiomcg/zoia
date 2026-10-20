package im.zoia.livekit

import io.livekit.android.room.track.Track
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * How one person's tracks become their screen, their camera and their sound
 * (ADR 0034). The Android SDK has no ScreenShareAudio source; it arrives as
 * another, so UNKNOWN stands in for it here.
 */
class PickFeedsTest {
    private fun own(source: Track.Source, name: String) = Feed(source, name, fromIngress = false)
    private fun ingress(source: Track.Source, name: String) = Feed(source, name, fromIngress = true)

    @Test
    fun `a screen and a camera are two pictures`() {
        val feeds = pickFeeds(
            video = listOf(own(Track.Source.CAMERA, "camera"), own(Track.Source.SCREEN_SHARE, "screen")),
            audio = listOf(own(Track.Source.MICROPHONE, "mic"), own(Track.Source.UNKNOWN, "sound"))
        )
        assertEquals("screen", feeds.screen)
        assertEquals("camera", feeds.camera)
        assertEquals("sound", feeds.screenAudio)
        assertEquals("mic", feeds.mic)
    }

    @Test
    fun `a camera shared alone is a camera, not a screen`() {
        val feeds = pickFeeds(
            video = listOf(own(Track.Source.CAMERA, "camera")),
            audio = listOf(own(Track.Source.MICROPHONE, "mic"))
        )
        assertNull(feeds.screen)
        assertEquals("camera", feeds.camera)
        assertNull(feeds.screenAudio)
        assertEquals("mic", feeds.mic)
    }

    @Test
    fun `everything an ingress sends is the screen, whatever WHIP labels it`() {
        val feeds = pickFeeds(
            video = listOf(own(Track.Source.CAMERA, "camera"), ingress(Track.Source.CAMERA, "nvenc")),
            audio = listOf(own(Track.Source.MICROPHONE, "mic"), ingress(Track.Source.MICROPHONE, "sound"))
        )
        assertEquals("nvenc", feeds.screen)
        assertEquals("camera", feeds.camera)
        assertEquals("sound", feeds.screenAudio)
        assertEquals("mic", feeds.mic)
    }

    @Test
    fun `the screen's sound is played once when both paths send it`() {
        val feeds = pickFeeds<String, String>(
            video = emptyList(),
            audio = listOf(own(Track.Source.UNKNOWN, "chromium"), ingress(Track.Source.MICROPHONE, "whip"))
        )
        assertEquals("whip", feeds.screenAudio)
        assertNull(feeds.mic)
    }
}
