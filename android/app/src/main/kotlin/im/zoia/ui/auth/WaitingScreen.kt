package im.zoia.ui.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import im.zoia.auth.SessionManager
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** How often a pending account asks whether it has been approved. */
private const val POLL_MS = 5_000L

/**
 * Signed in, but the account is waiting for an admin. Nothing else is
 * reachable until then, so this asks every few seconds and moves on by
 * itself; signing out is the only thing to do here.
 */
@Composable
fun WaitingScreen(sessionManager: SessionManager, email: String) {
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        while (true) {
            delay(POLL_MS)
            sessionManager.refresh()
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0D0F12))
            .padding(32.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.widthIn(max = 420.dp)) {
            Text("Aguardando aprovação", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(10.dp))
            Text(
                text = "Um admin precisa aprovar $email antes de você entrar. Esta tela avança sozinha quando aprovarem.",
                color = Color(0xFF8E95A5),
                fontSize = 14.sp,
                textAlign = TextAlign.Center
            )
            Spacer(Modifier.height(28.dp))
            CircularProgressIndicator(color = Color(0xFF4E75FF), modifier = Modifier.size(32.dp))
            Spacer(Modifier.height(20.dp))
            TextButton(onClick = { scope.launch { sessionManager.signOut() } }) {
                Text("Sair", color = Color(0xFF8E95A5), fontSize = 13.sp)
            }
        }
    }
}
