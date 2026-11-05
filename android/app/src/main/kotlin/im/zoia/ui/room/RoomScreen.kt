package im.zoia.ui.room

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.VolumeMute
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.AdminPanelSettings
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import im.zoia.api.ApiException
import im.zoia.api.RoomInfo
import im.zoia.api.ZoiaApiClient
import im.zoia.auth.SessionManager
import im.zoia.auth.SessionState
import im.zoia.chat.ChatManager
import im.zoia.livekit.LiveKitRoomManager
import im.zoia.livekit.RoomConnectionState
import im.zoia.livekit.StreamItem
import im.zoia.livekit.VoiceMember
import im.zoia.ui.admin.AdminDialog
import im.zoia.ui.audio.AudioSettingsDialog
import im.zoia.ui.chat.ChatPanel
import im.zoia.ui.common.UserAvatar
import im.zoia.ZoiaApp
import im.zoia.ui.profile.ProfileDialog
import im.zoia.ui.update.UpdateDialog
import io.livekit.android.room.track.VideoTrack
import livekit.org.webrtc.SurfaceViewRenderer
import kotlinx.coroutines.launch

@Composable
fun RoomScreen(
    roomManager: LiveKitRoomManager,
    sessionManager: SessionManager,
    apiClient: ZoiaApiClient,
    onEnterPiP: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val sessionState by sessionManager.sessionState.collectAsState()
    val updateManager = remember { ZoiaApp.instance.updateManager }
    val updateState by updateManager.updateState.collectAsState()

    LaunchedEffect(Unit) {
        updateManager.checkForUpdates(silent = true)
    }
    val currentDeviceName = (sessionState as? SessionState.Authenticated)?.deviceName
        ?: sessionManager.getSavedDisplayName()
        ?: "Dispositivo"

    val connectionState by roomManager.connectionState.collectAsState()
    val streams by roomManager.streams.collectAsState()
    val selectedAudioId by roomManager.selectedAudioParticipantId.collectAsState()
    val isInVoice by roomManager.isInVoice.collectAsState()
    val isMicMuted by roomManager.isMicrophoneMuted.collectAsState()
    val activeSpeakers by roomManager.activeSpeakers.collectAsState()
    val voiceMembers by roomManager.voiceMembers.collectAsState()
    val currentSound by roomManager.currentSound.collectAsState()

    val micPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        if (isGranted) {
            scope.launch {
                roomManager.joinVoice()
                roomManager.setMicrophoneMuted(false)
            }
        }
    }

    var availableRooms by remember { mutableStateOf<List<RoomInfo>>(emptyList()) }
    var showChannelsDialog by remember { mutableStateOf(false) }
    var showProfileDialog by remember { mutableStateOf(false) }
    var showAdminDialog by remember { mutableStateOf(false) }
    var showAudioSettingsDialog by remember { mutableStateOf(false) }
    var pendingApprovalsCount by remember { mutableIntStateOf(0) }

    val chatManager = remember { ChatManager(apiClient = apiClient, scope = scope) }
    var isChatOpen by remember { mutableStateOf(true) }
    val totalUnread by chatManager.totalUnread.collectAsState()
    val totalMentions by chatManager.totalMentions.collectAsState()

    val authenticated = sessionState as? SessionState.Authenticated
    val isAdmin = authenticated?.isAdmin == true

    fun refreshRooms() {
        scope.launch {
            try {
                val response = apiClient.getRooms()
                availableRooms = response.rooms
                response.you?.pendingApprovals?.let { pendingApprovalsCount = it }
                // Made or unmade an admin since we last asked: take it in now.
                val role = response.you?.role
                if (role != null && authenticated != null && role != authenticated.role) {
                    sessionManager.refresh()
                }
            } catch (e: Exception) {
                if (e is kotlin.coroutines.cancellation.CancellationException) throw e
                // Refused rather than unreachable: signed out or disabled
                // from elsewhere. Asking who we are now signs out at once.
                if (e is ApiException && (e.statusCode == 401 || e.statusCode == 403)) {
                    sessionManager.refresh()
                }
            }
        }
    }

    LaunchedEffect(Unit) {
        refreshRooms()
    }

    DisposableEffect(Unit) {
        chatManager.start()
        onDispose {
            chatManager.stop()
            roomManager.disconnect()
        }
    }

    val roomTitle = when (connectionState) {
        is RoomConnectionState.Connected -> (connectionState as RoomConnectionState.Connected).roomName
        is RoomConnectionState.Connecting -> roomManager.currentChannelId ?: "Conectando..."
        else -> null
    }

    if (showChannelsDialog) {
        ChannelsDialog(
            currentRoomName = roomTitle ?: "",
            availableRooms = availableRooms,
            onSelectRoom = { roomInfo ->
                scope.launch {
                    roomManager.connectToRoom(roomInfo.id)
                }
            },
            canCreate = isAdmin,
            onCreateRoom = { newName ->
                scope.launch {
                    try {
                        val response = apiClient.createRoom(newName)
                        refreshRooms()
                        roomManager.connectToRoom(response.room.id)
                        showChannelsDialog = false
                    } catch (_: Exception) {
                        refreshRooms()
                    }
                }
            },
            onDeleteRoom = { roomInfo ->
                scope.launch {
                    try {
                        apiClient.deleteRoom(roomInfo.id)
                        refreshRooms()
                    } catch (_: Exception) {}
                }
            },
            onRefresh = { refreshRooms() },
            onDismiss = { showChannelsDialog = false }
        )
    }

    if (showProfileDialog) {
        val serverUrl = apiClient.serverUrl ?: ""
        ProfileDialog(
            currentName = currentDeviceName,
            currentAvatar = authenticated?.avatar,
            accountId = authenticated?.accountId ?: "",
            role = authenticated?.role ?: "user",
            serverUrl = serverUrl,
            onSaveName = { newName ->
                val result = sessionManager.renameDevice(newName)
                if (result.isSuccess) {
                    roomManager.updateLocalName(newName)
                    null
                } else {
                    result.exceptionOrNull()?.message ?: "Falha ao alterar nome."
                }
            },
            onUploadAvatar = { bytes ->
                val result = sessionManager.setAvatar(bytes)
                if (result.isSuccess) {
                    null
                } else {
                    result.exceptionOrNull()?.message ?: "Falha ao enviar avatar."
                }
            },
            onDeleteAvatar = {
                val result = sessionManager.deleteAvatar()
                if (result.isSuccess) {
                    null
                } else {
                    result.exceptionOrNull()?.message ?: "Falha ao remover avatar."
                }
            },
            onOpenAudioSettings = { showAudioSettingsDialog = true },
            onCheckUpdates = { updateManager.checkForUpdates(silent = false) },
            onSignOut = {
                roomManager.disconnect()
                scope.launch { sessionManager.signOut() }
            },
            onDismiss = { showProfileDialog = false }
        )
    }

    if (showAudioSettingsDialog) {
        AudioSettingsDialog(
            roomManager = roomManager,
            onDismiss = { showAudioSettingsDialog = false }
        )
    }

    UpdateDialog(
        state = updateState,
        onDownload = { info -> updateManager.downloadUpdate(info) },
        onInstall = { file -> updateManager.installUpdate(context, file) },
        onRetry = { updateManager.checkForUpdates(silent = false) },
        onDismiss = { updateManager.dismiss() }
    )

    if (showAdminDialog) {
        val serverUrl = apiClient.serverUrl ?: ""
        AdminDialog(
            apiClient = apiClient,
            myAccountId = authenticated?.accountId ?: "",
            myRole = authenticated?.role ?: "user",
            serverUrl = serverUrl,
            onDismiss = { showAdminDialog = false },
            onRefreshRooms = { refreshRooms() }
        )
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0D0F12))
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            // Header Bar
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(60.dp)
                    .background(Color(0xFF161920))
                    .padding(horizontal = 20.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                // Left: Logo + Room/Channel Switcher + Voice Pill
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = "Zoia",
                        color = Color(0xFF4E75FF),
                        fontSize = 20.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.width(16.dp))

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .background(Color(0xFF222630))
                            .clickable {
                                refreshRooms()
                                showChannelsDialog = true
                            }
                            .padding(horizontal = 12.dp, vertical = 6.dp)
                    ) {
                        Text(
                            text = if (roomTitle != null) "# $roomTitle" else "Escolha um canal",
                            color = if (roomTitle != null) Color.White else Color(0xFFB0B7C3),
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Icon(
                            imageVector = Icons.Default.ArrowDropDown,
                            contentDescription = "Trocar canal",
                            tint = Color(0xFF8E95A5),
                            modifier = Modifier.size(20.dp)
                        )
                    }

                    if (connectionState is RoomConnectionState.Connected) {
                        Spacer(modifier = Modifier.width(10.dp))
                        VoiceControlPill(
                            isInVoice = isInVoice,
                            isMicMuted = isMicMuted,
                            onJoinVoice = {
                                val hasPermission = ContextCompat.checkSelfPermission(
                                    context,
                                    Manifest.permission.RECORD_AUDIO
                                ) == PackageManager.PERMISSION_GRANTED
                                if (hasPermission) {
                                    scope.launch {
                                        roomManager.joinVoice()
                                        roomManager.setMicrophoneMuted(false)
                                    }
                                } else {
                                    micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                }
                            },
                            onLeaveVoice = {
                                scope.launch { roomManager.leaveVoice() }
                            },
                            onToggleMic = {
                                val hasPermission = ContextCompat.checkSelfPermission(
                                    context,
                                    Manifest.permission.RECORD_AUDIO
                                ) == PackageManager.PERMISSION_GRANTED
                                if (hasPermission) {
                                    roomManager.toggleMicrophone()
                                } else {
                                    micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                }
                            },
                            onOpenAudioSettings = { showAudioSettingsDialog = true }
                        )
                    }

                    if (currentSound != null) {
                        Spacer(modifier = Modifier.width(12.dp))
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .clip(RoundedCornerShape(16.dp))
                                .background(Color(0xFF283655))
                                .padding(horizontal = 10.dp, vertical = 4.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.GraphicEq,
                                contentDescription = null,
                                tint = Color(0xFF4E75FF),
                                modifier = Modifier.size(16.dp)
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(
                                text = currentSound ?: "",
                                color = Color.White,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold
                            )
                        }
                    }
                }

                // Right: Admin + Chat Button + User Profile + Disconnect + Exit
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (isAdmin) {
                        Box(modifier = Modifier.padding(end = 10.dp)) {
                            IconButton(
                                onClick = { showAdminDialog = true },
                                modifier = Modifier
                                    .clip(RoundedCornerShape(8.dp))
                                    .background(if (showAdminDialog) Color(0xFF283655) else Color(0xFF222630))
                                    .size(36.dp)
                            ) {
                                Icon(
                                    imageVector = Icons.Default.AdminPanelSettings,
                                    contentDescription = "Painel de Administração",
                                    tint = if (showAdminDialog) Color(0xFF4E75FF) else Color(0xFF8E95A5),
                                    modifier = Modifier.size(20.dp)
                                )
                            }
                            if (pendingApprovalsCount > 0) {
                                Box(
                                    modifier = Modifier
                                        .align(Alignment.TopEnd)
                                        .clip(CircleShape)
                                        .background(Color(0xFFE53935))
                                        .padding(horizontal = 4.dp, vertical = 1.dp)
                                ) {
                                    Text(
                                        text = if (pendingApprovalsCount > 99) "99+" else "$pendingApprovalsCount",
                                        color = Color.White,
                                        fontSize = 9.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                            }
                        }
                    }

                    // Chat button with unread / mention badge
                    Box(modifier = Modifier.padding(end = 12.dp)) {
                        IconButton(
                            onClick = { isChatOpen = !isChatOpen },
                            modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .background(if (isChatOpen) Color(0xFF283655) else Color(0xFF222630))
                                .size(36.dp)
                        ) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.Chat,
                                contentDescription = "Chat de texto",
                                tint = if (isChatOpen) Color(0xFF4E75FF) else Color(0xFF8E95A5),
                                modifier = Modifier.size(20.dp)
                            )
                        }
                        if (totalUnread > 0) {
                            Box(
                                modifier = Modifier
                                    .align(Alignment.TopEnd)
                                    .clip(CircleShape)
                                    .background(if (totalMentions > 0) Color(0xFFFF5252) else Color(0xFF4E75FF))
                                    .padding(horizontal = 4.dp, vertical = 1.dp)
                            ) {
                                Text(
                                    text = if (totalUnread > 99) "99+" else "$totalUnread",
                                    color = Color.White,
                                    fontSize = 9.sp,
                                    fontWeight = FontWeight.Bold
                                )
                            }
                        }
                    }

                    // Audio Devices Settings button
                    Box(modifier = Modifier.padding(end = 12.dp)) {
                        IconButton(
                            onClick = { showAudioSettingsDialog = true },
                            modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .background(if (showAudioSettingsDialog) Color(0xFF283655) else Color(0xFF222630))
                                .size(36.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.Tune,
                                contentDescription = "Dispositivos de áudio",
                                tint = if (showAudioSettingsDialog) Color(0xFF4E75FF) else Color(0xFF8E95A5),
                                modifier = Modifier.size(20.dp)
                            )
                        }
                    }

                    val myAvatarUrl = authenticated?.avatar?.let {
                        "${apiClient.serverUrl}/api/avatar/account/${authenticated.accountId}?v=$it"
                    }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .background(Color(0xFF222630))
                            .clickable { showProfileDialog = true }
                            .padding(horizontal = 10.dp, vertical = 6.dp)
                    ) {
                        UserAvatar(
                            name = currentDeviceName,
                            avatarUrl = myAvatarUrl,
                            role = authenticated?.role,
                            size = 24.dp
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = currentDeviceName,
                            color = Color.White,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Medium
                        )
                    }

                    Spacer(modifier = Modifier.width(12.dp))

                    // Disconnect button
                    if (connectionState is RoomConnectionState.Connected) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .background(Color(0xFF381A22))
                                .clickable { roomManager.disconnect() }
                                .padding(horizontal = 10.dp, vertical = 6.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.PowerSettingsNew,
                                contentDescription = "Sair da transmissão",
                                tint = Color(0xFFFF5252),
                                modifier = Modifier.size(16.dp)
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(
                                text = "Sair",
                                color = Color(0xFFFF8A8A),
                                fontSize = 13.sp,
                                fontWeight = FontWeight.SemiBold
                            )
                        }
                    }

                    Spacer(modifier = Modifier.width(8.dp))

                    // Close app button
                    IconButton(onClick = {
                        roomManager.disconnect()
                        (context as? Activity)?.finish()
                    }) {
                        Icon(
                            imageVector = Icons.Default.Close,
                            contentDescription = "Fechar aplicativo",
                            tint = Color(0xFF8E95A5)
                        )
                    }
                }
            }

            // Main Content Area with Optional Sliding Chat Panel
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
            ) {
                // Stream Area
                Box(
                    modifier = Modifier
                        .fillMaxHeight()
                        .weight(1f)
                        .padding(16.dp),
                    contentAlignment = Alignment.Center
                ) {
                    when (connectionState) {
                        is RoomConnectionState.Connecting -> {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                CircularProgressIndicator(color = Color(0xFF4E75FF))
                                Spacer(modifier = Modifier.height(16.dp))
                                Text(text = "Entrando no canal...", color = Color.White)
                            }
                        }
                        is RoomConnectionState.Connected -> {
                            val tiles = streams.flatMap { stream ->
                                listOfNotNull(
                                    if (stream.screenTrack != null || stream.hasScreenAudio) {
                                        Tile("${stream.participantId}#screen", stream, stream.screenTrack, camera = false)
                                    } else {
                                        null
                                    },
                                    if (stream.cameraShown) {
                                        Tile("${stream.participantId}#camera", stream, stream.cameraTrack, camera = true)
                                    } else {
                                        null
                                    }
                                )
                            }
                            val withCamera = streams.filter { it.cameraTrack != null }

                            Column(modifier = Modifier.fillMaxSize()) {
                                if (voiceMembers.isNotEmpty()) {
                                    VoiceMembersBar(members = voiceMembers, serverUrl = apiClient.serverUrl ?: "")
                                    Spacer(modifier = Modifier.height(8.dp))
                                }

                                if (withCamera.isNotEmpty()) {
                                    CameraBar(
                                        people = withCamera,
                                        onToggle = { roomManager.toggleCamera(it.participantId) }
                                    )
                                    Spacer(modifier = Modifier.height(12.dp))
                                }

                                if (tiles.isEmpty()) {
                                    Box(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .weight(1f),
                                        contentAlignment = Alignment.Center
                                    ) {
                                        Text(
                                            text = if (withCamera.isEmpty()) {
                                                "Nenhuma transmissão ativa neste canal.\nQuando alguém compartilhar a tela ou a câmera, o vídeo aparecerá aqui."
                                            } else {
                                                "Ninguém está compartilhando a tela.\nToque numa câmera acima para vê-la aqui."
                                            },
                                            color = Color(0xFF6B7280),
                                            fontSize = 16.sp,
                                            textAlign = TextAlign.Center
                                        )
                                    }
                                } else {
                                    val columns = if (tiles.size == 1) 1 else 2
                                    LazyVerticalGrid(
                                        columns = GridCells.Fixed(columns),
                                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                                        verticalArrangement = Arrangement.spacedBy(12.dp),
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .weight(1f)
                                    ) {
                                        items(
                                            items = tiles,
                                            key = { it.key }
                                        ) { tile ->
                                            val stream = tile.stream
                                            StreamCard(
                                                tile = tile,
                                                roomManager = roomManager,
                                                isAudioSelected = stream.participantId == selectedAudioId,
                                                isSpeaking = stream.participantId in activeSpeakers,
                                                serverUrl = apiClient.serverUrl ?: "",
                                                onSelectAudio = { roomManager.selectAudio(stream.participantId) },
                                                onToggleMic = {
                                                    if (!stream.micOn && stream.participantId != selectedAudioId) {
                                                        roomManager.selectAudio(stream.participantId)
                                                    }
                                                    roomManager.toggleMic(stream.participantId)
                                                }
                                            )
                                        }
                                    }
                                }
                            }
                        }
                        is RoomConnectionState.Disconnected -> {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.Center
                            ) {
                                Text(
                                    text = "Escolha um canal",
                                    color = Color.White,
                                    fontSize = 20.sp,
                                    fontWeight = FontWeight.Bold
                                )
                                Spacer(modifier = Modifier.height(8.dp))
                                Text(
                                    text = "Clique em um canal na lista para entrar.",
                                    color = Color(0xFF8E95A5),
                                    fontSize = 14.sp,
                                    textAlign = TextAlign.Center
                                )
                                Spacer(modifier = Modifier.height(20.dp))
                                Button(
                                    onClick = {
                                        refreshRooms()
                                        showChannelsDialog = true
                                    },
                                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E5BFF)),
                                    shape = RoundedCornerShape(8.dp)
                                ) {
                                    Text("Escolher Canal", color = Color.White)
                                }
                            }
                        }
                        is RoomConnectionState.Error -> {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text(
                                    text = (connectionState as RoomConnectionState.Error).message,
                                    color = Color(0xFFFF6B6B),
                                    fontSize = 16.sp,
                                    textAlign = TextAlign.Center
                                )
                                Spacer(modifier = Modifier.height(16.dp))
                                Button(
                                    onClick = { scope.launch { roomManager.connectToRoom(roomManager.currentChannelId) } },
                                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E5BFF)),
                                    shape = RoundedCornerShape(8.dp)
                                ) {
                                    Text("Tentar Novamente", color = Color.White)
                                }
                            }
                        }
                    }
                }

                // Chat Sliding Panel
                AnimatedVisibility(
                    visible = isChatOpen,
                    enter = slideInHorizontally { it } + fadeIn(),
                    exit = slideOutHorizontally { it } + fadeOut()
                ) {
                    ChatPanel(
                        chatManager = chatManager,
                        myAccountId = authenticated?.accountId ?: "",
                        myRole = authenticated?.role ?: "user",
                        onClose = { isChatOpen = false },
                        modifier = Modifier
                            .width(380.dp)
                            .fillMaxHeight()
                            .background(Color(0xFF161920))
                    )
                }
            }
        }
    }
}

