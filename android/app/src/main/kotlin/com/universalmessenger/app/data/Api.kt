package com.universalmessenger.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (cont.isActive) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            cont.resume(response)
        }
    })
    cont.invokeOnCancellation { runCatching { cancel() } }
}

class ApiConnectionException(message: String) : Exception(message)

class Api(
    var baseUrl: String,
    var token: String?,
) {
    val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }
    private val client = OkHttpClient.Builder()
        .connectTimeout(java.time.Duration.ofSeconds(10))
        .readTimeout(java.time.Duration.ofSeconds(30))
        .build()

    fun url(path: String): String = baseUrl.trimEnd('/') + "/" + path.trimStart('/')

    private fun builder(path: String): Request.Builder {
        val b = Request.Builder().url(url(path))
        if (!token.isNullOrBlank()) b.addHeader("Authorization", "Bearer $token")
        return b
    }

    private suspend fun execute(request: Request): String = withContext(Dispatchers.IO) {
        client.newCall(request).await().use { res ->
            val body = res.body?.string().orEmpty()
            if (!res.isSuccessful) throw ApiConnectionException("HTTP ${res.code}: ${body.take(200)}")
            body
        }
    }

    suspend fun raw(path: String): String = execute(builder(path).get().build())

    suspend fun post(path: String, body: JsonObject): String =
        execute(builder(path).post(body.toString().toRequestBody("application/json".toMediaType())).build())

    inline fun <reified T> decode(text: String): T = json.decodeFromString(text)

    suspend fun status(): Boolean = runCatching { raw("api/status").isNotBlank() }.isSuccess

    suspend fun chats(): List<Chat> = json.decodeFromString(raw("api/chats"))

    suspend fun messages(chatId: String, limit: Int = 100): List<Message> =
        json.decodeFromString(raw("api/messages?chat=${java.net.URLEncoder.encode(chatId, "UTF-8")}&limit=$limit"))

    suspend fun send(chatId: String, body: String): Message {
        val payload = buildJsonObject {
            put("chatId", chatId)
            put("body", body)
        }
        return json.decodeFromString(post("api/send", payload))
    }

    suspend fun markRead(chatId: String) {
        post("api/markread", buildJsonObject { put("chatId", chatId) })
    }

    fun mediaUrl(ref: MediaRef): String = url(ref.url)
}
