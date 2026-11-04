package im.zoia.ui.chat

import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AddReaction
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import coil.compose.AsyncImage
import coil.request.ImageRequest
import im.zoia.chat.ChatAttachment
import im.zoia.chat.ChatAuthor
import im.zoia.chat.ChatManager
import im.zoia.chat.ChatMessage
import im.zoia.chat.ChatReaction
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val QUICK_REACTIONS = listOf("👍", "❤️", "😂", "😮", "😢", "🎉", "🔥", "👀")

@Composable
fun ChatPanel(
    chatManager: ChatManager,
    myAccountId: String,
    myRole: String,
    onClose: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val chats by chatManager.chats.collectAsState()
    val activeChatId by chatManager.activeChatId.collectAsState()
    val messages by chatManager.messages.collectAsState()
    val authors by chatManager.authors.collectAsState()
    val replyingTo by chatManager.replyingTo.collectAsState()
    val hasMore by chatManager.hasMore.collectAsState()
    val isLoading by chatManager.isLoading.collectAsState()
    val isLoadingOlder by chatManager.isLoadingOlder.collectAsState()
    val isChatAvailable by chatManager.chatAvailable.collectAsState()

    var textInput by remember { mutableStateOf("") }
    var showChannelDropdown by remember { mutableStateOf(false) }
    var selectedMediaUrl by remember { mutableStateOf<String?>(null) }
    val listState = rememberLazyListState()

    val currentChat = chats.find { it.id == activeChatId }
    val baseUrl = chatManager.apiClient.serverUrl ?: ""

    // Native Photo / Video Picker
    val mediaPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia()
    ) { uri: Uri? ->
        if (uri != null) {
            scope.launch {
                try {
                    val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                    if (bytes != null) {
                        val mimeType = context.contentResolver.getType(uri) ?: "image/jpeg"
                        var fileName = "attachment"
                        context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                            val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            if (nameIdx >= 0 && cursor.moveToFirst()) {
                                fileName = cursor.getString(nameIdx)
                            }
                        }
                        val caption = textInput.trim()
                        textInput = ""
                        chatManager.sendMedia(bytes, fileName, mimeType, caption)
                    }
                } catch (_: Exception) {
                    // Ignore failure
                }
            }
        }
    }

    // Auto-scroll to bottom on new messages
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) {
            val lastIndex = messages.size - 1 + (if (hasMore) 1 else 0)
            listState.animateScrollToItem(lastIndex)
        }
    }

    Column(
        modifier = modifier
            .border(width = 1.dp, color = Color(0xFF222630))
    ) {
        // --- Channel Header ---
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp)
                .background(Color(0xFF1B1E26))
                .padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Box {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .clickable { showChannelDropdown = true }
                        .padding(horizontal = 8.dp, vertical = 4.dp)
                ) {
                    Text(
                        text = "# ${currentChat?.name ?: "chat"}",
                        color = Color.White,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold
                    )
                    if (chats.size > 1) {
                        Spacer(modifier = Modifier.width(4.dp))
                        Icon(
                            imageVector = Icons.Default.ArrowDropDown,
                            contentDescription = "Selecionar canal de texto",
                            tint = Color(0xFF8E95A5),
                            modifier = Modifier.size(18.dp)
                        )
                    }
                }

                if (chats.size > 1) {
                    DropdownMenu(
                        expanded = showChannelDropdown,
                        onDismissRequest = { showChannelDropdown = false }
                    ) {
                        chats.forEach { chat ->
                            DropdownMenuItem(
                                text = {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(
                                            text = "# ${chat.name}",
                                            fontWeight = if (chat.id == activeChatId) FontWeight.Bold else FontWeight.Normal
                                        )
                                        if ((chat.unread ?: 0) > 0) {
                                            Spacer(modifier = Modifier.width(8.dp))
                                            Box(
                                                modifier = Modifier
                                                    .clip(CircleShape)
                                                    .background(Color(0xFF4E75FF))
                                                    .padding(horizontal = 6.dp, vertical = 2.dp)
                                            ) {
                                                Text(
                                                    text = "${chat.unread}",
                                                    color = Color.White,
                                                    fontSize = 11.sp
                                                )
                                            }
                                        }
                                    }
                                },
                                onClick = {
                                    showChannelDropdown = false
                                    chatManager.selectChat(chat.id)
                                }
                            )
                        }
                    }
                }
            }

            IconButton(onClick = onClose) {
                Icon(
                    imageVector = Icons.Default.Close,
                    contentDescription = "Fechar chat",
                    tint = Color(0xFF8E95A5),
                    modifier = Modifier.size(20.dp)
                )
            }
        }

        // --- Content Area ---
        if (!isChatAvailable) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .weight(1f)
                    .padding(24.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "O chat está temporariamente indisponível no servidor.",
                    color = Color(0xFF8E95A5),
                    fontSize = 14.sp
                )
            }
        } else {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
            ) {
                if (isLoading) {
                    Box(
                        modifier = Modifier.fillMaxSize(),
                        contentAlignment = Alignment.Center
                    ) {
                        CircularProgressIndicator(
                            color = Color(0xFF4E75FF),
                            modifier = Modifier.size(28.dp)
                        )
                    }
                } else {
                    LazyColumn(
                        state = listState,
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(horizontal = 12.dp, vertical = 8.dp)
                    ) {
                        if (hasMore) {
                            item(key = "load_older_button") {
                                Box(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 8.dp),
                                    contentAlignment = Alignment.Center
                                ) {
                                    if (isLoadingOlder) {
                                        CircularProgressIndicator(
                                            color = Color(0xFF4E75FF),
                                            modifier = Modifier.size(20.dp)
                                        )
                                    } else {
                                        TextButton(onClick = { chatManager.loadOlderMessages() }) {
                                            Text(
                                                text = "Carregar mensagens anteriores",
                                                color = Color(0xFF4E75FF),
                                                fontSize = 13.sp
                                            )
                                        }
                                    }
                                }
                            }
                        }

                        items(messages, key = { it.id }) { message ->
                            val author = authors[message.authorId]
                            ChatMessageItem(
                                message = message,
                                author = author,
                                baseUrl = baseUrl,
                                myAccountId = myAccountId,
                                myRole = myRole,
                                onReply = { chatManager.setReplyingTo(message) },
                                onDelete = { scope.launch { chatManager.deleteMessage(message.id) } },
                                onToggleReaction = { emoji ->
                                    scope.launch {
                                        chatManager.toggleReaction(message.id, emoji, myAccountId)
                                    }
                                },
                                onImageClick = { mediaUrl -> selectedMediaUrl = mediaUrl }
                            )
                            Spacer(modifier = Modifier.height(10.dp))
                        }
                    }
                }
            }

            // --- Reply Preview Bar ---
            replyingTo?.let { replyMsg ->
                val replyAuthor = authors[replyMsg.authorId]?.name ?: "Usuário"
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0xFF222630))
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Row(
                        modifier = Modifier.weight(1f),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.Reply,
                            contentDescription = null,
                            tint = Color(0xFF4E75FF),
                            modifier = Modifier.size(16.dp)
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(
                            text = "Respondendo a $replyAuthor: ${replyMsg.body.take(40)}",
                            color = Color(0xFFB0B7C3),
                            fontSize = 12.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                    IconButton(
                        onClick = { chatManager.setReplyingTo(null) },
                        modifier = Modifier.size(20.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.Close,
                            contentDescription = "Cancelar resposta",
                            tint = Color(0xFF8E95A5),
                            modifier = Modifier.size(16.dp)
                        )
                    }
                }
            }

            // --- Composer Input Bar ---
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFF1B1E26))
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Attach file / photo button
                IconButton(
                    onClick = {
                        mediaPickerLauncher.launch(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)
                        )
                    },
                    modifier = Modifier.size(36.dp)
                ) {
                    Icon(
                        imageVector = Icons.Default.AttachFile,
                        contentDescription = "Enviar foto ou vídeo",
                        tint = Color(0xFF8E95A5),
                        modifier = Modifier.size(20.dp)
                    )
                }

                Spacer(modifier = Modifier.width(6.dp))

                // Text Field
                OutlinedTextField(
                    value = textInput,
                    onValueChange = { textInput = it },
                    placeholder = {
                        Text(
                            text = "Mensagem #${currentChat?.name ?: ""}",
                            color = Color(0xFF5F6675),
                            fontSize = 14.sp
                        )
                    },
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = 40.dp, max = 120.dp),
                    shape = RoundedCornerShape(20.dp),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = Color(0xFF4E75FF),
                        unfocusedBorderColor = Color(0xFF2A2E39),
                        focusedContainerColor = Color(0xFF12141A),
                        unfocusedContainerColor = Color(0xFF12141A),
                        focusedTextColor = Color.White,
                        unfocusedTextColor = Color.White,
                        cursorColor = Color(0xFF4E75FF)
                    ),
                    maxLines = 4,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = {
                        val body = textInput.trim()
                        if (body.isNotEmpty()) {
                            textInput = ""
                            scope.launch { chatManager.sendMessage(body) }
                        }
                    })
                )

                Spacer(modifier = Modifier.width(6.dp))

                // Send button
                IconButton(
                    onClick = {
                        val body = textInput.trim()
                        if (body.isNotEmpty()) {
                            textInput = ""
                            scope.launch { chatManager.sendMessage(body) }
                        }
                    },
                    enabled = textInput.trim().isNotEmpty(),
                    modifier = Modifier.size(36.dp)
                ) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.Send,
                        contentDescription = "Enviar mensagem",
                        tint = if (textInput.trim().isNotEmpty()) Color(0xFF4E75FF) else Color(0xFF474C59),
                        modifier = Modifier.size(20.dp)
                    )
                }
            }
        }
    }

    // --- Media Viewer Dialog ---
    selectedMediaUrl?.let { mediaUrl ->
        Dialog(onDismissRequest = { selectedMediaUrl = null }) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.9f))
                    .clickable { selectedMediaUrl = null },
                contentAlignment = Alignment.Center
            ) {
                AsyncImage(
                    model = ImageRequest.Builder(context)
                        .data(mediaUrl)
                        .crossfade(true)
                        .build(),
                    contentDescription = "Visualização da mídia",
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp)
                )

                IconButton(
                    onClick = { selectedMediaUrl = null },
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(16.dp)
                ) {
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = "Fechar imagem",
                        tint = Color.White,
                        modifier = Modifier.size(28.dp)
                    )
                }
            }
        }
    }
}