@Composable
fun ChannelsDialog(
    currentRoomName: String,
    availableRooms: List<RoomInfo>,
    onSelectRoom: (RoomInfo) -> Unit,
    canCreate: Boolean,
    onCreateRoom: (String) -> Unit,
    onDeleteRoom: (RoomInfo) -> Unit,
    onRefresh: () -> Unit,
    onDismiss: () -> Unit
) {
    var newChannelName by remember { mutableStateOf("") }
    var isCreating by remember { mutableStateOf(false) }
    var roomToDelete by remember { mutableStateOf<RoomInfo?>(null) }

    if (roomToDelete != null) {
        val target = roomToDelete!!
        AlertDialog(
            onDismissRequest = { roomToDelete = null },
            containerColor = Color(0xFF161920),
            title = {
                Text(
                    text = "Excluir canal #${target.name}?",
                    color = Color.White,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold
                )
            },
            text = {
                Text(
                    text = "O canal será removido permanentemente. Esta ação só pode ser realizada se o canal estiver vazio.",
                    color = Color(0xFF8E95A5),
                    fontSize = 14.sp
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        val toDel = target
                        roomToDelete = null
                        onDeleteRoom(toDel)
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFE53935)),
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Text("Excluir", color = Color.White)
                }
            },
            dismissButton = {
                TextButton(onClick = { roomToDelete = null }) {
                    Text("Cancelar", color = Color(0xFF8E95A5))
                }
            }
        )
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Color(0xFF161920),
        title = {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Canais / Salas",
                    color = Color.White,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold
                )
                IconButton(onClick = onRefresh) {
                    Icon(
                        imageVector = Icons.Default.Refresh,
                        contentDescription = "Atualizar lista",
                        tint = Color(0xFF8E95A5)
                    )
                }
            }
        },
        text = {
            Column(modifier = Modifier.fillMaxWidth()) {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 240.dp)
                ) {
                    items(items = availableRooms, key = { it.id }) { room ->
                        val isCurrent = room.name == currentRoomName
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8.dp))
                                .background(if (isCurrent) Color(0xFF222630) else Color.Transparent)
                                .clickable {
                                    onSelectRoom(room)
                                    onDismiss()
                                }
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = "# ${room.name}",
                                    color = if (isCurrent) Color(0xFF4E75FF) else Color.White,
                                    fontSize = 15.sp,
                                    fontWeight = if (isCurrent) FontWeight.Bold else FontWeight.Normal
                                )
                                val broadcasterCount = room.broadcasters.size
                                val participantCount = room.participants.size
                                Text(
                                    text = "$broadcasterCount transmitindo • $participantCount no canal",
                                    color = Color(0xFF8E95A5),
                                    fontSize = 12.sp
                                )
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                if (isCurrent) {
                                    Icon(
                                        imageVector = Icons.Default.Check,
                                        contentDescription = "Canal atual",
                                        tint = Color(0xFF4E75FF),
                                        modifier = Modifier.size(18.dp)
                                    )
                                    Spacer(modifier = Modifier.width(6.dp))
                                }
                                if (canCreate && !room.isDefault) {
                                    IconButton(
                                        onClick = { roomToDelete = room },
                                        modifier = Modifier.size(28.dp)
                                    ) {
                                        Icon(
                                            imageVector = Icons.Default.Delete,
                                            contentDescription = "Excluir canal",
                                            tint = Color(0xFFFF6B6B),
                                            modifier = Modifier.size(16.dp)
                                        )
                                    }
                                }
                            }
                        }
                        Spacer(modifier = Modifier.height(4.dp))
                    }
                }

                if (canCreate) {
                    Spacer(modifier = Modifier.height(16.dp))
                    Text(
                        text = "Criar Novo Canal",
                        color = Color.White,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        OutlinedTextField(
                            value = newChannelName,
                            onValueChange = { newChannelName = it },
                            placeholder = { Text(text = "Nome do canal", color = Color(0xFF5F6675)) },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White,
                                focusedBorderColor = Color(0xFF4E75FF),
                                unfocusedBorderColor = Color(0xFF333842),
                                focusedContainerColor = Color(0xFF0D0F12),
                                unfocusedContainerColor = Color(0xFF0D0F12)
                            ),
                            modifier = Modifier.weight(1f)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Button(
                            onClick = {
                                val trimmed = newChannelName.trim()
                                if (trimmed.isNotEmpty()) {
                                    isCreating = true
                                    onCreateRoom(trimmed)
                                }
                            },
                            enabled = !isCreating && newChannelName.isNotBlank(),
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E5BFF)),
                            shape = RoundedCornerShape(8.dp)
                        ) {
                            Text("Criar", color = Color.White)
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("Fechar", color = Color(0xFF4E75FF))
            }
        }
    )
}

