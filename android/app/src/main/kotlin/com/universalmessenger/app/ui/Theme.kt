package com.universalmessenger.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Scheme = darkColorScheme(
    primary = Color(0xFF8AB4F8),
    onPrimary = Color(0xFF002A63),
    primaryContainer = Color(0xFF0F3D7A),
    onPrimaryContainer = Color(0xFFD7E3FF),
    secondary = Color(0xFFAAC7FF),
    background = Color(0xFF0E0E12),
    onBackground = Color(0xFFE4E2E6),
    surface = Color(0xFF0E0E12),
    onSurface = Color(0xFFE4E2E6),
    surfaceVariant = Color(0xFF1E1F24),
    onSurfaceVariant = Color(0xFFC4C6CF),
    surfaceContainer = Color(0xFF16171B),
    surfaceContainerHigh = Color(0xFF202126),
    error = Color(0xFFFFB4AB),
)

@Composable
fun UMTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Scheme, content = content)
}
