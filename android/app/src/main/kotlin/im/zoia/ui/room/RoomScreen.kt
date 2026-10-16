package im.zoia.ui.room

import android.app.Activity
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeMute
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.filled.Refresh
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
import im.zoia.api.RoomInfo
import im.zoia.api.ZoiaApiClient
import im.zoia.auth.SessionManager
import im.zoia.auth.SessionState
import im.zoia.livekit.LiveKitRoomManager
import im.zoia.livekit.RoomConnectionState
import im.zoia.livekit.StreamItem
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
    val currentDeviceName = (sessionState as? SessionState.Authenticated)?.deviceName
        ?: sessionManager.getSavedDisplayName()
        ?: "Dispositivo"

    val connectionState by roomManager.connectionState.collectAsState()
    val streams by roomManager.streams.collectAsState()
    val selectedAudioId by roomManager.selectedAudioParticipantId.collectAsState()

    var availableRooms by remember { mutableStateOf<List<RoomInfo>>(emptyList()) }
    var showChannelsDialog by remember { mutableStateOf(false) }
    var showRenameDialog by remember { mutableStateOf(false) }

    fun refreshRooms() {
        scope.launch {
            try {
                availableRooms = apiClient.getRooms().rooms
            } catch (_: Exception) {}
        }
    }

    LaunchedEffect(Unit) {
        roomManager.connectToRoom()
        refreshRooms()
    }

    DisposableEffect(Unit) {
        onDispose {
            roomManager.disconnect()
        }
    }

    val roomTitle = when (connectionState) {
        is RoomConnectionState.Connected -> (connectionState as RoomConnectionState.Connected).roomName
        else -> roomManager.currentChannelId ?: "Canal Principal"
    }

    if (showChannelsDialog) {
        ChannelsDialog(
            currentRoomName = roomTitle,
            availableRooms = availableRooms,
            onSelectRoom = { roomInfo ->
                scope.launch {
                    roomManager.connectToRoom(roomInfo.id)
                }
            },
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
            onRefresh = { refreshRooms() },
            onDismiss = { showChannelsDialog = false }
        )
    }

    if (showRenameDialog) {
        RenameDialog(
            currentName = currentDeviceName,
            onSave = { newName ->
                val result = sessionManager.renameDevice(newName)
                if (result.isSuccess) {
                    roomManager.updateLocalName(newName)
                    null
                } else {
                    result.exceptionOrNull()?.message ?: "Falha ao alterar nome."
                }
            },
            onUnpair = {
                roomManager.disconnect()
                sessionManager.unpair()
            },
            onDismiss = { showRenameDialog = false }
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
                // Left: Logo + Room/Channel Switcher
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
                            text = "# $roomTitle",
                            color = Color.White,
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
                }

                // Right: User Profile / Rename Pill + Disconnect + Exit
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .background(Color(0xFF222630))
                            .clickable { showRenameDialog = true }
                            .padding(horizontal = 12.dp, vertical = 6.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.Person,
                            contentDescription = null,
                            tint = Color(0xFF4E75FF),
                            modifier = Modifier.size(18.dp)
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(
                            text = currentDeviceName,
                            color = Color.White,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Medium
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Icon(
                            imageVector = Icons.Default.Edit,
                            contentDescription = "Editar nome",
                            tint = Color(0xFF8E95A5),
                            modifier = Modifier.size(14.dp)
                        )
                    }

                    Spacer(modifier = Modifier.width(12.dp))

                    // Disconnect button (stops stream and audio immediately without wiping credentials)
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

            // Stream Area
            Box(
                modifier = Modifier
                    .fillMaxSize()
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
                        if (streams.isEmpty()) {
                            Text(
                                text = "Nenhuma transmissão ativa neste canal.\nQuando alguém compartilhar tela, o vídeo aparecerá aqui.",
                                color = Color(0xFF6B7280),
                                fontSize = 16.sp,
                                textAlign = TextAlign.Center
                            )
                        } else {
                            val columns = if (streams.size == 1) 1 else 2
                            LazyVerticalGrid(
                                columns = GridCells.Fixed(columns),
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                                verticalArrangement = Arrangement.spacedBy(12.dp),
                                modifier = Modifier.fillMaxSize()
                            ) {
                                items(
                                    items = streams,
                                    key = { it.participantId }
                                ) { stream ->
                                    StreamCard(
                                        stream = stream,
                                        roomManager = roomManager,
                                        isAudioSelected = stream.participantId == selectedAudioId,
                                        onSelectAudio = { roomManager.selectAudio(stream.participantId) }
                                    )
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
                                text = "Transmissão desconectada",
                                color = Color.White,
                                fontSize = 20.sp,
                                fontWeight = FontWeight.Bold
                            )
                            Spacer(modifier = Modifier.height(8.dp))
                            Text(
                                text = "O áudio e o vídeo foram encerrados. Suas credenciais continuam salvas.",
                                color = Color(0xFF8E95A5),
                                fontSize = 14.sp,
                                textAlign = TextAlign.Center
                            )
                            Spacer(modifier = Modifier.height(24.dp))
                            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Button(
                                    onClick = { scope.launch { roomManager.connectToRoom(roomManager.currentChannelId) } },
                                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E5BFF)),
                                    shape = RoundedCornerShape(8.dp)
                                ) {
                                    Text("Reconectar ao Canal", color = Color.White)
                                }
                                Button(
                                    onClick = {
                                        refreshRooms()
                                        showChannelsDialog = true
                                    },
                                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF222630)),
                                    shape = RoundedCornerShape(8.dp)
                                ) {
                                    Text("Escolher Outra Sala", color = Color.White)
                                }
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
        }
    }
}

