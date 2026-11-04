package im.zoia.ui.profile

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import im.zoia.ui.common.UserAvatar
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream



@Composable
fun ProfileDialog(
    currentName: String,
    currentAvatar: String?,
    accountId: String,
    role: String,
    serverUrl: String,
    onSaveName: suspend (String) -> String?,
    onUploadAvatar: suspend (ByteArray) -> String?,
    onDeleteAvatar: suspend () -> String?,
    onOpenAudioSettings: (() -> Unit)? = null,
    onSignOut: () -> Unit,
    onDismiss: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var nameInput by remember { mutableStateOf(currentName) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var isSaving by remember { mutableStateOf(false) }
    var showSignOutConfirm by remember { mutableStateOf(false) }
    var pickedBitmapForCrop by remember { mutableStateOf<Bitmap?>(null) }

    val photoPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri != null) {
            try {
                val inputStream = context.contentResolver.openInputStream(uri)
                val decoded = BitmapFactory.decodeStream(inputStream)
                if (decoded != null) {
                    pickedBitmapForCrop = decoded
                } else {
                    errorMessage = "Não foi possível carregar a imagem selecionada."
                }
            } catch (e: Exception) {
                errorMessage = e.message ?: "Falha ao abrir imagem."
            }
        }
    }

    if (pickedBitmapForCrop != null) {
        AvatarCropDialog(
            bitmap = pickedBitmapForCrop!!,
            onCancel = { pickedBitmapForCrop = null },
            onSave = { bytes ->
                val err = onUploadAvatar(bytes)
                if (err == null) {
                    pickedBitmapForCrop = null
                }
                err
            }
        )
    }

    if (showSignOutConfirm) {
        AlertDialog(
            onDismissRequest = { showSignOutConfirm = false },
            containerColor = Color(0xFF161920),
            title = {
                Text(
                    text = "Sair desta conta?",
                    color = Color.White,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold
                )
            },
            text = {
                Text(
                    text = "Este tablet deixará de estar conectado. Para voltar a assistir, será necessário fazer login novamente.",
                    color = Color(0xFF8E95A5),
                    fontSize = 14.sp
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        showSignOutConfirm = false
                        onDismiss()
                        onSignOut()
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFE53935)),
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Text("Sim, Sair", color = Color.White)
                }
            },
            dismissButton = {
                TextButton(onClick = { showSignOutConfirm = false }) {
                    Text("Cancelar", color = Color(0xFF8E95A5))
                }
            }
        )
    }

    AlertDialog(
        onDismissRequest = { if (!isSaving) onDismiss() },
        containerColor = Color(0xFF161920),
        title = {
            Text(
                text = "Meu Perfil",
                color = Color.White,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold
            )
        },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                val avatarUrl = remember(currentAvatar, accountId) {
                    if (!currentAvatar.isNullOrEmpty() && accountId.isNotEmpty()) {
                        "$serverUrl/api/avatar/account/$accountId?v=$currentAvatar"
                    } else null
                }

                // Avatar display
                Box(
                    modifier = Modifier.size(88.dp),
                    contentAlignment = Alignment.Center
                ) {
                    UserAvatar(
                        name = currentName,
                        avatarUrl = avatarUrl,
                        role = role,
                        size = 80.dp
                    )
                }

                Spacer(modifier = Modifier.height(10.dp))

                // Role badge
                val roleLabel = when (role) {
                    "super_admin" -> "Super Administrador"
                    "admin" -> "Administrador"
                    else -> "Membro"
                }
                val roleColor = when (role) {
                    "super_admin" -> Color(0xFFFFD700)
                    "admin" -> Color(0xFFB0B8C8)
                    else -> Color(0xFF4E75FF)
                }
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(12.dp))
                        .background(roleColor.copy(alpha = 0.15f))
                        .padding(horizontal = 10.dp, vertical = 4.dp)
                ) {
                    Text(
                        text = roleLabel,
                        color = roleColor,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                }

                Spacer(modifier = Modifier.height(12.dp))

                // Avatar actions: Change / Remove
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    OutlinedButton(
                        onClick = {
                            photoPickerLauncher.launch(
                                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                            )
                        },
                        enabled = !isSaving,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White),
                        shape = RoundedCornerShape(8.dp),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.PhotoCamera,
                            contentDescription = null,
                            tint = Color(0xFF4E75FF),
                            modifier = Modifier.size(16.dp)
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Trocar Foto", fontSize = 13.sp)
                    }

                    if (!currentAvatar.isNullOrEmpty()) {
                        OutlinedButton(
                            onClick = {
                                scope.launch {
                                    isSaving = true
                                    errorMessage = null
                                    try {
                                        val err = onDeleteAvatar()
                                        if (err != null) errorMessage = err
                                    } catch (e: Exception) {
                                        errorMessage = e.message ?: "Erro ao remover foto."
                                    } finally {
                                        isSaving = false
                                    }
                                }
                            },
                            enabled = !isSaving,
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFFFF6B6B)),
                            shape = RoundedCornerShape(8.dp),
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.Delete,
                                contentDescription = null,
                                tint = Color(0xFFFF6B6B),
                                modifier = Modifier.size(16.dp)
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Remover", fontSize = 13.sp)
                        }
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                // Display name input
                OutlinedTextField(
                    value = nameInput,
                    onValueChange = {
                        nameInput = it
                        errorMessage = null
                    },
                    label = { Text("Nome de exibição", color = Color(0xFF8E95A5)) },
                    singleLine = true,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = Color.White,
                        unfocusedTextColor = Color.White,
                        focusedBorderColor = Color(0xFF4E75FF),
                        unfocusedBorderColor = Color(0xFF333842),
                        focusedContainerColor = Color(0xFF0D0F12),
                        unfocusedContainerColor = Color(0xFF0D0F12)
                    ),
                    modifier = Modifier.fillMaxWidth()
                )

                if (errorMessage != null) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = errorMessage!!,
                        color = Color(0xFFFF6B6B),
                        fontSize = 12.sp
                    )
                }

                Spacer(modifier = Modifier.height(20.dp))

                if (onOpenAudioSettings != null) {
                    OutlinedButton(
                        onClick = {
                            onDismiss()
                            onOpenAudioSettings()
                        },
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White),
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(
                            imageVector = Icons.Default.Tune,
                            contentDescription = null,
                            tint = Color(0xFF4E75FF),
                            modifier = Modifier.size(18.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Dispositivos de Áudio", fontSize = 14.sp)
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                }

                TextButton(onClick = { showSignOutConfirm = true }) {
                    Text(
                        text = "Sair desta conta",
                        color = Color(0xFFE53935),
                        fontSize = 13.sp
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val trimmed = nameInput.trim()
                    if (trimmed.isEmpty()) {
                        errorMessage = "O nome não pode estar em branco."
                        return@Button
                    }
                    if (trimmed.length > 32) {
                        errorMessage = "O nome deve ter no máximo 32 caracteres."
                        return@Button
                    }
                    if (trimmed == currentName) {
                        onDismiss()
                        return@Button
                    }
                    isSaving = true
                    scope.launch {
                        val err = onSaveName(trimmed)
                        isSaving = false
                        if (err != null) {
                            errorMessage = err
                        } else {
                            onDismiss()
                        }
                    }
                },
                enabled = !isSaving && nameInput.isNotBlank(),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E5BFF)),
                shape = RoundedCornerShape(8.dp)
            ) {
                if (isSaving) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                        color = Color.White
                    )
                } else {
                    Text("Salvar", color = Color.White)
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !isSaving) {
                Text("Fechar", color = Color(0xFF8E95A5))
            }
        }
    )
}
