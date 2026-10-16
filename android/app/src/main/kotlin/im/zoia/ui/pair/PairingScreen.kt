package im.zoia.ui.pair

import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FileUpload
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import im.zoia.auth.InviteParser
import im.zoia.auth.SessionManager
import im.zoia.auth.SessionState
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

@Composable
fun PairingScreen(
    sessionManager: SessionManager,
    onPairedSuccess: () -> Unit
) {
    val context = LocalContext.current
    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    val sessionState by sessionManager.sessionState.collectAsState()
    var deviceNameInput by remember {
        mutableStateOf(sessionManager.getSavedDisplayName() ?: "${Build.MANUFACTURER} ${Build.MODEL}".trim())
    }

    val filePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        if (uri != null) {
            lifecycleOwner.lifecycleScope.launch {
                try {
                    val content = context.contentResolver.openInputStream(uri)?.use { stream ->
                        stream.bufferedReader().readText()
                    } ?: return@launch

                    val invite = InviteParser.parse(content)
                    val chosenName = deviceNameInput.trim().ifEmpty { "${Build.MANUFACTURER} ${Build.MODEL}".trim() }
                    val result = sessionManager.pairWithInvite(invite, chosenName)
                    if (result.isSuccess) {
                        onPairedSuccess()
                    }
                } catch (e: Exception) {
                    // Handled through sessionManager.sessionState Error
                }
            }
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0D0F12))
            .padding(32.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier.fillMaxWidth(0.6f)
        ) {
            Text(
                text = "Zoia",
                color = Color.White,
                fontSize = 42.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 2.sp
            )

            Spacer(modifier = Modifier.height(12.dp))

            Text(
                text = "Transmissão privada de tela e áudio em tempo real.",
                color = Color(0xFF8E95A5),
                fontSize = 16.sp,
                textAlign = TextAlign.Center
            )

            Spacer(modifier = Modifier.height(48.dp))

            when (sessionState) {
                is SessionState.Loading -> {
                    CircularProgressIndicator(color = Color(0xFF4E75FF), modifier = Modifier.size(48.dp))
                    Spacer(modifier = Modifier.height(16.dp))
                    Text(text = "Conectando ao servidor...", color = Color.White)
                }
                else -> {
                    OutlinedTextField(
                        value = deviceNameInput,
                        onValueChange = { deviceNameInput = it },
                        label = { Text("Nome de Exibição", color = Color(0xFF8E95A5)) },
                        placeholder = { Text("Ex: Meu Tablet", color = Color(0xFF6B7280)) },
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedTextColor = Color.White,
                            unfocusedTextColor = Color.White,
                            focusedBorderColor = Color(0xFF4E75FF),
                            unfocusedBorderColor = Color(0xFF333842),
                            focusedContainerColor = Color(0xFF161920),
                            unfocusedContainerColor = Color(0xFF161920)
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(16.dp))

                    Button(
                        onClick = { filePickerLauncher.launch("*/*") },
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E5BFF)),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(56.dp)
                    ) {
                        Icon(imageVector = Icons.Default.FileUpload, contentDescription = null, tint = Color.White)
                        Spacer(modifier = Modifier.size(12.dp))
                        Text(
                            text = "Importar zoia-invite.json",
                            color = Color.White,
                            fontSize = 16.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                    }
                }
            }

            if (sessionState is SessionState.Error) {
                val errorMsg = (sessionState as SessionState.Error).message
                Spacer(modifier = Modifier.height(24.dp))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0x33FF4D4D), RoundedCornerShape(8.dp))
                        .padding(16.dp)
                ) {
                    Text(
                        text = errorMsg,
                        color = Color(0xFFFF6B6B),
                        fontSize = 14.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }
        }
    }
}
