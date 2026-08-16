package com.universalmessenger.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.universalmessenger.app.data.Chat
import com.universalmessenger.app.store.AppStore
import com.universalmessenger.app.store.AppState
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

private val timeFmt = DateTimeFormatter.ofPattern("HH:mm")
private val dayFmt = DateTimeFormatter.ofPattern("MMM d")

fun formatListTime(ts: Long): String {
    if (ts <= 0) return ""
    val t = Instant.ofEpochMilli(ts).atZone(ZoneId.systemDefault())
    val now = java.time.LocalDate.now()
    return if (t.toLocalDate() == now) timeFmt.format(t)
    else dayFmt.format(t)
}

private fun providerColor(provider: String): Color = when (provider) {
    "whatsapp" -> Color(0xFF25D366)
    "telegram" -> Color(0xFF2AABEE)
    "signal" -> Color(0xFF3A76F0)
    "mattermost" -> Color(0xFF4FB41D)
    "voipms" -> Color(0xFFF5A623)
    else -> Color(0xFF8AB4F8)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatListScreen(store: AppStore) {
    val state by store.state.collectAsStateWithLifecycle()
    var showSettings by remember { mutableStateOf(false) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Chats") },
                actions = {
                    Box(
                        Modifier
                            .padding(end = 4.dp)
                            .size(10.dp)
                            .background(
                                if (state.connected) Color(0xFF25D366) else Color(0xFF888888),
                                CircleShape,
                            )
                    )
                    IconButton(onClick = { showSettings = true }) {
                        Icon(Icons.Default.Settings, contentDescription = "Settings")
                    }
                },
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (state.error != null) {
                Text(
                    state.error ?: "",
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
                Text(
                    "Check settings (gear icon)",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp),
                )
            }
            if (state.loading) {
                Box(Modifier.fillMaxWidth().padding(24.dp), Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
            val visible = state.chats
                .filter { (it.hidden ?: 0) == 0 }
                .sortedWith(compareByDescending<Chat> { it.pinned ?: 0 }.thenByDescending { it.ts })
            LazyColumn(Modifier.fillMaxSize()) {
                items(visible, key = { it.id }) { chat ->
                    ChatRow(chat, state.typingChatIds.contains(chat.id)) { store.openChat(chat.id) }
                }
            }
        }
    }
    if (showSettings) {
        ConnectionDialog(store) { showSettings = false }
    }
}

@Composable
private fun ChatRow(chat: Chat, typing: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(44.dp)
                .background(providerColor(chat.provider).copy(alpha = 0.18f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                chat.displayName.take(1).uppercase(),
                color = providerColor(chat.provider),
                fontWeight = FontWeight.Bold,
                fontSize = 18.sp,
            )
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    chat.displayName,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    chat.provider,
                    style = MaterialTheme.typography.labelSmall,
                    color = providerColor(chat.provider),
                )
            }
            val preview = when {
                typing -> "typing…"
                chat.lastMessage?.body?.isNotBlank() == true -> chat.lastMessage?.body ?: ""
                chat.lastMessage?.media?.isNotEmpty() == true -> "[media]"
                else -> ""
            }
            Text(
                preview,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(8.dp))
        Column(horizontalAlignment = Alignment.End) {
            Text(
                formatListTime(chat.ts),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (chat.unread > 0) {
                Spacer(Modifier.height(4.dp))
                Box(
                    Modifier
                        .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(10.dp))
                        .padding(horizontal = 7.dp, vertical = 2.dp)
                ) {
                    Text(
                        if (chat.unread > 99) "99+" else chat.unread.toString(),
                        color = MaterialTheme.colorScheme.onPrimary,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
        }
    }
}