data class Tile(
    val key: String,
    val stream: StreamItem,
    val track: VideoTrack?,
    val camera: Boolean
)

@Composable
fun CameraBar(people: List<StreamItem>, onToggle: (StreamItem) -> Unit) {
    LazyRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        items(items = people, key = { it.participantId }) { person ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .clip(RoundedCornerShape(20.dp))
                    .background(if (person.cameraShown) Color(0xFF2E5BFF) else Color(0xFF222630))
                    .clickable { onToggle(person) }
                    .padding(horizontal = 14.dp, vertical = 10.dp)
            ) {
                Icon(
                    imageVector = if (person.cameraShown) Icons.Default.Videocam else Icons.Default.VideocamOff,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(20.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = person.participantName,
                    color = Color.White,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium
                )
            }
        }
    }
}

@Composable
fun VoiceControlPill(
    isInVoice: Boolean,
    isMicMuted: Boolean,
    onJoinVoice: () -> Unit,
    onLeaveVoice: () -> Unit,
    onToggleMic: () -> Unit,
    onOpenAudioSettings: () -> Unit
) {
    if (!isInVoice) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .clip(RoundedCornerShape(8.dp))
                .background(Color(0xFF222630))
                .clickable { onJoinVoice() }
                .padding(horizontal = 10.dp, vertical = 6.dp)
        ) {
            Icon(
                imageVector = Icons.Default.Mic,
                contentDescription = "Entrar em voz",
                tint = Color(0xFF4E75FF),
                modifier = Modifier.size(16.dp)
            )
            Spacer(modifier = Modifier.width(6.dp))
            Text(
                text = "Voz",
                color = Color.White,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium
            )
        }
    } else {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .clip(RoundedCornerShape(8.dp))
                .background(Color(0xFF1E3A2F))
                .padding(horizontal = 8.dp, vertical = 4.dp)
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .clickable { onToggleMic() }
                    .padding(horizontal = 6.dp, vertical = 2.dp)
            ) {
                Icon(
                    imageVector = if (isMicMuted) Icons.Default.MicOff else Icons.Default.Mic,
                    contentDescription = if (isMicMuted) "Microfone mutado" else "Microfone aberto",
                    tint = if (isMicMuted) Color(0xFFFF5252) else Color(0xFF23A55A),
                    modifier = Modifier.size(16.dp)
                )
                Spacer(modifier = Modifier.width(4.dp))
                Text(
                    text = if (isMicMuted) "Mutado" else "Em Voz",
                    color = if (isMicMuted) Color(0xFFFF8A8A) else Color(0xFF7AE7A7),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold
                )
            }
            Spacer(modifier = Modifier.width(6.dp))
            Icon(
                imageVector = Icons.Default.Tune,
                contentDescription = "Configurações de áudio",
                tint = Color(0xFF8E95A5),
                modifier = Modifier
                    .size(16.dp)
                    .clip(CircleShape)
                    .clickable { onOpenAudioSettings() }
            )
            Spacer(modifier = Modifier.width(6.dp))
            Icon(
                imageVector = Icons.Default.Close,
                contentDescription = "Sair da voz",
                tint = Color(0xFF8E95A5),
                modifier = Modifier
                    .size(14.dp)
                    .clip(CircleShape)
                    .clickable { onLeaveVoice() }
            )
        }
    }
}

