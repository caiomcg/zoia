package im.zoia.livekit

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import com.twilio.audioswitch.AudioDevice
import im.zoia.api.ZoiaApiClient
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.room.Room
import io.livekit.android.room.participant.RemoteParticipant
import io.livekit.android.room.track.AudioTrack
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoTrack
import livekit.org.webrtc.SurfaceViewRenderer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

sealed class RoomConnectionState {
    object Disconnected : RoomConnectionState()
    object Connecting : RoomConnectionState()
    data class Connected(val roomName: String) : RoomConnectionState()
    data class Error(val message: String) : RoomConnectionState()
}

/** One participant in the channel's voice (ADR 0039). */
data class VoiceMember(
    val identity: String,
    val name: String,
    val isSpeaking: Boolean,
    val isMuted: Boolean,
    val isLocal: Boolean = false,
    val avatar: String? = null
)

/**
 * One person's broadcast. Their screen and their camera are two pictures,
 * each a tile of its own (ADR 0034): the screen is on the grid by itself, and
 * the camera only once this viewer puts it there from the camera bar.
 */
data class StreamItem(
    val participantId: String,
    val participantName: String,
    /** Their shared screen; null when they share only a camera, or only sound. */
    val screenTrack: VideoTrack?,
    /** Their camera, while it is on, whether or not it is on the grid. */
    val cameraTrack: VideoTrack?,
    /** The sound of their screen, separate from their microphone. */
    val hasScreenAudio: Boolean,
    val hasMic: Boolean,
    /** Theirs is the sound this viewer is hearing. */
    val isAudioActive: Boolean,
    /** This viewer turned their microphone on; it starts off. */
    val micOn: Boolean,
    /** This viewer put their camera on the grid. */
    val cameraShown: Boolean,
    val avatar: String? = null
)

/**
 * WHIP publishers join under their owner's identity plus this, so they can be
 * folded back into that person rather than shown as someone else.
 */
internal const val WHIP_SUFFIX = "-gpu"

/**
 * Whose broadcasts this viewer is watching, announced as the desktop does
 * (desktop/src/renderer/livekit/watching.ts): broadcasters see who watches
 * them, and the server kicks nobody who is watching for being idle (ADR 0037).
 */
internal const val WATCHING_ATTRIBUTE = "zoia.watching"

/** The attribute's value: the people whose picture is on screen, sorted. */
internal fun watchingValue(onScreen: Iterable<String>): String = onScreen.sorted().joinToString(",")

internal fun ownerIdentity(identity: String): String = identity.removeSuffix(WHIP_SUFFIX)

/**
 * Who is in voice (ADR 0039), set by the server; must match VOICE_ATTRIBUTE
 * in server/src/stage.js. This app does not join voice, so a voice is never
 * a broadcast here, and never played.
 */
internal const val VOICE_ATTRIBUTE = "zoia.voice"
internal const val AVATAR_ATTRIBUTE = "zoia.avatar"
internal const val SOUNDBOARD_TOPIC = "zoia.soundboard"

/** A published track, with where it came from. */
internal data class Feed<T>(val source: Track.Source, val track: T, val fromIngress: Boolean)

internal data class PersonFeeds<V, A>(
    val screen: V?,
    val camera: V?,
    val screenAudio: A?,
    val mic: A?
)

/**
 * Where a stream came from decides how it is labelled, and viewers must not
 * care. WHIP carries no notion of a screen share, so an ingress may label its
 * tracks CAMERA and MICROPHONE: everything an ingress sends is the screen, and
 * only a person's own Camera and Microphone are their camera. A camera is
 * never the screen, even shared alone: it is opened from the camera bar.
 */
