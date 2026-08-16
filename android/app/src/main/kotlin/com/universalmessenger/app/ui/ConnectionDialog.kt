package com.universalmessenger.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.universalmessenger.app.data.Api
import com.universalmessenger.app.store.AppStore
import kotlinx.coroutines.launch

/** Edit server connection at any time (gear icon on the chat list). */
@Composable
fun ConnectionDialog(store: AppStore, onDismiss: () -> Unit) {
    val state = store.state.value
    var url by remember { mutableStateOf(state.serverUrl) }
    var token by remember { mutableStateOf(state.token ?: "") }
    var checking by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun test() {
        checking = true
        result = null
        scope.launch {
            val api = Api(url.trim(), token.trim().ifBlank { null })
            result = if (runCatching { api.status() }.isSuccess) "Connected" else "Unreachable"
            checking = false
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Server connection") },
        text = {
            Column {
                OutlinedTextField(
                    value = url,
                    onValueChange = {
                        url = it
                        result = null
                    },
                    label = { Text("Server URL") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = token,
                    onValueChange = {
                        token = it
                        result = null
                    },
                    label = { Text("API token (optional)") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                )
                result?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = if (it == "Connected") MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    store.saveConnection(url, token)
                    onDismiss()
                },
                enabled = url.isNotBlank() && !checking,
            ) { Text("Save") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
