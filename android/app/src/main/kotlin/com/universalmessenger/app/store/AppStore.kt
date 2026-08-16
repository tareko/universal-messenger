package com.universalmessenger.app.store

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.universalmessenger.app.data.Api
import com.universalmessenger.app.data.Chat
import com.universalmessenger.app.data.Message
import com.universalmessenger.app.realtime.SseClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.decodeFromJsonElement

data class AppState(
    val serverUrl: String = "",
    val token: String? = null,
    val configured: Boolean = false,
    val connected: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
    val chats: List<Chat> = emptyList(),
    val selectedChatId: String? = null,
    val messages: List<Message> = emptyList(),
    val draft: String = "",
    val sending: Boolean = false,
    val typingChatIds: Set<String> = emptySet(),
) {
    val selectedChat: Chat? get() = chats.find { it.id == selectedChatId }
}

class AppStore(app: Application) : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences("um", Application.MODE_PRIVATE)
    private val _state = MutableStateFlow(
        AppState(
            serverUrl = prefs.getString("serverUrl", null).orEmpty(),
            token = prefs.getString("token", null),
            configured = prefs.getBoolean("configured", false),
        )
    )
    val state: StateFlow<AppState> = _state

    val api: Api = Api(_state.value.serverUrl, _state.value.token)
    private val sse = SseClient(viewModelScope, api)

    init {
        sse.onEvent = ::onSseEvent
        sse.onStateChange = { connected -> _state.update { it.copy(connected = connected) } }
        if (_state.value.configured) bootstrap()
    }

    fun saveConnection(url: String, token: String?) {
        prefs.edit()
            .putString("serverUrl", url.trim())
            .putString("token", token?.trim()?.ifBlank { null })
            .putBoolean("configured", true)
            .apply()
        api.baseUrl = url.trim()
        api.token = token?.trim()?.ifBlank { null }
        _state.update { it.copy(serverUrl = url.trim(), token = api.token, configured = true, error = null) }
        bootstrap()
    }

    fun bootstrap() {
        refreshChats()
        sse.updateApi(api)
        sse.start()
    }

    fun refreshChats() {
        viewModelScope.launch {
            _state.update { it.copy(loading = it.chats.isEmpty()) }
            runCatching { api.chats() }
                .onSuccess { chats -> _state.update { it.copy(chats = chats, loading = false, error = null) } }
                .onFailure { e -> _state.update { it.copy(loading = false, error = e.message) } }
        }
    }

    fun openChat(chatId: String) {
        _state.update { it.copy(selectedChatId = chatId, messages = emptyList(), error = null) }
        viewModelScope.launch {
            runCatching { api.messages(chatId) }
                .onSuccess { msgs -> _state.update { s ->
                    if (s.selectedChatId == chatId) s.copy(messages = msgs) else s
                } }
                .onFailure { e -> _state.update { it.copy(error = e.message) } }
            runCatching { api.markRead(chatId) }
                .onSuccess {
                    _state.update { s -> s.copy(chats = s.chats.map { if (it.id == chatId) it.copy(unread = 0) else it }) }
                }
        }
    }

    fun closeChat() {
        _state.update { it.copy(selectedChatId = null, messages = emptyList()) }
    }

    fun setDraft(text: String) {
        _state.update { it.copy(draft = text) }
    }

    fun sendMessage() {
        val text = _state.value.draft.trim()
        val chatId = _state.value.selectedChatId ?: return
        if (text.isEmpty()) return
        val tempId = "local-${System.nanoTime()}"
        val optimistic = Message(
            id = tempId, chatId = chatId, accountId = "", ts = System.currentTimeMillis(),
            outgoing = 1, body = text, receipt = "pending",
        )
        _state.update { it.copy(draft = "", sending = true, messages = it.messages + optimistic) }
        viewModelScope.launch {
            runCatching { api.send(chatId, text) }
                .onSuccess { sent ->
                    _state.update { s ->
                        s.copy(
                            sending = false,
                            messages = s.messages.map { if (it.id == tempId) sent else it },
                        )
                    }
                }
                .onFailure { e ->
                    _state.update { s ->
                        s.copy(
                            sending = false,
                            error = e.message,
                            messages = s.messages.filterNot { it.id == tempId },
                            draft = text,
                        )
                    }
                }
        }
    }

    private fun onSseEvent(type: String, data: kotlinx.serialization.json.JsonObject?) {
        when (type) {
            "message" -> {
                val msg = data?.let { runCatching { api.json.decodeFromJsonElement<Message>(it) }.getOrNull() } ?: return
                _state.update { s ->
                    val open = s.selectedChatId != null && s.selectedChatId == msg.chatId
                    val messages = if (open) s.messages.filterNot { it.id == msg.id } + msg else s.messages
                    val chats = s.chats.map {
                        if (it.id == msg.chatId) it.copy(ts = msg.ts, lastMessage = msg, unread = if (open) it.unread else it.unread + 1) else it
                    }
                    s.copy(messages = messages, chats = chats)
                }
                val open = _state.value.selectedChatId == msg.chatId
                if (open && msg.outgoing == 0) viewModelScope.launch { runCatching { api.markRead(msg.chatId) } }
            }
            "message-updated" -> {
                val msg = data?.let { runCatching { api.json.decodeFromJsonElement<Message>(it) }.getOrNull() } ?: return
                _state.update { s ->
                    if (s.selectedChatId == msg.chatId && s.messages.any { it.id == msg.id }) {
                        s.copy(messages = s.messages.map { if (it.id == msg.id) msg else it })
                    } else s
                }
            }
            "message-deleted" -> {
                val id = data?.get("id")?.toString()?.trim('"') ?: return
                _state.update { s -> s.copy(messages = s.messages.filterNot { it.id == id }) }
            }
            "chats-updated", "contacts-refreshed", "accounts" -> refreshChats()
            "typing" -> {
                val chatId = data?.get("chatId")?.toString()?.trim('"') ?: return
                _state.update { it.copy(typingChatIds = it.typingChatIds + chatId) }
                viewModelScope.launch {
                    kotlinx.coroutines.delay(6000)
                    _state.update { it.copy(typingChatIds = it.typingChatIds - chatId) }
                }
            }
        }
    }
}
