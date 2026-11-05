package im.zoia.ui.update

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import im.zoia.update.UpdateInfo
import im.zoia.update.UpdateState
import java.io.File
import java.util.Locale

@Composable
fun UpdateDialog(
    state: UpdateState,
    onDownload: (UpdateInfo) -> Unit,
    onInstall: (File) -> Unit,
    onRetry: () -> Unit,
    onDismiss: () -> Unit
) {
    if (state is UpdateState.Idle) return

    val context = LocalContext.current

    AlertDialog(
        onDismissRequest = {
            if (state !is UpdateState.Downloading) {
                onDismiss()
            }
        },
        containerColor = Color(0xFF161920),
        title = {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                when (state) {
                    is UpdateState.UpdateAvailable -> {
                        Icon(
                            imageVector = Icons.Default.SystemUpdate,
                            contentDescription = null,
                            tint = Color(0xFF4E75FF),
                            modifier = Modifier.size(24.dp)
                        )
                        Text("Atualização Disponível", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    }
                    is UpdateState.Downloading -> {
                        Icon(
                            imageVector = Icons.Default.Download,
                            contentDescription = null,
                            tint = Color(0xFF4E75FF),
                            modifier = Modifier.size(24.dp)
                        )
                        Text("Baixando Zoia...", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    }
                    is UpdateState.ReadyToInstall -> {
                        Icon(
                            imageVector = Icons.Default.CheckCircle,
                            contentDescription = null,
                            tint = Color(0xFF4CAF50),
                            modifier = Modifier.size(24.dp)
                        )
                        Text("Download Concluído", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    }
                    is UpdateState.UpToDate -> {
                        Icon(
                            imageVector = Icons.Default.CheckCircle,
                            contentDescription = null,
                            tint = Color(0xFF4CAF50),
                            modifier = Modifier.size(24.dp)
                        )
                        Text("Aplicativo Atualizado", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    }
                    is UpdateState.Checking -> {
                        CircularProgressIndicator(
                            modifier = Modifier.size(20.dp),
                            color = Color(0xFF4E75FF),
                            strokeWidth = 2.dp
                        )
                        Text("Verificando...", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    }
                    is UpdateState.Error -> {
                        Icon(
                            imageVector = Icons.Default.ErrorOutline,
                            contentDescription = null,
                            tint = Color(0xFFFF6B6B),
                            modifier = Modifier.size(24.dp)
                        )
                        Text("Erro na Atualização", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    }
                    else -> Unit
                }
            }
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                when (state) {
                    is UpdateState.UpdateAvailable -> {
                        Text(
                            text = "Uma nova versão do Zoia está disponível: v${state.info.version}",
                            color = Color(0xFFD1D5DB),
                            fontSize = 14.sp
                        )

                        if (state.info.releaseNotes.isNotBlank()) {
                            Text(
                                text = "Notas da versão:",
                                color = Color(0xFF8E95A5),
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold
                            )
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .heightIn(max = 160.dp)
                                    .background(Color(0xFF0D0F12), RoundedCornerShape(8.dp))
                                    .padding(10.dp)
                                    .verticalScroll(rememberScrollState())
                            ) {
                                Text(
                                    text = state.info.releaseNotes,
                                    color = Color(0xFFB0B5C1),
                                    fontSize = 12.sp,
                                    lineHeight = 16.sp
                                )
                            }
                        }
                    }

                    is UpdateState.Downloading -> {
                        val percent = (state.progress * 100).toInt().coerceIn(0, 100)
                        LinearProgressIndicator(
                            progress = { state.progress },
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(8.dp),
                            color = Color(0xFF4E75FF),
                            trackColor = Color(0xFF262B36),
                        )
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text(
                                text = "${formatSize(state.bytesDownloaded)} / ${formatSize(state.totalBytes)}",
                                color = Color(0xFF8E95A5),
                                fontSize = 12.sp
                            )
                            Text(
                                text = "$percent%",
                                color = Color.White,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Bold
                            )
                        }
                    }

                    is UpdateState.ReadyToInstall -> {
                        Text(
                            text = "A nova versão (v${state.info.version}) foi baixada com sucesso e está pronta para ser instalada.",
                            color = Color(0xFFD1D5DB),
                            fontSize = 14.sp
                        )
                    }

                    is UpdateState.UpToDate -> {
                        Text(
                            text = "Você já está utilizando a versão mais recente do Zoia (${state.currentVersion}).",
                            color = Color(0xFFD1D5DB),
                            fontSize = 14.sp
                        )
                    }

                    is UpdateState.Checking -> {
                        Text(
                            text = "Consultando os servidores para verificar novas versões...",
                            color = Color(0xFF8E95A5),
                            fontSize = 14.sp
                        )
                    }

                    is UpdateState.Error -> {
                        Text(
                            text = state.message,
                            color = Color(0xFFFF6B6B),
                            fontSize = 13.sp
                        )
                    }

                    else -> Unit
                }
            }
        },
        confirmButton = {
            when (state) {
                is UpdateState.UpdateAvailable -> {
                    Button(
                        onClick = { onDownload(state.info) },
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF4E75FF)),
                        shape = RoundedCornerShape(8.dp)
                    ) {
                        Text("Baixar e Atualizar", color = Color.White)
                    }
                }
                is UpdateState.ReadyToInstall -> {
                    Button(
                        onClick = { onInstall(state.apkFile) },
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF4CAF50)),
                        shape = RoundedCornerShape(8.dp)
                    ) {
                        Text("Instalar Agora", color = Color.White)
                    }
                }
                is UpdateState.UpToDate -> {
                    Button(
                        onClick = onDismiss,
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF4E75FF)),
                        shape = RoundedCornerShape(8.dp)
                    ) {
                        Text("Entendido", color = Color.White)
                    }
                }
                is UpdateState.Error -> {
                    Button(
                        onClick = onRetry,
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF4E75FF)),
                        shape = RoundedCornerShape(8.dp)
                    ) {
                        Text("Tentar Novamente", color = Color.White)
                    }
                }
                else -> Unit
            }
        },
        dismissButton = {
            if (state !is UpdateState.Downloading && state !is UpdateState.Checking && state !is UpdateState.UpToDate) {
                TextButton(onClick = onDismiss) {
                    Text("Depois", color = Color(0xFF8E95A5))
                }
            }
        }
    )
}

private fun formatSize(bytes: Long): String {
    if (bytes <= 0) return "--"
    val mb = bytes.toDouble() / (1024 * 1024)
    return String.format(Locale.US, "%.1f MB", mb)
}
