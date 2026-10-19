package im.zoia.livekit

import android.content.Context
import im.zoia.api.ZoiaApiClient
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.room.Room
import io.livekit.android.room.participant.RemoteParticipant
import io.livekit.android.room.track.AudioTrack
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoTrack
import io.livekit.android.renderer.TextureViewRenderer
import livekit.org.webrtc.SurfaceViewRenderer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed class RoomConnectionState {
    object Disconnected : RoomConnectionState()
    object Connecting : RoomConnectionState()
    data class Connected(val roomName: String) : RoomConnectionState()
    data class Error(val message: String) : RoomConnectionState()
}

/**
 * One person's broadcast. A screen and a camera shared together are still one
 * broadcast: the screen is the picture and the camera sits over its corner
 * (ADR 0034). A camera shared alone is the picture itself.
 */
data class StreamItem(
    val participantId: String,
    val participantName: String,
    val videoTrack: VideoTrack?,
    /** The camera beside the screen; null when there is no screen or no camera. */
    val cameraTrack: VideoTrack?,
    val isAudioActive: Boolean
)

/**
 * WHIP publishers join under their owner's identity plus this, so they can be
 * folded back into that person rather than shown as someone else.
 */
internal const val WHIP_SUFFIX = "-gpu"

internal fun ownerIdentity(identity: String): String = identity.removeSuffix(WHIP_SUFFIX)

/** A published track, with where it came from. */
internal data class Feed<T>(val source: Track.Source, val track: T, val fromIngress: Boolean)

internal data class PersonFeeds<V, A>(val screen: V?, val camera: V?, val audio: List<A>)

/**
 * Where a stream came from decides how it is labelled, and viewers must not
 * care. WHIP carries no notion of a screen share, so an ingress may label its
 * tracks CAMERA and MICROPHONE: everything an ingress sends is the screen, and
 * only a person's own Camera and Microphone are their camera. Both the screen's
 * sound and the microphone are heard.
 */
internal fun <V, A> pickFeeds(video: List<Feed<V>>, audio: List<Feed<A>>): PersonFeeds<V, A> {
    val screen = video.firstOrNull { it.fromIngress }
        ?: video.firstOrNull { !it.fromIngress && it.source != Track.Source.CAMERA }
    val camera = video.firstOrNull { !it.fromIngress && it.source == Track.Source.CAMERA }
    val screenAudio = audio.firstOrNull { it.fromIngress }
        ?: audio.firstOrNull { !it.fromIngress && it.source != Track.Source.MICROPHONE }
    val mic = audio.firstOrNull { !it.fromIngress && it.source == Track.Source.MICROPHONE }
    return PersonFeeds(
        screen = (screen ?: camera)?.track,
        camera = if (screen != null) camera?.track else null,
        audio = listOfNotNull(screenAudio?.track, mic?.track)
    )
}

