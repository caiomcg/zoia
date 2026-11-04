package im.zoia.chat

import im.zoia.api.ZoiaApiClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Request
import java.io.BufferedReader
import java.io.InputStreamReader

class ChatSseClient(
    private val apiClient: ZoiaApiClient,
    private val json: Json = Json { ignoreUnknownKeys = true }
) {
    fun eventsFlow(): Flow<ChatEvent> = flow {
        while (currentCoroutineContext().isActive) {
            val serverUrl = apiClient.serverUrl
            if (serverUrl == null) {
                delay(3000)
                continue
            }

            val request = Request.Builder()
                .url("$serverUrl/api/chats/events")
                .header("Accept", "text/event-stream")
                .header("Cache-Control", "no-cache")
                .build()

            var call: okhttp3.Call? = null
            try {
                call = apiClient.httpClient.newCall(request)
                val response = call.execute()
                if (!response.isSuccessful) {
                    response.close()
                    delay(3000)
                    continue
                }

                val body = response.body
                if (body == null) {
                    response.close()
                    delay(3000)
                    continue
                }

                val reader = BufferedReader(InputStreamReader(body.byteStream(), Charsets.UTF_8))
                var currentEvent = "message"
                val currentData = StringBuilder()

                while (currentCoroutineContext().isActive) {
                    val line = reader.readLine() ?: break
                    if (line.startsWith(":")) {
                        // Heartbeat or server comment, ignore
                        continue
                    }
                    if (line.isEmpty()) {
                        if (currentData.isNotEmpty()) {
                            parseEvent(currentEvent, currentData.toString())?.let { event ->
                                emit(event)
                            }
                            currentData.setLength(0)
                        }
                        currentEvent = "message"
                        continue
                    }
                    if (line.startsWith("event:")) {
                        currentEvent = line.substringAfter("event:").trim()
                    } else if (line.startsWith("data:")) {
                        val d = line.substringAfter("data:").trimStart()
                        if (currentData.isNotEmpty()) currentData.append("\n")
                        currentData.append(d)
                    }
                }
                body.close()
                response.close()
            } catch (e: CancellationException) {
                call?.cancel()
                throw e
            } catch (_: Exception) {
                // Connection interrupted or network failure; retry after delay
            }

            if (currentCoroutineContext().isActive) {
                delay(2500)
            }
        }
    }.flowOn(Dispatchers.IO)

    private fun parseEvent(event: String, data: String): ChatEvent? {
        return try {
            when (event) {
                "chats" -> ChatEvent.ChatsUpdated
                "people" -> ChatEvent.PeopleUpdated
                "message" -> {
                    val parsed = json.decodeFromString<SendMessageResponse>(data)
                    ChatEvent.NewMessage(parsed.message, parsed.author)
                }
                "edited" -> {
                    val obj = json.parseToJsonElement(data).jsonObject
                    val chatId = obj["chatId"]?.jsonPrimitive?.content ?: return null
                    val msgElem = obj["message"] ?: return null
                    val message = json.decodeFromJsonElement(ChatMessage.serializer(), msgElem)
                    ChatEvent.MessageEdited(chatId, message)
                }
                "deleted" -> {
                    val obj = json.parseToJsonElement(data).jsonObject
                    val chatId = obj["chatId"]?.jsonPrimitive?.content ?: return null
                    val messageId = obj["messageId"]?.jsonPrimitive?.content ?: return null
                    ChatEvent.MessageDeleted(chatId, messageId)
                }
                "reaction" -> {
                    val obj = json.parseToJsonElement(data).jsonObject
                    val chatId = obj["chatId"]?.jsonPrimitive?.content ?: return null
                    val messageId = obj["messageId"]?.jsonPrimitive?.content ?: return null
                    val emoji = obj["emoji"]?.jsonPrimitive?.content ?: return null
                    val accountId = obj["accountId"]?.jsonPrimitive?.content ?: return null
                    val on = obj["on"]?.jsonPrimitive?.booleanOrNull ?: true
                    val reactorElem = obj["reactor"]
                    val reactor = reactorElem?.let { json.decodeFromJsonElement(ChatAuthor.serializer(), it) }
                    ChatEvent.ReactionChanged(chatId, messageId, emoji, accountId, on, reactor)
                }
                "read" -> {
                    val obj = json.parseToJsonElement(data).jsonObject
                    val chatId = obj["chatId"]?.jsonPrimitive?.content ?: return null
                    val accountId = obj["accountId"]?.jsonPrimitive?.content ?: return null
                    val messageId = obj["messageId"]?.jsonPrimitive?.content ?: return null
                    val readerElem = obj["reader"]
                    val reader = readerElem?.let { json.decodeFromJsonElement(ChatAuthor.serializer(), it) }
                    ChatEvent.MessageRead(chatId, accountId, messageId, reader)
                }
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }
}