internal fun <V, A> pickFeeds(
    video: List<Feed<V>>,
    audio: List<Feed<A>>,
    inVoice: Boolean = false
): PersonFeeds<V, A> {
    val screen = video.firstOrNull { it.fromIngress }
        ?: video.firstOrNull { !it.fromIngress && it.source != Track.Source.CAMERA }
    val camera = video.firstOrNull { !it.fromIngress && it.source == Track.Source.CAMERA }
    val screenAudio = audio.firstOrNull { it.fromIngress }
        ?: audio.firstOrNull { !it.fromIngress && it.source != Track.Source.MICROPHONE }
    // In voice, a person's microphone is their voice, not their camera's.
    val mic = if (inVoice) null
        else audio.firstOrNull { !it.fromIngress && it.source == Track.Source.MICROPHONE }
    return PersonFeeds(
        screen = screen?.track,
        camera = camera?.track,
        screenAudio = screenAudio?.track,
        mic = mic?.track
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

    // Voice channel (ADR 0039)
    private val _isInVoice = MutableStateFlow(false)
    val isInVoice: StateFlow<Boolean> = _isInVoice.asStateFlow()

    private val _isMicrophoneMuted = MutableStateFlow(true)
    val isMicrophoneMuted: StateFlow<Boolean> = _isMicrophoneMuted.asStateFlow()

    private val _activeSpeakers = MutableStateFlow<Set<String>>(emptySet())
    val activeSpeakers: StateFlow<Set<String>> = _activeSpeakers.asStateFlow()

    private val _voiceMembers = MutableStateFlow<List<VoiceMember>>(emptyList())
    val voiceMembers: StateFlow<List<VoiceMember>> = _voiceMembers.asStateFlow()

    private var soundboardPlayer: MediaPlayer? = null
    private val _currentSound = MutableStateFlow<String?>(null)
    val currentSound: StateFlow<String?> = _currentSound.asStateFlow()

    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val audioPrefs = context.getSharedPreferences("zoia_audio_settings", Context.MODE_PRIVATE)

    private val _micVolume = MutableStateFlow(audioPrefs.getFloat("mic_volume", 1.0f))
    val micVolume: StateFlow<Float> = _micVolume.asStateFlow()

    private val _outputVolume = MutableStateFlow(audioPrefs.getFloat("output_volume", 1.0f))
    val outputVolume: StateFlow<Float> = _outputVolume.asStateFlow()

    fun setMicVolume(volume: Float) {
        val clamped = volume.coerceIn(0.1f, 2.0f)
        _micVolume.value = clamped
        audioPrefs.edit().putFloat("mic_volume", clamped).apply()
        applyAudioVolumes()
    }

    fun setOutputVolume(volume: Float) {
        val clamped = volume.coerceIn(0.0f, 2.0f)
        _outputVolume.value = clamped
        audioPrefs.edit().putFloat("output_volume", clamped).apply()
        applyAudioVolumes()
    }

    fun applyAudioVolumes() {
        val micVol = _micVolume.value.toDouble()
        val outVol = _outputVolume.value.toDouble()
        val currentRoom = room ?: return

        try {
            currentRoom.localParticipant.audioTrackPublications.forEach { (_, track) ->
                if (track is AudioTrack) {
                    track.rtcTrack?.setVolume(micVol)
                }
            }

            currentRoom.remoteParticipants.values.forEach { participant ->
                participant.audioTrackPublications.forEach { (_, track) ->
                    if (track is AudioTrack) {
                        track.rtcTrack?.setVolume(outVol)
                    }
                }
            }
        } catch (_: Exception) {}
    }

    private val _availableOutputs = MutableStateFlow<List<AudioDevice>>(emptyList())
    val availableOutputs: StateFlow<List<AudioDevice>> = _availableOutputs.asStateFlow()

    private val _selectedOutput = MutableStateFlow<AudioDevice?>(null)
    val selectedOutput: StateFlow<AudioDevice?> = _selectedOutput.asStateFlow()

    private val _availableInputs = MutableStateFlow<List<AudioDeviceInfo>>(emptyList())
    val availableInputs: StateFlow<List<AudioDeviceInfo>> = _availableInputs.asStateFlow()

    private val _selectedInputId = MutableStateFlow<Int?>(null)
    val selectedInputId: StateFlow<Int?> = _selectedInputId.asStateFlow()

    fun refreshAudioDevices() {
        val audioSwitch = room?.audioSwitchHandler
        if (audioSwitch != null) {
            _availableOutputs.value = audioSwitch.availableAudioDevices
            _selectedOutput.value = audioSwitch.selectedAudioDevice
        }
        try {
            val inputs = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).toList()
            _availableInputs.value = inputs
        } catch (_: Exception) {}
    }

    fun selectAudioOutput(device: AudioDevice) {
        val audioSwitch = room?.audioSwitchHandler
        if (audioSwitch != null) {
            audioSwitch.selectDevice(device)
            _selectedOutput.value = device
        }
        try {
            audioManager.isSpeakerphoneOn = (device is AudioDevice.Speakerphone)
        } catch (_: Exception) {}
    }

    fun selectAudioInput(deviceInfo: AudioDeviceInfo?) {
        _selectedInputId.value = deviceInfo?.id
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                if (deviceInfo != null) {
                    audioManager.setCommunicationDevice(deviceInfo)
                } else {
                    audioManager.clearCommunicationDevice()
                }
            } catch (_: Exception) {}
        }
    }

    // Whose camera this viewer put on the grid, and whose microphone it turned
    // on, by person. Both start empty in every channel, and neither is kept:
    // nobody's camera opens and nobody's microphone plays by itself.
    private var cameraShown: Set<String> = emptySet()
    private var micOn: Set<String> = emptySet()
    // What was last announced as watched, so an unchanged list is not resent.
    private var announcedWatching: String? = null

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
            try {
                newRoom.audioSwitchHandler?.audioDeviceChangeListener = { available, selected ->
                    _availableOutputs.value = available
                    _selectedOutput.value = selected
                }
                refreshAudioDevices()
            } catch (_: Exception) {}

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
            is RoomEvent.ActiveSpeakersChanged -> {
                _activeSpeakers.value = event.speakers.mapNotNull { it.identity?.value }.toSet()
                updateStreamsList()
            }
            is RoomEvent.DataReceived -> {
                handleDataReceived(event)
            }
            is RoomEvent.Disconnected -> {
                try {
                    soundboardPlayer?.release()
                    soundboardPlayer = null
                    _currentSound.value = null
                } catch (_: Exception) {}
                try {
                    BackgroundAudioService.stop(context)
                } catch (_: Exception) {}
                _connectionState.value = RoomConnectionState.Disconnected
                _streams.value = emptyList()
                _selectedAudioParticipantId.value = null
                cameraShown = emptySet()
                micOn = emptySet()
                announcedWatching = null
            }
            else -> Unit
        }
    }

    private fun handleDataReceived(event: RoomEvent.DataReceived) {
        if (event.topic == SOUNDBOARD_TOPIC) {
            try {
                val text = String(event.data, Charsets.UTF_8)
                val json = Json.parseToJsonElement(text).jsonObject
                val url = json["url"]?.jsonPrimitive?.content ?: json["sound"]?.jsonPrimitive?.content ?: ""
                val name = json["name"]?.jsonPrimitive?.content ?: ""
                if (url.startsWith("https://www.myinstants.com/media/sounds/")) {
                    _currentSound.value = name.ifBlank { "Efeito sonoro" }
                    soundboardPlayer?.release()
                    soundboardPlayer = MediaPlayer().apply {
                        setDataSource(url)
                        setOnPreparedListener { start() }
                        setOnCompletionListener {
                            release()
                            soundboardPlayer = null
                            _currentSound.value = null
                        }
                        setOnErrorListener { _, _, _ ->
                            release()
                            soundboardPlayer = null
                            _currentSound.value = null
                            true
                        }
                        prepareAsync()
                    }
                }
            } catch (_: Exception) {}
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

            val inVoice = human?.attributes?.get(VOICE_ATTRIBUTE) == "1"
            val feeds = pickFeeds(
                video = feedsOf<VideoTrack>(human, ingress) { it.videoTrackPublications },
                audio = feedsOf<AudioTrack>(human, ingress) { it.audioTrackPublications },
                inVoice = inVoice
            )
            // In voice (ADR 0039), everyone in voice is heard by everyone else in the channel
            if (inVoice) {
                human?.audioTrackPublications?.forEach { (publication, track) ->
                    if (publication.source == Track.Source.MICROPHONE) {
                        (track as? AudioTrack)?.enabled = true
                    }
                }
            }

            // Only include participants who are actively broadcasting (skip passive viewers)
            if (feeds.screen == null && feeds.camera == null &&
                feeds.screenAudio == null && feeds.mic == null
            ) {
                return@mapNotNull null
            }

            val hasAudio = feeds.screenAudio != null || feeds.mic != null
            val isAudioActive = (owner == activeAudioId) || (activeAudioId == null && hasAudio)
            val ownMicOn = owner in micOn

            // One person's screen audio is heard at a time.
            participants.forEach { participant ->
                participant.audioTrackPublications.forEach { (publication, track) ->
                    if (publication.source != Track.Source.MICROPHONE) {
                        (track as? AudioTrack)?.let {
                            it.enabled = isAudioActive && it == feeds.screenAudio
                        }
                    } else if (!inVoice) {
                        (track as? AudioTrack)?.let {
                            it.enabled = isAudioActive && (it == feeds.mic && ownMicOn)
                        }
                    }
                }
            }

            // A WHIP publisher carries the name it joined with, so a later
            // rename would leave a stale label. The human is always current.
            val displayName = (human ?: ingress)?.name?.takeIf { it.isNotBlank() }
                ?: owner

            StreamItem(
                participantId = owner,
                participantName = displayName,
                screenTrack = feeds.screen,
                cameraTrack = feeds.camera,
                hasScreenAudio = feeds.screenAudio != null,
                hasMic = feeds.mic != null,
                isAudioActive = isAudioActive,
                micOn = ownMicOn,
                cameraShown = owner in cameraShown && feeds.camera != null,
                avatar = human?.attributes?.get(AVATAR_ATTRIBUTE)
            )
        }

        // Set default active audio if not set yet: someone sharing a screen
        // first, since a camera is not on the grid until it is chosen.
        if (_selectedAudioParticipantId.value == null && items.isNotEmpty()) {
            _selectedAudioParticipantId.value =
                (items.firstOrNull { it.screenTrack != null } ?: items.first()).participantId
        }

        _streams.value = items

        // Collect participants in voice (ADR 0039)
        val activeSpeakersSet = _activeSpeakers.value
        val voiceList = mutableListOf<VoiceMember>()

        if (_isInVoice.value) {
            val local = currentRoom.localParticipant
            voiceList.add(
                VoiceMember(
                    identity = local.identity?.value ?: "local",
                    name = local.name?.takeIf { it.isNotBlank() } ?: "Você",
                    isSpeaking = local.identity?.value in activeSpeakersSet,
                    isMuted = _isMicrophoneMuted.value,
                    isLocal = true,
                    avatar = local.attributes[AVATAR_ATTRIBUTE]
                )
            )
        }

        people.forEach { (owner, participants) ->
            val human = participants.firstOrNull { it.identity?.value == owner }
            val inVoice = human?.attributes?.get(VOICE_ATTRIBUTE) == "1"
            if (inVoice) {
                val micPub = human?.audioTrackPublications?.firstOrNull { it.first.source == Track.Source.MICROPHONE }
                val isMuted = micPub?.first?.muted != false || micPub.second == null
                val displayName = human?.name?.takeIf { it.isNotBlank() } ?: owner
                voiceList.add(
                    VoiceMember(
                        identity = owner,
                        name = displayName,
                        isSpeaking = owner in activeSpeakersSet,
                        isMuted = isMuted,
                        isLocal = false,
                        avatar = human?.attributes?.get(AVATAR_ATTRIBUTE)
                    )
                )
            }
        }
        _voiceMembers.value = voiceList

        // Every screen in the list is on the grid; a camera only once chosen.
        val watching = watchingValue(
            items.filter { it.screenTrack != null || it.cameraShown }.map { it.participantId }
        )
        if (watching != announcedWatching) {
            announcedWatching = watching
            try {
                currentRoom.localParticipant.updateAttributes(mapOf(WATCHING_ATTRIBUTE to watching))
            } catch (_: Exception) {
                announcedWatching = null
            }
        }
        applyAudioVolumes()
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

    fun selectAudio(participantId: String) {
        _selectedAudioParticipantId.value = participantId
        updateStreamsList()
    }

    /** Puts someone's camera on the grid as a tile of its own, or takes it off. */
    fun toggleCamera(participantId: String) {
        cameraShown = if (participantId in cameraShown) cameraShown - participantId
        else cameraShown + participantId
        updateStreamsList()
    }

    /** Turns someone's microphone on or off for this viewer. It starts off. */
    fun toggleMic(participantId: String) {
        micOn = if (participantId in micOn) micOn - participantId else micOn + participantId
        updateStreamsList()
    }

    /** Joins the channel's voice (ADR 0039). */
    suspend fun joinVoice(): Boolean {
        val channelId = currentChannelId
        val currentRoom = room ?: return false
        return try {
            val res = apiClient.joinVoice(channelId)
            if (res.ok) {
                _isInVoice.value = true
                if (!_isMicrophoneMuted.value) {
                    currentRoom.localParticipant.setMicrophoneEnabled(true)
                    applyAudioVolumes()
                }
                updateStreamsList()
                true
            } else {
                false
            }
        } catch (_: Exception) {
            false
        }
    }

    /** Leaves the channel's voice. */
    suspend fun leaveVoice() {
        val channelId = currentChannelId
        val currentRoom = room
        try {
            currentRoom?.localParticipant?.setMicrophoneEnabled(false)
            apiClient.leaveVoice(channelId)
        } catch (_: Exception) {}
        _isInVoice.value = false
        updateStreamsList()
    }

    /** Mutes or unmutes the local microphone when in voice. */
    fun setMicrophoneMuted(muted: Boolean) {
        _isMicrophoneMuted.value = muted
        if (_isInVoice.value) {
            scope.launch {
                try {
                    room?.localParticipant?.setMicrophoneEnabled(!muted)
                    if (!muted) {
                        applyAudioVolumes()
                    }
                } catch (_: Exception) {}
            }
        }
        updateStreamsList()
    }

    fun toggleMicrophone() {
        setMicrophoneMuted(!_isMicrophoneMuted.value)
    }

    fun disconnect() {
        if (_isInVoice.value) {
            val channelId = currentChannelId
            scope.launch {
                try {
                    apiClient.leaveVoice(channelId)
                } catch (_: Exception) {}
            }
        }
        try {
            BackgroundAudioService.stop(context)
        } catch (_: Exception) {}
        try {
            soundboardPlayer?.release()
            soundboardPlayer = null
            _currentSound.value = null
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
        currentChannelId = null
        _connectionState.value = RoomConnectionState.Disconnected
        _streams.value = emptyList()
        _selectedAudioParticipantId.value = null
        _isInVoice.value = false
        _activeSpeakers.value = emptySet()
        _voiceMembers.value = emptyList()
        cameraShown = emptySet()
        micOn = emptySet()
        announcedWatching = null
    }
}
