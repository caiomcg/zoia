package im.zoia.chat

import kotlinx.serialization.Serializable

@Serializable
data class ChatChannel(
    val id: String,
    val name: String,
    val isDefault: Boolean = false,
    val unread: Int? = null,
    val mentions: Int? = null
)

@Serializable
data class ChatListResponse(
    val chats: List<ChatChannel> = emptyList(),
    val max: Int = 10,
    val ceiling: Int = 50,
    val available: Boolean = false
)

@Serializable
data class ChatAuthor(
    val name: String,
    val avatar: String? = null,
    val bot: Boolean = false
)

@Serializable
data class ChatPerson(
    val id: String,
    val name: String,
    val avatar: String? = null,
    val role: String = "user",
    val bot: Boolean = false
)

@Serializable
data class ChatPeopleResponse(
    val people: List<ChatPerson> = emptyList()
)

@Serializable
data class ChatAttachment(
    val id: String,
    val name: String? = null,
    val kind: String = "image",
    val size: Long = 0,
    val type: String? = null
)

@Serializable
data class ChatReply(
    val id: String,
    val authorId: String,
    val authorName: String? = null,
    val snippet: String? = null,
    val deleted: Boolean = false
)

@Serializable
data class ChatMention(
    val id: String,
    val name: String
)

@Serializable
data class ChatReaction(
    val emoji: String,
    val accountIds: List<String> = emptyList()
)

@Serializable
data class ChatMessage(
    val id: String,
    val chatId: String,
    val authorId: String,
    val body: String = "",
    val sentAt: String = "",
    val createdAt: String = "",
    val attachment: ChatAttachment? = null,
    val replyTo: ChatReply? = null,
    val mentions: List<ChatMention> = emptyList(),
    val reactions: List<ChatReaction> = emptyList(),
    val editedAt: String? = null
) {
    val timestamp: String get() = sentAt.ifEmpty { createdAt }
}

@Serializable
data class ChatMessagesResponse(
    val messages: List<ChatMessage> = emptyList(),
    val hasMore: Boolean = false,
    val authors: Map<String, ChatAuthor> = emptyMap(),
    val readers: Map<String, String> = emptyMap()
)

@Serializable
data class SendMessageRequest(
    val body: String,
    val replyTo: String? = null,
    val mentions: List<String> = emptyList()
)

@Serializable
data class SendMessageResponse(
    val message: ChatMessage,
    val author: ChatAuthor? = null
)

@Serializable
data class EditMessageRequest(
    val body: String,
    val mentions: List<String> = emptyList()
)

@Serializable
data class EditMessageResponse(
    val message: ChatMessage
)

@Serializable
data class MarkReadRequest(
    val messageId: String
)

sealed interface ChatEvent {
    object ChatsUpdated : ChatEvent
    object PeopleUpdated : ChatEvent
    data class NewMessage(val message: ChatMessage, val author: ChatAuthor?) : ChatEvent
    data class MessageEdited(val chatId: String, val message: ChatMessage) : ChatEvent
    data class MessageDeleted(val chatId: String, val messageId: String) : ChatEvent
    data class ReactionChanged(
        val chatId: String,
        val messageId: String,
        val emoji: String,
        val accountId: String,
        val on: Boolean,
        val reactor: ChatAuthor?
    ) : ChatEvent
    data class MessageRead(
        val chatId: String,
        val accountId: String,
        val messageId: String,
        val reader: ChatAuthor?
    ) : ChatEvent
}