@Composable
private fun ChatMessageItem(
    message: ChatMessage,
    author: ChatAuthor?,
    baseUrl: String,
    myAccountId: String,
    myRole: String,
    onReply: () -> Unit,
    onDelete: () -> Unit,
    onToggleReaction: (String) -> Unit,
    onImageClick: (String) -> Unit
) {
    val context = LocalContext.current
    var showMenu by remember { mutableStateOf(false) }
    var showReactionPicker by remember { mutableStateOf(false) }

    val isMine = message.authorId == myAccountId
    val canDelete = isMine || myRole == "admin" || myRole == "super_admin"

    val authorName = author?.name ?: "Usuário"
    val timeFormatted = remember(message.createdAt) { formatMessageTime(message.createdAt) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(Color(0xFF14171E))
            .padding(10.dp)
    ) {
        // Avatar
        Box(
            modifier = Modifier
                .size(36.dp)
                .clip(CircleShape)
                .background(Color(0xFF2A2E3A)),
            contentAlignment = Alignment.Center
        ) {
            if (author?.avatar != null) {
                AsyncImage(
                    model = ImageRequest.Builder(context)
                        .data("$baseUrl/api/avatar/${author.avatar}")
                        .crossfade(true)
                        .build(),
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize()
                )
            } else {
                Text(
                    text = authorName.take(1).uppercase(),
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 15.sp
                )
            }
        }

        Spacer(modifier = Modifier.width(10.dp))

        // Body Content
        Column(modifier = Modifier.weight(1f)) {
            // Author + Time Header
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = authorName,
                        color = if (author?.bot == true) Color(0xFF00D2D3) else Color(0xFFE4E7EB),
                        fontWeight = FontWeight.Bold,
                        fontSize = 13.sp
                    )
                    if (author?.bot == true) {
                        Spacer(modifier = Modifier.width(4.dp))
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(4.dp))
                                .background(Color(0xFF00D2D3).copy(alpha = 0.2f))
                                .padding(horizontal = 4.dp, vertical = 1.dp)
                        ) {
                            Text(text = "BOT", color = Color(0xFF00D2D3), fontSize = 9.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = timeFormatted,
                        color = Color(0xFF5F6675),
                        fontSize = 11.sp
                    )
                    if (message.editedAt != null) {
                        Spacer(modifier = Modifier.width(4.dp))
                        Text(
                            text = "(editado)",
                            color = Color(0xFF5F6675),
                            fontSize = 10.sp
                        )
                    }
                }

                // Message Actions
                Box {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconButton(
                            onClick = { showReactionPicker = true },
                            modifier = Modifier.size(24.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.AddReaction,
                                contentDescription = "Reagir",
                                tint = Color(0xFF5F6675),
                                modifier = Modifier.size(16.dp)
                            )
                        }
                        IconButton(
                            onClick = onReply,
                            modifier = Modifier.size(24.dp)
                        ) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.Reply,
                                contentDescription = "Responder",
                                tint = Color(0xFF5F6675),
                                modifier = Modifier.size(16.dp)
                            )
                        }
                        if (canDelete) {
                            IconButton(
                                onClick = onDelete,
                                modifier = Modifier.size(24.dp)
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Delete,
                                    contentDescription = "Apagar mensagem",
                                    tint = Color(0xFF5F6675),
                                    modifier = Modifier.size(16.dp)
                                )
                            }
                        }
                    }

                    // Quick Reaction Dropdown
                    DropdownMenu(
                        expanded = showReactionPicker,
                        onDismissRequest = { showReactionPicker = false }
                    ) {
                        Row(modifier = Modifier.padding(6.dp)) {
                            QUICK_REACTIONS.forEach { emoji ->
                                Text(
                                    text = emoji,
                                    fontSize = 20.sp,
                                    modifier = Modifier
                                        .clip(RoundedCornerShape(4.dp))
                                        .clickable {
                                            showReactionPicker = false
                                            onToggleReaction(emoji)
                                        }
                                        .padding(horizontal = 6.dp, vertical = 2.dp)
                                )
                            }
                        }
                    }
                }
            }

            // Reply Quote Snippet (if message is replying to another)
            message.replyTo?.let { reply ->
                Spacer(modifier = Modifier.height(4.dp))
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(4.dp))
                        .background(Color(0xFF1E222B))
                        .border(width = 2.dp, color = Color(0xFF4E75FF).copy(alpha = 0.6f), shape = RoundedCornerShape(4.dp))
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = if (reply.deleted) "Mensagem apagada" else "${reply.authorName ?: "Usuário"}: ${reply.snippet ?: ""}",
                        color = Color(0xFF8E95A5),
                        fontSize = 11.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }

            // Attachment
            message.attachment?.let { attachment ->
                Spacer(modifier = Modifier.height(6.dp))
                if (attachment.kind == "image") {
                    val mediaUrl = "$baseUrl/api/chats/${message.chatId}/media/${attachment.id}"
                    AsyncImage(
                        model = ImageRequest.Builder(context)
                            .data(mediaUrl)
                            .crossfade(true)
                            .build(),
                        contentDescription = attachment.name ?: "Imagem anexada",
                        contentScale = ContentScale.Fit,
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 220.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .border(width = 1.dp, color = Color(0xFF2E3340), shape = RoundedCornerShape(8.dp))
                            .clickable { onImageClick(mediaUrl) }
                    )
                } else {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(6.dp))
                            .background(Color(0xFF1E222B))
                            .padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            imageVector = Icons.Default.Videocam,
                            contentDescription = null,
                            tint = Color(0xFF4E75FF),
                            modifier = Modifier.size(24.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = attachment.name ?: "Vídeo",
                            color = Color.White,
                            fontSize = 12.sp
                        )
                    }
                }
            }

            // Text Body
            if (message.body.isNotEmpty()) {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = renderMentions(message.body),
                    color = Color(0xFFD6DAE0),
                    fontSize = 14.sp
                )
            }

            // Reactions Row
            if (message.reactions.isNotEmpty()) {
                Spacer(modifier = Modifier.height(6.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    message.reactions.forEach { rx ->
                        val isMyReaction = rx.accountIds.contains(myAccountId)
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(12.dp))
                                .background(if (isMyReaction) Color(0xFF283655) else Color(0xFF1D212A))
                                .border(
                                    width = 1.dp,
                                    color = if (isMyReaction) Color(0xFF4E75FF) else Color(0xFF2E3340),
                                    shape = RoundedCornerShape(12.dp)
                                )
                                .clickable { onToggleReaction(rx.emoji) }
                                .padding(horizontal = 7.dp, vertical = 2.dp)
                        ) {
                            Text(
                                text = "${rx.emoji} ${rx.accountIds.size}",
                                color = if (isMyReaction) Color.White else Color(0xFFB0B7C3),
                                fontSize = 11.sp
                            )
                        }
                    }
                }
            }
        }
    }
}

private fun renderMentions(text: String): androidx.compose.ui.text.AnnotatedString {
    return buildAnnotatedString {
        val parts = text.split(" ")
        parts.forEachIndexed { index, part ->
            if (part.startsWith("@") && part.length > 1) {
                withStyle(SpanStyle(color = Color(0xFF4E75FF), fontWeight = FontWeight.Bold)) {
                    append(part)
                }
            } else {
                append(part)
            }
            if (index < parts.size - 1) append(" ")
        }
    }
}

private fun formatMessageTime(createdAt: String): String {
    return try {
        val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)
        val date = isoFormat.parse(createdAt.take(19)) ?: return ""
        val displayFormat = SimpleDateFormat("HH:mm", Locale.getDefault())
        displayFormat.format(date)
    } catch (_: Exception) {
        ""
    }
}
