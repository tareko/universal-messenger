package com.universalmessenger.app.data

import kotlinx.serialization.Serializable

@Serializable
data class MediaRef(
    val url: String,
    val contentType: String = "application/octet-stream",
    val name: String? = null,
)

@Serializable
data class ReactionRef(val emoji: String, val from: String? = null)

@Serializable
data class Quoted(
    val id: String,
    val chatId: String,
    val body: String,
    val sender: String? = null,
    val outgoing: Int = 0,
    val senderName: String? = null,
    val deleted: Int? = null,
)

@Serializable
data class ContactCard(val name: String, val tel: String? = null)

@Serializable
data class Message(
    val id: String,
    val chatId: String,
    val accountId: String,
    val ts: Long,
    val date: String = "",
    val outgoing: Int = 0,
    val sender: String? = null,
    val senderName: String? = null,
    val body: String = "",
    val carrierStatus: String = "",
    val read: Int = 0,
    val media: List<MediaRef>? = null,
    val mediaPending: Boolean? = null,
    val quotedId: String? = null,
    val forwardedFrom: String? = null,
    val edited: Int? = null,
    val deleted: Int? = null,
    val receipt: String? = null,
    val contactCard: ContactCard? = null,
    val reactions: List<ReactionRef>? = null,
    val quoted: Quoted? = null,
)

@Serializable
data class Tag(
    val id: Int,
    val name: String,
    val description: String = "",
    val color: String = "",
)

@Serializable
data class Chat(
    val id: String,
    val accountId: String,
    val provider: String,
    val type: String = "dm",
    val remoteId: String = "",
    val contactRaw: String = "",
    val title: String? = null,
    val name: String? = null,
    val unread: Int = 0,
    val ts: Long = 0,
    val lastMessage: Message? = null,
    val ephemeralSeconds: Int? = null,
    val pinned: Int? = null,
    val hidden: Int? = null,
    val translateEnabled: Int? = null,
    val suggestEnabled: Int? = null,
    // Server sends the people-table row id (number), not a string.
    val personId: Long? = null,
    val tags: List<Tag> = emptyList(),
) {
    val displayName: String get() = title ?: name ?: contactRaw.ifBlank { id }
}

@Serializable
data class Account(
    val id: String,
    val provider: String,
    val label: String = "",
    val status: String = "",
)