class LiveKitRoomManager(
    private val context: Context,
    private val apiClient: ZoiaApiClient
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    var room: Room? = null
        private set

    private val _connectionState = MutableStateFlow<RoomConnectionState>(RoomConnectionState.Disconnected)
    val connectionState: StateFlow<RoomConnectionState> = _connectionState.asStateFlow()

    private val _streams = MutableStateFlow<List<StreamItem>>(emptyList())
    val streams: StateFlow<List<StreamItem>> = _streams.asStateFlow()

    private val _selectedAudioParticipantId = MutableStateFlow<String?>(null)
    val selectedAudioParticipantId: StateFlow<String?> = _selectedAudioParticipantId.asStateFlow()

    var currentChannelId: String? = null
        private set

    fun updateLocalName(name: String) {
        try {
            room?.localParticipant?.updateName(name)
        } catch (_: Exception) {}
    }

    suspend fun connectToRoom(channelId: String? = null) {
        disconnect()
        currentChannelId = channelId
        _connectionState.value = RoomConnectionState.Connecting

        try {
            val tokenResponse = apiClient.getToken(channelId)
            val newRoom = LiveKit.create(
                appContext = context,
                options = io.livekit.android.RoomOptions(
                    adaptiveStream = true,
                    dynacast = true
                )
            )
            room = newRoom

            // Observe room events via SharedFlow
            scope.launch {
                newRoom.events.events.collect { event ->
                    handleRoomEvent(event)
                }
            }

            // Connect using WS url and JWT token
            newRoom.connect(tokenResponse.liveKitUrl, tokenResponse.token)
            _connectionState.value = RoomConnectionState.Connected(tokenResponse.room)
            updateStreamsList()
            try {
                BackgroundAudioService.start(context)
            } catch (_: Exception) {}
        } catch (e: Exception) {
            _connectionState.value = RoomConnectionState.Error(
                e.message ?: "Falha ao conectar à transmissão."
            )
        }
    }

    private fun handleRoomEvent(event: RoomEvent) {
        when (event) {
            is RoomEvent.ParticipantConnected,
            is RoomEvent.ParticipantDisconnected,
            is RoomEvent.ParticipantNameChanged,
            is RoomEvent.TrackSubscribed,
            is RoomEvent.TrackUnsubscribed,
            is RoomEvent.TrackMuted,
            is RoomEvent.TrackUnmuted -> {
                updateStreamsList()
            }
            is RoomEvent.Disconnected -> {
                try {
                    BackgroundAudioService.stop(context)
                } catch (_: Exception) {}
                _connectionState.value = RoomConnectionState.Disconnected
                _streams.value = emptyList()
                _selectedAudioParticipantId.value = null
            }
            else -> Unit
        }
    }

    private fun updateStreamsList() {
        val currentRoom = room ?: return
        val activeAudioId = _selectedAudioParticipantId.value

        val people = currentRoom.remoteParticipants.values
            .filter { it.identity?.value != null }
            .groupBy { ownerIdentity(it.identity!!.value) }

        val items = people.mapNotNull { (owner, participants) ->
            val human = participants.firstOrNull { it.identity?.value == owner }
            val ingress = participants.firstOrNull { it.identity?.value != owner }

            val feeds = pickFeeds(
                video = feedsOf<VideoTrack>(human, ingress) { it.videoTrackPublications },
                audio = feedsOf<AudioTrack>(human, ingress) { it.audioTrackPublications }
            )

            // Only include participants who are actively broadcasting (skip passive viewers)
            if (feeds.screen == null && feeds.audio.isEmpty()) {
                return@mapNotNull null
            }

            val isAudioActive = (owner == activeAudioId) ||
                (activeAudioId == null && feeds.audio.isNotEmpty())

            // Apply audio muting according to selection. A second screen audio
            // (from both paths at once) stays off so nothing is heard twice.
            participants.forEach { participant ->
                participant.audioTrackPublications.forEach { (_, track) ->
                    (track as? AudioTrack)?.let { it.enabled = isAudioActive && it in feeds.audio }
                }
            }

            // A WHIP publisher carries the name it joined with, so a later
            // rename would leave a stale label. The human is always current.
            val displayName = (human ?: ingress)?.name?.takeIf { it.isNotBlank() }
                ?: owner

            StreamItem(
                participantId = owner,
                participantName = displayName,
                videoTrack = feeds.screen,
                cameraTrack = feeds.camera,
                isAudioActive = isAudioActive
            )
        }

        // Set default active audio if not set yet
        if (_selectedAudioParticipantId.value == null && items.isNotEmpty()) {
            _selectedAudioParticipantId.value = items.first().participantId
        }

        _streams.value = items
    }

    private inline fun <reified T : Track> feedsOf(
        human: RemoteParticipant?,
        ingress: RemoteParticipant?,
        publications: (RemoteParticipant) -> List<Pair<io.livekit.android.room.track.TrackPublication, Track?>>
    ): List<Feed<T>> =
        listOfNotNull(human?.let { it to false }, ingress?.let { it to true })
            .flatMap { (participant, fromIngress) ->
                publications(participant).mapNotNull { (publication, track) ->
                    (track as? T)?.let { Feed(publication.source, it, fromIngress) }
                }
            }

    fun initVideoRenderer(renderer: SurfaceViewRenderer) {
        room?.initVideoRenderer(renderer)
    }

    fun initVideoRenderer(renderer: TextureViewRenderer) {
        room?.initVideoRenderer(renderer)
    }

    fun selectAudio(participantId: String) {
        _selectedAudioParticipantId.value = participantId
        updateStreamsList()
    }

    fun disconnect() {
        try {
            BackgroundAudioService.stop(context)
        } catch (_: Exception) {}
        try {
            room?.remoteParticipants?.values?.forEach { participant ->
                participant.audioTrackPublications.forEach { (_, track) ->
                    (track as? AudioTrack)?.enabled = false
                }
            }
            room?.disconnect()
            room?.release()
        } catch (_: Exception) {}
        room = null
        _connectionState.value = RoomConnectionState.Disconnected
        _streams.value = emptyList()
        _selectedAudioParticipantId.value = null
    }
}
