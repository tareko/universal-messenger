package com.universalmessenger.app.realtime

import com.universalmessenger.app.data.Api
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources

class SseClient(
    private val scope: CoroutineScope,
    private var api: Api,
) {
    private var job: Job? = null
    private val client = OkHttpClient.Builder()
        .connectTimeout(java.time.Duration.ofSeconds(15))
        .readTimeout(java.time.Duration.ofMinutes(5))
        .build()

    var onEvent: ((type: String, data: JsonObject?) -> Unit)? = null
    var onStateChange: ((connected: Boolean) -> Unit)? = null

    fun updateApi(next: Api) {
        api = next
    }

    fun start() {
        stop()
        job = scope.launch {
            var backoffMs = 3000L
            while (isActive) {
                var connectedOnce = false
                val closed = kotlinx.coroutines.CompletableDeferred<Unit>()
                val url = buildString {
                    append(api.url("events"))
                    if (!api.token.isNullOrBlank()) {
                        append(if ('?' in this) '&' else '?')
                        append("token=")
                        append(java.net.URLEncoder.encode(api.token, "UTF-8"))
                    }
                }
                val req = Request.Builder().url(url).build()
                val source = EventSources.createFactory(client).newEventSource(req, object : EventSourceListener() {
                    override fun onOpen(eventSource: EventSource, response: okhttp3.Response) {
                        backoffMs = 3000L
                        connectedOnce = true
                        onStateChange?.invoke(true)
                    }

                    override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                        runCatching {
                            val obj = api.json.parseToJsonElement(data).jsonObject
                            val t = obj["type"]?.let { it.toString().trim('"') } ?: return
                            val d = obj["data"] as? JsonObject
                            onEvent?.invoke(t, d)
                        }
                    }

                    override fun onClosed(eventSource: EventSource) {
                        onStateChange?.invoke(false)
                        closed.complete(Unit)
                    }

                    override fun onFailure(eventSource: EventSource, t: Throwable?, response: okhttp3.Response?) {
                        onStateChange?.invoke(false)
                        closed.complete(Unit)
                    }
                })
                closed.await()
                source.cancel()
                if (connectedOnce) delay(1000) else delay(backoffMs.also { backoffMs = (it * 2).coerceAtMost(60000L) })
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }
}