@Composable
fun VoiceMembersBar(members: List<VoiceMember>, serverUrl: String) {
    if (members.isEmpty()) return

    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    // Active speakers first, then alphabetical by name
    val sortedMembers = remember(members) {
        members.sortedWith(
            compareByDescending<VoiceMember> { it.isSpeaking }
                .thenBy { it.name.lowercase() }
        )
    }

    // Auto-scroll to beginning when someone starts speaking
    val anySpeaking = members.any { it.isSpeaking }
    LaunchedEffect(anySpeaking) {
        if (anySpeaking && listState.firstVisibleItemIndex > 0) {
            listState.animateScrollToItem(0)
        }
    }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp, vertical = 4.dp)
    ) {
        // Counter indicator chip
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .clip(RoundedCornerShape(12.dp))
                .background(Color(0xFF1B1F27))
                .padding(horizontal = 8.dp, vertical = 6.dp)
        ) {
            Icon(
                imageVector = Icons.Default.GraphicEq,
                contentDescription = null,
                tint = if (anySpeaking) Color(0xFF23A55A) else Color(0xFF4E75FF),
                modifier = Modifier.size(14.dp)
            )
            Spacer(modifier = Modifier.width(4.dp))
            Text(
                text = "${members.size}",
                color = Color(0xFFB0B7C3),
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold
            )
        }

        Spacer(modifier = Modifier.width(6.dp))

        // Left carousel scroll button
        AnimatedVisibility(visible = listState.canScrollBackward) {
            IconButton(
                onClick = {
                    scope.launch {
                        val prev = (listState.firstVisibleItemIndex - 2).coerceAtLeast(0)
                        listState.animateScrollToItem(prev)
                    }
                },
                modifier = Modifier.size(28.dp)
            ) {
                Icon(
                    imageVector = Icons.Default.ChevronLeft,
                    contentDescription = "Anterior",
                    tint = Color(0xFFB0B7C3),
                    modifier = Modifier.size(20.dp)
                )
            }
        }

        // Carousel of voice members
        LazyRow(
            state = listState,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(horizontal = 4.dp),
            modifier = Modifier.weight(1f)
        ) {
            items(items = sortedMembers, key = { it.identity }) { member ->
                val avatarUrl = member.avatar?.let { "$serverUrl/api/avatar/${member.identity}?v=$it" }
                val borderColor by animateColorAsState(
                    targetValue = if (member.isSpeaking) Color(0xFF23A55A) else Color(0xFF2E3440),
                    label = "speakingBorder"
                )
                val backgroundColor by animateColorAsState(
                    targetValue = if (member.isSpeaking) Color(0xFF1B2A20) else Color(0xFF1E222B),
                    label = "speakingBg"
                )

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .clip(RoundedCornerShape(16.dp))
                        .background(backgroundColor)
                        .border(
                            width = if (member.isSpeaking) 2.dp else 1.dp,
                            color = borderColor,
                            shape = RoundedCornerShape(16.dp)
                        )
                        .padding(horizontal = 10.dp, vertical = 6.dp)
                ) {
                    UserAvatar(
                        name = member.name,
                        avatarUrl = avatarUrl,
                        size = 20.dp,
                        isSpeaking = member.isSpeaking
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        text = member.name,
                        color = Color.White,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium
                    )
                    if (member.isMuted) {
                        Spacer(modifier = Modifier.width(4.dp))
                        Icon(
                            imageVector = Icons.Default.MicOff,
                            contentDescription = "Mutado",
                            tint = Color(0xFFFF5252),
                            modifier = Modifier.size(13.dp)
                        )
                    }
                }
            }
        }

        // Right carousel scroll button
        AnimatedVisibility(visible = listState.canScrollForward) {
            IconButton(
                onClick = {
                    scope.launch {
                        val next = (listState.firstVisibleItemIndex + 2).coerceAtMost(sortedMembers.size - 1)
                        listState.animateScrollToItem(next)
                    }
                },
                modifier = Modifier.size(28.dp)
            ) {
                Icon(
                    imageVector = Icons.Default.ChevronRight,
                    contentDescription = "Próximo",
                    tint = Color(0xFFB0B7C3),
                    modifier = Modifier.size(20.dp)
                )
            }
        }
    }
}

