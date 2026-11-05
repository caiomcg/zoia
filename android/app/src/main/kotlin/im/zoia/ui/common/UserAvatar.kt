package im.zoia.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import kotlin.math.abs

fun avatarHue(seed: String): Float {
    var hash = 0
    for (ch in seed) hash = (hash * 31 + ch.code)
    return (abs(hash) % 360).toFloat()
}

fun hslToColor(hue: Float, saturation: Float, lightness: Float): Color {
    val c = (1f - abs(2f * lightness - 1f)) * saturation
    val x = c * (1f - abs((hue / 60f) % 2f - 1f))
    val m = lightness - c / 2f
    val (r1, g1, b1) = when {
        hue < 60f -> Triple(c, x, 0f)
        hue < 120f -> Triple(x, c, 0f)
        hue < 180f -> Triple(0f, c, x)
        hue < 240f -> Triple(0f, x, c)
        hue < 300f -> Triple(x, 0f, c)
        else -> Triple(c, 0f, x)
    }
    return Color(r1 + m, g1 + m, b1 + m)
}

fun avatarInitials(name: String): String {
    val parts = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (parts.isEmpty()) return "?"
    if (parts.size == 1) return parts[0].take(2).uppercase()
    return (parts[0].take(1) + parts.last().take(1)).uppercase()
}

@Composable
fun UserAvatar(
    name: String,
    avatarUrl: String? = null,
    modifier: Modifier = Modifier,
    size: Dp = 32.dp,
    role: String? = null,
    isSpeaking: Boolean = false,
    onClick: (() -> Unit)? = null
) {
    val context = LocalContext.current
    val hue = remember(name) { avatarHue(name) }
    val initials = remember(name) { avatarInitials(name) }
    val bgColor = remember(hue) { hslToColor(hue, 0.45f, 0.35f) }

    Box(
        modifier = modifier
            .size(size)
            .then(if (onClick != null) Modifier.clickable { onClick() } else Modifier),
        contentAlignment = Alignment.Center
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .clip(CircleShape)
                .background(bgColor)
                .then(
                    if (isSpeaking) Modifier.border(2.dp, Color(0xFF23A55A), CircleShape)
                    else Modifier
                ),
            contentAlignment = Alignment.Center
        ) {
            if (!avatarUrl.isNullOrEmpty()) {
                AsyncImage(
                    model = ImageRequest.Builder(context)
                        .data(avatarUrl)
                        .crossfade(true)
                        .build(),
                    contentDescription = name,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize()
                )
            } else {
                Text(
                    text = initials,
                    color = Color.White,
                    fontSize = (size.value * 0.38f).coerceAtLeast(9f).sp,
                    fontWeight = FontWeight.Bold
                )
            }
        }

        // Crown for admin / super_admin
        if (role == "admin" || role == "super_admin") {
            val crownTint = if (role == "super_admin") Color(0xFFFFD700) else Color(0xFFB0B8C8)
            val badgeSize = (size * 0.42f).coerceAtLeast(14.dp)
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .offset(x = 2.dp, y = (-2).dp)
                    .size(badgeSize)
                    .clip(CircleShape)
                    .background(Color(0xFF14171E))
                    .padding(1.dp),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = Icons.Default.Star,
                    contentDescription = if (role == "super_admin") "Super Admin" else "Admin",
                    tint = crownTint,
                    modifier = Modifier.fillMaxSize()
                )
            }
        }
    }
}
