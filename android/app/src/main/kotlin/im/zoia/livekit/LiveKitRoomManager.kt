package im.zoia.livekit

import android.content.Context
import im.zoia.api.ZoiaApiClient
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.room.Room
import io.livekit.android.room.track.AudioTrack
import io.livekit.android.room.track.VideoTrack
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

data class StreamItem(
    val participantId: String,
    val participantName: String,
    val videoTrack: VideoTrack?,
    val isAudioActive: Boolean
)

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

        val items = currentRoom.remoteParticipants.values.mapNotNull { participant ->
            val videoTrack = participant.videoTrackPublications.firstOrNull()?.second as? VideoTrack
            val audioTrack = participant.audioTrackPublications.firstOrNull()?.second as? AudioTrack

            // Only include participants who are actively broadcasting (skip passive viewers)
            if (videoTrack == null && audioTrack == null) {
                return@mapNotNull null
            }

            val isAudioActive = (participant.identity?.value == activeAudioId) || 
                (activeAudioId == null && audioTrack != null)

            // Apply audio muting according to selection
            audioTrack?.let {
                it.enabled = isAudioActive
            }

            val displayName = participant.name?.takeIf { it.isNotBlank() }
                ?: participant.identity?.value
                ?: "Apresentador"

            StreamItem(
                participantId = participant.identity?.value ?: "",
                participantName = displayName,
                videoTrack = videoTrack,
                isAudioActive = isAudioActive
            )
        }

        // Set default active audio if not set yet
        if (_selectedAudioParticipantId.value == null && items.isNotEmpty()) {
            _selectedAudioParticipantId.value = items.first().participantId
        }

        _streams.value = items
    }

    fun initVideoRenderer(renderer: SurfaceViewRenderer) {
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