@Composable
fun ChannelsDialog(
    currentRoomName: String,
    availableRooms: List<RoomInfo>,
    onSelectRoom: (RoomInfo) -> Unit,
    onCreateRoom: (String) -> Unit,
    onRefresh: () -> Unit,
    onDismiss: () -> Unit
) {
    var newChannelName by remember { mutableStateOf("") }
    var isCreating by remember { mutableStateOf(false) }

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
                        contentDescription = "Atualizar canais",
                        tint = Color(0xFF8E95A5)
                    )
                }
            }
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp)
            ) {
                Text(
                    text = "Escolha um canal para assistir ou crie uma nova sala:",
                    color = Color(0xFF8E95A5),
                    fontSize = 13.sp
                )
                Spacer(modifier = Modifier.height(12.dp))

                // List of rooms
                if (availableRooms.isEmpty()) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 16.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text("Nenhum canal encontrado", color = Color(0xFF6B7280), fontSize = 14.sp)
                    }
                } else {
                    LazyColumn(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 240.dp)
                    ) {
                        items(availableRooms) { roomInfo ->
                            val isSelected = roomInfo.name.equals(currentRoomName, ignoreCase = true) ||
                                    (roomInfo.isDefault && currentRoomName == "Canal Principal")
                            val hasBroadcaster = roomInfo.broadcasters.isNotEmpty()

                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 4.dp)
                                    .clip(RoundedCornerShape(8.dp))
                                    .background(if (isSelected) Color(0xFF2E5BFF).copy(alpha = 0.2f) else Color(0xFF222630))
                                    .clickable {
                                        onSelectRoom(roomInfo)
                                        onDismiss()
                                    }
                                    .padding(horizontal = 12.dp, vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(
                                            text = "# ${roomInfo.name}",
                                            color = if (isSelected) Color(0xFF4E75FF) else Color.White,
                                            fontSize = 15.sp,
                                            fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium
                                        )
                                        if (hasBroadcaster) {
                                            Spacer(modifier = Modifier.width(8.dp))
                                            Box(
                                                modifier = Modifier
                                                    .clip(RoundedCornerShape(4.dp))
                                                    .background(Color(0xFFE53935))
                                                    .padding(horizontal = 6.dp, vertical = 2.dp)
                                            ) {
                                                Text(
                                                    text = "AO VIVO",
                                                    color = Color.White,
                                                    fontSize = 10.sp,
                                                    fontWeight = FontWeight.Bold
                                                )
                                            }
                                        }
                                    }
                                    Spacer(modifier = Modifier.height(2.dp))
                                    Text(
                                        text = "${roomInfo.participants.size} espectador(es)" +
                                                if (hasBroadcaster) " • ${roomInfo.broadcasters.size} transmitindo" else "",
                                        color = Color(0xFF8E95A5),
                                        fontSize = 12.sp
                                    )
                                }

                                if (isSelected) {
                                    Icon(
                                        imageVector = Icons.Default.Check,
                                        contentDescription = "Canal atual",
                                        tint = Color(0xFF4E75FF),
                                        modifier = Modifier.size(20.dp)
                                    )
                                }
                            }
                        }
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                // New room input
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    OutlinedTextField(
                        value = newChannelName,
                        onValueChange = { newChannelName = it },
                        placeholder = { Text("Nome da nova sala", color = Color(0xFF6B7280), fontSize = 13.sp) },
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedTextColor = Color.White,
                            unfocusedTextColor = Color.White,
                            focusedBorderColor = Color(0xFF4E75FF),
                            unfocusedBorderColor = Color(0xFF333842),
                            focusedContainerColor = Color(0xFF0D0F12),
                            unfocusedContainerColor = Color(0xFF0D0F12)
                        ),
                        modifier = Modifier
                            .weight(1f)
                            .height(52.dp)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Button(
                        onClick = {
                            if (newChannelName.isNotBlank() && !isCreating) {
                                isCreating = true
                                onCreateRoom(newChannelName.trim())
                            }
                        },
                        enabled = newChannelName.isNotBlank() && !isCreating,
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E5BFF)),
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.height(52.dp)
                    ) {
                        Text("Criar", color = Color.White)
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("Fechar", color = Color(0xFF8E95A5))
            }
        }
    )
}

