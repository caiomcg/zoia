package im.zoia.chat

import android.util.Log
import im.zoia.api.ZoiaApiClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class ChatManager(
    val apiClient: ZoiaApiClient,
    private val sseClient: ChatSseClient = ChatSseClient(apiClient),
    private val scope: CoroutineScope
) {
    private val _chats = MutableStateFlow<List<ChatChannel>>(emptyList())
    val chats: StateFlow<List<ChatChannel>> = _chats.asStateFlow()

    private val _chatAvailable = MutableStateFlow(true)
    val chatAvailable: StateFlow<Boolean> = _chatAvailable.asStateFlow()

    private val _activeChatId = MutableStateFlow<String?>(null)
    val activeChatId: StateFlow<String?> = _activeChatId.asStateFlow()

    private val _messages = MutableStateFlow<List<ChatMessage>>(emptyList())
    val messages: StateFlow<List<ChatMessage>> = _messages.asStateFlow()

    private val _authors = MutableStateFlow<Map<String, ChatAuthor>>(emptyMap())
    val authors: StateFlow<Map<String, ChatAuthor>> = _authors.asStateFlow()

    private val _readers = MutableStateFlow<Map<String, String>>(emptyMap())
    val readers: StateFlow<Map<String, String>> = _readers.asStateFlow()

    private val _people = MutableStateFlow<List<ChatPerson>>(emptyList())
    val people: StateFlow<List<ChatPerson>> = _people.asStateFlow()

    private val _replyingTo = MutableStateFlow<ChatMessage?>(null)
    val replyingTo: StateFlow<ChatMessage?> = _replyingTo.asStateFlow()

    private val _hasMore = MutableStateFlow(false)
    val hasMore: StateFlow<Boolean> = _hasMore.asStateFlow()

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _isLoadingOlder = MutableStateFlow(false)
    val isLoadingOlder: StateFlow<Boolean> = _isLoadingOlder.asStateFlow()

    val totalUnread: StateFlow<Int> = _chats.map { list ->
        list.sumOf { it.unread ?: 0 }
    }.stateIn(scope, SharingStarted.Eagerly, 0)

    val totalMentions: StateFlow<Int> = _chats.map { list ->
        list.sumOf { it.mentions ?: 0 }
    }.stateIn(scope, SharingStarted.Eagerly, 0)

    private var sseJob: Job? = null

    fun start() {
        if (sseJob != null) return
        refreshChats()
        refreshPeople()
        sseJob = scope.launch {
            try {
                sseClient.eventsFlow().collect { event ->
                    handleChatEvent(event)
                }
            } catch (_: CancellationException) {
                // Stopped normally
            } catch (_: Exception) {
                // Stream error handled in sseClient
            }
        }
    }

    fun stop() {
        sseJob?.cancel()
        sseJob = null
    }

    fun refreshChats() {
        scope.launch {
            try {
                val resp = apiClient.getChats()
                _chatAvailable.value = resp.available
                _chats.value = resp.chats

                // If no active chat is selected yet, select the default or first one
                if (_activeChatId.value == null && resp.chats.isNotEmpty()) {
                    val defaultChat = resp.chats.firstOrNull { it.isDefault } ?: resp.chats.first()
                    selectChat(defaultChat.id)
                }
            } catch (_: Exception) {
                // Offline or not available
            }
        }
    }

    fun refreshPeople() {
        scope.launch {
            try {
                val found = apiClient.getChatPeople()
                _people.value = found
            } catch (_: Exception) {
                // Ignore
            }
        }
    }

    fun selectChat(chatId: String) {
        if (_activeChatId.value == chatId && _messages.value.isNotEmpty()) return
        _activeChatId.value = chatId
        _replyingTo.value = null
        _messages.value = emptyList()
        _isLoading.value = true

        scope.launch {
            try {
                val resp = apiClient.getChatMessages(chatId)
                val sorted = resp.messages.sortedWith(compareBy({ it.timestamp }, { it.id }))
                _messages.value = sorted
                _hasMore.value = resp.hasMore
                _authors.update { it + resp.authors }
                _readers.value = resp.readers

                sorted.lastOrNull()?.let { newest ->
                    markRead(chatId, newest.id)
                }
            } catch (_: Exception) {
                // Ignore
            } finally {
                _isLoading.value = false
            }
        }
    }

    fun loadOlderMessages() {
        val chatId = _activeChatId.value ?: return
        if (!_hasMore.value || _isLoadingOlder.value || _messages.value.isEmpty()) return

        val oldestId = _messages.value.first().id
        _isLoadingOlder.value = true

        scope.launch {
            try {
                val resp = apiClient.getChatMessages(chatId, before = oldestId)
                val merged = (resp.messages + _messages.value)
                    .distinctBy { it.id }
                    .sortedWith(compareBy({ it.timestamp }, { it.id }))
                _messages.value = merged
                _hasMore.value = resp.hasMore
                _authors.update { it + resp.authors }
                _readers.update { it + resp.readers }
            } catch (_: Exception) {
                // Ignore
            } finally {
                _isLoadingOlder.value = false
            }
        }
    }

    fun setReplyingTo(message: ChatMessage?) {
        _replyingTo.value = message
    }

    suspend fun sendMessage(body: String): Boolean {
        val chatId = _activeChatId.value ?: return false
        val trimmed = body.trim()
        if (trimmed.isEmpty()) return false

        val replyToId = _replyingTo.value?.id
        _replyingTo.value = null

        val mentions = _people.value
            .filter { trimmed.contains("@${it.name}") }
            .map { it.id }

        return try {
            val resp = apiClient.sendChatMessage(chatId, trimmed, replyToId, mentions)
            Log.i("ChatManager", "Message sent: ${resp.message.id}")
            resp.author?.let { author ->
                _authors.update { it + (resp.message.authorId to author) }
            }
            _messages.update { current ->
                if (current.any { it.id == resp.message.id }) current
                else (current + resp.message).sortedWith(compareBy({ it.timestamp }, { it.id }))
            }
            true
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            Log.e("ChatManager", "Failed to send message", e)
            false
        }
    }

    suspend fun sendMedia(
        bytes: ByteArray,
        fileName: String,
        mimeType: String,
        caption: String = ""
    ): Boolean {
        val chatId = _activeChatId.value ?: return false
        val replyToId = _replyingTo.value?.id
        _replyingTo.value = null

        val mentions = _people.value
            .filter { caption.contains("@${it.name}") }
            .map { it.id }

        return try {
            val resp = apiClient.sendChatMedia(
                chatId = chatId,
                bytes = bytes,
                fileName = fileName,
                mimeType = mimeType,
                caption = caption,
                replyTo = replyToId,
                mentions = mentions
            )
            resp.author?.let { author ->
                _authors.update { it + (resp.message.authorId to author) }
            }
            _messages.update { current ->
                if (current.any { it.id == resp.message.id }) current
                else (current + resp.message).sortedWith(compareBy({ it.timestamp }, { it.id }))
            }
            true
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            Log.e("ChatManager", "Failed to send media", e)
            false
        }
    }

    suspend fun toggleReaction(messageId: String, emoji: String, myAccountId: String) {
        val chatId = _activeChatId.value ?: return
        val msg = _messages.value.find { it.id == messageId } ?: return
        val currentlyOn = msg.reactions.any { it.emoji == emoji && it.accountIds.contains(myAccountId) }

        try {
            apiClient.reactChatMessage(chatId, messageId, emoji, on = !currentlyOn)
        } catch (_: Exception) {
            // Refused or failed
        }
    }

    suspend fun deleteMessage(messageId: String) {
        val chatId = _activeChatId.value ?: return
        try {
            apiClient.deleteChatMessage(chatId, messageId)
            _messages.update { list -> list.filterNot { it.id == messageId } }
        } catch (_: Exception) {
            // Failed
        }
    }

    suspend fun editMessage(messageId: String, newBody: String) {
        val chatId = _activeChatId.value ?: return
        val mentions = _people.value
            .filter { newBody.contains("@${it.name}") }
            .map { it.id }

        try {
            val resp = apiClient.editChatMessage(chatId, messageId, newBody, mentions)
            _messages.update { list ->
                list.map { if (it.id == messageId) resp.message else it }
            }
        } catch (_: Exception) {
            // Failed
        }
    }

    private fun markRead(chatId: String, messageId: String) {
        scope.launch {
            try {
                apiClient.markChatRead(chatId, messageId)
                _chats.update { list ->
                    list.map { if (it.id == chatId) it.copy(unread = 0, mentions = 0) else it }
                }
            } catch (_: Exception) {
                // Ignore
            }
        }
    }

    private fun handleChatEvent(event: ChatEvent) {
        when (event) {
            is ChatEvent.ChatsUpdated -> refreshChats()
            is ChatEvent.PeopleUpdated -> refreshPeople()
            is ChatEvent.NewMessage -> {
                event.author?.let { author ->
                    _authors.update { it + (event.message.authorId to author) }
                }
                if (event.message.chatId == _activeChatId.value) {
                    _messages.update { current ->
                        if (current.any { it.id == event.message.id }) current
                        else (current + event.message).sortedWith(compareBy({ it.timestamp }, { it.id }))
                    }
                    markRead(event.message.chatId, event.message.id)
                } else {
                    _chats.update { list ->
                        list.map { chat ->
                            if (chat.id == event.message.chatId) {
                                chat.copy(unread = (chat.unread ?: 0) + 1)
                            } else chat
                        }
                    }
                }
            }
            is ChatEvent.MessageEdited -> {
                if (event.chatId == _activeChatId.value) {
                    _messages.update { list ->
                        list.map { if (it.id == event.message.id) event.message else it }
                    }
                }
            }
            is ChatEvent.MessageDeleted -> {
                if (event.chatId == _activeChatId.value) {
                    _messages.update { list -> list.filterNot { it.id == event.messageId } }
                }
            }
            is ChatEvent.ReactionChanged -> {
                event.reactor?.let { reactor ->
                    _authors.update { it + (event.accountId to reactor) }
                }
                if (event.chatId == _activeChatId.value) {
                    _messages.update { list ->
                        list.map { msg ->
                            if (msg.id != event.messageId) msg
                            else {
                                val updatedReactions = msg.reactions.map { rx ->
                                    if (rx.emoji == event.emoji) {
                                        val ids = if (event.on) {
                                            if (rx.accountIds.contains(event.accountId)) rx.accountIds
                                            else rx.accountIds + event.accountId
                                        } else {
                                            rx.accountIds - event.accountId
                                        }
                                        rx.copy(accountIds = ids)
                                    } else rx
                                }.filter { it.accountIds.isNotEmpty() }.toMutableList()

                                if (event.on && updatedReactions.none { it.emoji == event.emoji }) {
                                    updatedReactions.add(ChatReaction(event.emoji, listOf(event.accountId)))
                                }
                                msg.copy(reactions = updatedReactions)
                            }
                        }
                    }
                }
            }
            is ChatEvent.MessageRead -> {
                event.reader?.let { reader ->
                    _authors.update { it + (event.accountId to reader) }
                }
                if (event.chatId == _activeChatId.value) {
                    _readers.update { it + (event.accountId to event.messageId) }
                }
            }
        }
    }
}
