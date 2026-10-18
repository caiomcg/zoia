package im.zoia

import android.app.PictureInPictureParams
import android.os.Build
import android.os.Bundle
import android.util.Rational
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import im.zoia.auth.SessionState
import im.zoia.ui.auth.AuthScreen
import im.zoia.ui.auth.WaitingScreen
import kotlinx.coroutines.delay
import im.zoia.ui.room.RoomScreen

class MainActivity : ComponentActivity() {
    private val app get() = ZoiaApp.instance

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // No credential is ever taken from the launching intent: this activity
        // is exported, so any app could start it with one and point Zoia at a
        // server of its choosing. Signing in is the only way in.
        setContent {
            ZoiaRoot()
        }
    }

    @Composable
    private fun ZoiaRoot() {
        val sessionState by app.sessionManager.sessionState.collectAsState()
        val scope = rememberCoroutineScope()

        LaunchedEffect(Unit) {
            app.sessionManager.restoreSession()
        }

        // Signed in: ask now and then who this device is, so a role change,
        // or being signed out or disabled from elsewhere, is taken in without
        // a restart. The channel list notices sooner when it is open.
        val signedIn = sessionState is SessionState.Authenticated
        LaunchedEffect(signedIn) {
            while (signedIn) {
                delay(ACCOUNT_POLL_MS)
                app.sessionManager.refresh()
            }
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color(0xFF0D0F12))
        ) {
            when (val state = sessionState) {
                is SessionState.Pending -> {
                    WaitingScreen(sessionManager = app.sessionManager, email = state.email)
                }
                is SessionState.SignedOut -> {
                    AuthScreen(sessionManager = app.sessionManager, initialMessage = state.message)
                }
                is SessionState.Initial, is SessionState.Loading -> {
                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = Color(0xFF4E75FF))
                    }
                }
                is SessionState.Authenticated -> {
                    RoomScreen(
                        roomManager = app.roomManager,
                        sessionManager = app.sessionManager,
                        apiClient = app.apiClient,
                        onEnterPiP = { enterPipMode() }
                    )
                }
                is SessionState.Error -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(32.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center
                        ) {
                            Text(
                                text = "Não foi possível conectar",
                                color = Color.White,
                                fontSize = 20.sp,
                                fontWeight = FontWeight.Bold
                            )
                            Spacer(modifier = Modifier.height(8.dp))
                            Text(
                                text = state.message,
                                color = Color(0xFF8E95A5),
                                fontSize = 14.sp,
                                textAlign = TextAlign.Center
                            )
                            Spacer(modifier = Modifier.height(24.dp))
                            Button(
                                onClick = {
                                    scope.launch { app.sessionManager.restoreSession() }
                                },
                                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF4E75FF))
                            ) {
                                Text("Tentar Novamente", color = Color.White)
                            }
                            Spacer(modifier = Modifier.height(12.dp))
                            TextButton(
                                onClick = { scope.launch { app.sessionManager.signOut() } }
                            ) {
                                Text("Sair desta conta", color = Color(0xFF6B7280), fontSize = 13.sp)
                            }
                        }
                    }
                }
            }
        }
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (app.sessionManager.sessionState.value is SessionState.Authenticated) {
            enterPipMode()
        }
    }

    private fun enterPipMode() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val params = PictureInPictureParams.Builder()
                .setAspectRatio(Rational(16, 9))
                .build()
            enterPictureInPictureMode(params)
        }
    }

    companion object {
        private const val ACCOUNT_POLL_MS = 30_000L
    }

    override fun onDestroy() {
        super.onDestroy()
        if (isFinishing) {
            app.roomManager.disconnect()
        }
    }
}
