package com.universalmessenger.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.universalmessenger.app.data.Api
import com.universalmessenger.app.store.AppStore
import com.universalmessenger.app.ui.ChatListScreen
import com.universalmessenger.app.ui.ThreadScreen
import com.universalmessenger.app.ui.UMTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            UMTheme {
                App(viewModel())
            }
        }
    }
}

@Composable
fun App(store: AppStore = viewModel()) {
    val state by store.state.collectAsStateWithLifecycle()
    if (!state.configured) {
        SetupScreen(store)
    } else if (state.selectedChatId != null) {
        ThreadScreen(store)
    } else {
        ChatListScreen(store)
    }
}

@Composable
private fun SetupScreen(store: AppStore) {
    var url by remember { mutableStateOf("http://10.0.2.2:8317") }
    var token by remember { mutableStateOf("") }
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

    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Universal Messenger", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text("Server URL") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text("API token (optional)") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
        )
        Spacer(Modifier.height(16.dp))
        Button(onClick = ::test, enabled = url.isNotBlank() && !checking) {
            Text(if (checking) "Checking…" else "Test connection")
        }
        Spacer(Modifier.height(8.dp))
        Button(onClick = { store.saveConnection(url, token) }, enabled = url.isNotBlank() && result == "Connected") {
            Text("Save & connect")
        }
        result?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
        }
    }
}