@Composable
fun RenameDialog(
    currentName: String,
    onSave: suspend (String) -> String?,
    onUnpair: () -> Unit,
    onDismiss: () -> Unit
) {
    val scope = rememberCoroutineScope()
    var nameInput by remember { mutableStateOf(currentName) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var isSaving by remember { mutableStateOf(false) }
    var showUnpairConfirm by remember { mutableStateOf(false) }

    if (showUnpairConfirm) {
        AlertDialog(
            onDismissRequest = { showUnpairConfirm = false },
            containerColor = Color(0xFF161920),
            title = {
                Text(
                    text = "Desparear este tablet?",
                    color = Color.White,
                    fontWeight = FontWeight.Bold
                )
            },
            text = {
                Text(
                    text = "Seus dados de acesso serão removidos e você precisará importar o arquivo zoia-invite.json novamente.",
                    color = Color(0xFF8E95A5),
                    fontSize = 14.sp
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        showUnpairConfirm = false
                        onDismiss()
                        onUnpair()
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFE53935)),
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Text("Sim, desparear", color = Color.White)
                }
            },
            dismissButton = {
                TextButton(onClick = { showUnpairConfirm = false }) {
                    Text("Cancelar", color = Color(0xFF8E95A5))
                }
            }
        )
    }

    AlertDialog(
        onDismissRequest = { if (!isSaving) onDismiss() },
        containerColor = Color(0xFF161920),
        title = {
            Text(
                text = "Mudar Meu Nome",
                color = Color.White,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold
            )
        },
        text = {
            Column(modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = "Digite seu nome de exibição. Todos na transmissão verão esse nome ao invés do modelo do aparelho.",
                    color = Color(0xFF8E95A5),
                    fontSize = 14.sp
                )
                Spacer(modifier = Modifier.height(16.dp))
                OutlinedTextField(
                    value = nameInput,
                    onValueChange = {
                        nameInput = it
                        errorMessage = null
                    },
                    singleLine = true,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = Color.White,
                        unfocusedTextColor = Color.White,
                        focusedBorderColor = Color(0xFF4E75FF),
                        unfocusedBorderColor = Color(0xFF333842),
                        focusedContainerColor = Color(0xFF0D0F12),
                        unfocusedContainerColor = Color(0xFF0D0F12)
                    ),
                    modifier = Modifier.fillMaxWidth()
                )
                if (errorMessage != null) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = errorMessage!!,
                        color = Color(0xFFFF6B6B),
                        fontSize = 12.sp
                    )
                }

                Spacer(modifier = Modifier.height(24.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.Center
                ) {
                    TextButton(onClick = { showUnpairConfirm = true }) {
                        Text(
                            text = "Desparear este tablet (esquecer convite)",
                            color = Color(0xFFE53935),
                            fontSize = 13.sp
                        )
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val trimmed = nameInput.trim()
                    if (trimmed.isEmpty()) {
                        errorMessage = "O nome não pode estar em branco."
                        return@Button
                    }
                    if (trimmed.length > 32) {
                        errorMessage = "O nome deve ter no máximo 32 caracteres."
                        return@Button
                    }
                    isSaving = true
                    scope.launch {
                        val err = onSave(trimmed)
                        isSaving = false
                        if (err != null) {
                            errorMessage = err
                        } else {
                            onDismiss()
                        }
                    }
                },
                enabled = !isSaving && nameInput.isNotBlank(),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E5BFF)),
                shape = RoundedCornerShape(8.dp)
            ) {
                if (isSaving) {
                    CircularProgressIndicator(color = Color.White, modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                } else {
                    Text("Salvar", color = Color.White)
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !isSaving) {
                Text("Cancelar", color = Color(0xFF8E95A5))
            }
        }
    )
}

@Composable
fun StreamCard(
    stream: StreamItem,
    roomManager: LiveKitRoomManager,
    isAudioSelected: Boolean,
    onSelectAudio: () -> Unit
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(16f / 9f)
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0xFF000000))
            .border(
                width = if (isAudioSelected) 2.dp else 1.dp,
                color = if (isAudioSelected) Color(0xFF4E75FF) else Color(0xFF262A34),
                shape = RoundedCornerShape(12.dp)
            )
            .clickable { onSelectAudio() }
    ) {
        if (stream.videoTrack != null) {
            VideoTrackSurface(videoTrack = stream.videoTrack, roomManager = roomManager)
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
            Text(
                text = stream.participantName,
                color = Color.White,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium
            )

            Row(verticalAlignment = Alignment.CenterVertically) {
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
    AndroidView(
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
    )
}