@Composable
fun StreamCard(
    tile: Tile,
    roomManager: LiveKitRoomManager,
    isAudioSelected: Boolean,
    isSpeaking: Boolean = false,
    serverUrl: String,
    onSelectAudio: () -> Unit,
    onToggleMic: () -> Unit
) {
    val stream = tile.stream
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(16f / 9f)
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0xFF000000))
            .border(
                width = if (isSpeaking) 2.dp else if (isAudioSelected) 2.dp else 1.dp,
                color = if (isSpeaking) Color(0xFF23A55A) else if (isAudioSelected) Color(0xFF4E75FF) else Color(0xFF262A34),
                shape = RoundedCornerShape(12.dp)
            )
            .clickable { onSelectAudio() }
    ) {
        if (tile.track != null) {
            VideoTrackSurface(videoTrack = tile.track, roomManager = roomManager)
        } else {
            Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center
            ) {
                Text(text = "Apenas Áudio", color = Color.Gray, fontSize = 14.sp)
            }
        }

        // Overlay: Presenter name and audio toggle button
        Row(
            modifier = Modifier
                .align(Alignment.BottomStart)
                .fillMaxWidth()
                .background(Color(0x99000000))
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.weight(1f)
            ) {
                val avatarUrl = stream.avatar?.let { "$serverUrl/api/avatar/${stream.participantId}?v=$it" }
                UserAvatar(
                    name = stream.participantName,
                    avatarUrl = avatarUrl,
                    size = 24.dp,
                    isSpeaking = isSpeaking
                )
                Spacer(modifier = Modifier.width(8.dp))
                Column {
                    Text(
                        text = stream.participantName,
                        color = Color.White,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium
                    )
                    if (tile.camera) {
                        Text(text = "Câmera", color = Color(0xFF9BA3AF), fontSize = 12.sp)
                    }
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                if (stream.hasMic) {
                    Box(
                        modifier = Modifier
                            .size(32.dp)
                            .clip(CircleShape)
                            .background(if (stream.micOn) Color(0xFF2E5BFF) else Color(0xFF333842))
                            .clickable { onToggleMic() },
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            imageVector = if (stream.micOn) Icons.Default.Mic else Icons.Default.MicOff,
                            contentDescription = if (stream.micOn) {
                                "Silenciar o microfone de ${stream.participantName}"
                            } else {
                                "Ouvir o microfone de ${stream.participantName}"
                            },
                            tint = Color.White,
                            modifier = Modifier.size(18.dp)
                        )
                    }
                    Spacer(modifier = Modifier.width(8.dp))
                }
                Box(
                    modifier = Modifier
                        .size(32.dp)
                        .clip(CircleShape)
                        .background(if (isAudioSelected) Color(0xFF2E5BFF) else Color(0xFF333842))
                        .clickable { onSelectAudio() },
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = if (isAudioSelected) Icons.AutoMirrored.Filled.VolumeUp else Icons.AutoMirrored.Filled.VolumeMute,
                        contentDescription = null,
                        tint = Color.White,
                        modifier = Modifier.size(18.dp)
                    )
                }
            }
        }
    }
}

@Composable
fun VideoTrackSurface(videoTrack: VideoTrack, roomManager: LiveKitRoomManager) {
    key(videoTrack) { AndroidView(
        factory = { ctx ->
            SurfaceViewRenderer(ctx).apply {
                setEnableHardwareScaler(true)
                roomManager.initVideoRenderer(this)
                videoTrack.addRenderer(this)
            }
        },
        update = { renderer ->
            renderer.setEnableHardwareScaler(true)
        },
        onRelease = { renderer ->
            videoTrack.removeRenderer(renderer)
            renderer.release()
        },
        modifier = Modifier.fillMaxSize()
    ) }
}
