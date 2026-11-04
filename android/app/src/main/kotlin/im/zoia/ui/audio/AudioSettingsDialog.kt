package im.zoia.ui.audio

import android.media.AudioDeviceInfo
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.twilio.audioswitch.AudioDevice
import im.zoia.livekit.LiveKitRoomManager

fun formatOutputDeviceName(device: AudioDevice): Pair<String, ImageVector> {
    return when (device) {
        is AudioDevice.BluetoothHeadset -> Pair(
            if (device.name.isNotBlank()) "Bluetooth: ${device.name}" else "Dispositivo Bluetooth",
            Icons.Default.Bluetooth
        )
        is AudioDevice.WiredHeadset -> Pair("Fone de Ouvido com Fio", Icons.Default.Headphones)
        is AudioDevice.Earpiece -> Pair("Auricular do Aparelho", Icons.Default.PhoneInTalk)
        is AudioDevice.Speakerphone -> Pair("Alto-falante Principal", Icons.AutoMirrored.Filled.VolumeUp)
        else -> Pair(device.name.ifBlank { "Saída de Áudio" }, Icons.AutoMirrored.Filled.VolumeUp)
    }
}

fun formatInputDeviceName(device: AudioDeviceInfo): Pair<String, ImageVector> {
    val productName = device.productName.toString().trim()
    val (typeDesc, icon) = when (device.type) {
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> Pair("Microfone Integrado", Icons.Default.Mic)
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> Pair("Microfone do Fone com Fio", Icons.Default.Headphones)
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> Pair("Microfone Bluetooth", Icons.Default.Bluetooth)
        AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET -> Pair("Microfone USB", Icons.Default.Usb)
        else -> Pair("Microfone Externo", Icons.Default.Mic)
    }
    val label = if (productName.isNotBlank() && !productName.equals("Android", ignoreCase = true)) {
        "$typeDesc ($productName)"
    } else {
        typeDesc
    }
    return Pair(label, icon)
}

@Composable
fun AudioSettingsDialog(
    roomManager: LiveKitRoomManager,
    onDismiss: () -> Unit
) {
    val availableOutputs by roomManager.availableOutputs.collectAsState()
    val selectedOutput by roomManager.selectedOutput.collectAsState()
    val availableInputs by roomManager.availableInputs.collectAsState()
    val selectedInputId by roomManager.selectedInputId.collectAsState()
    val isInVoice by roomManager.isInVoice.collectAsState()
    val isMicMuted by roomManager.isMicrophoneMuted.collectAsState()

    LaunchedEffect(Unit) {
        roomManager.refreshAudioDevices()
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Color(0xFF161920),
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = Icons.Default.Tune,
                    contentDescription = null,
                    tint = Color(0xFF4E75FF),
                    modifier = Modifier.size(22.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = "Dispositivos de Áudio",
                    color = Color.White,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold
                )
            }
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 480.dp)
            ) {
                LazyColumn(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    // Output devices section
                    item {
                        Column {
                            Text(
                                text = "Saída de Som (Alto-falante / Fones)",
                                color = Color.White,
                                fontSize = 14.sp,
                                fontWeight = FontWeight.Bold
                            )
                            Spacer(modifier = Modifier.height(8.dp))
                            if (availableOutputs.isEmpty()) {
                                Text(
                                    text = "Usando o alto-falante padrão do sistema.",
                                    color = Color(0xFF8E95A5),
                                    fontSize = 13.sp
                                )
                            } else {
                                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    availableOutputs.forEach { device ->
                                        val isSelected = selectedOutput == device
                                        val (name, icon) = formatOutputDeviceName(device)
                                        Row(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .clip(RoundedCornerShape(8.dp))
                                                .background(if (isSelected) Color(0xFF283655) else Color(0xFF222630))
                                                .clickable { roomManager.selectAudioOutput(device) }
                                                .padding(horizontal = 12.dp, vertical = 10.dp),
                                            verticalAlignment = Alignment.CenterVertically,
                                            horizontalArrangement = Arrangement.SpaceBetween
                                        ) {
                                            Row(verticalAlignment = Alignment.CenterVertically) {
                                                Icon(
                                                    imageVector = icon,
                                                    contentDescription = null,
                                                    tint = if (isSelected) Color(0xFF4E75FF) else Color(0xFF8E95A5),
                                                    modifier = Modifier.size(20.dp)
                                                )
                                                Spacer(modifier = Modifier.width(10.dp))
                                                Text(
                                                    text = name,
                                                    color = if (isSelected) Color.White else Color(0xFFCCCCCC),
                                                    fontSize = 14.sp,
                                                    fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal
                                                )
                                            }
                                            if (isSelected) {
                                                Icon(
                                                    imageVector = Icons.Default.Check,
                                                    contentDescription = "Selecionado",
                                                    tint = Color(0xFF4E75FF),
                                                    modifier = Modifier.size(18.dp)
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Input devices section (Microphone)
                    item {
                        Column {
                            Text(
                                text = "Microfone (Entrada de Áudio)",
                                color = Color.White,
                                fontSize = 14.sp,
                                fontWeight = FontWeight.Bold
                            )
                            Spacer(modifier = Modifier.height(8.dp))

                            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                // Default option
                                val isDefaultSelected = selectedInputId == null
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(8.dp))
                                        .background(if (isDefaultSelected) Color(0xFF283655) else Color(0xFF222630))
                                        .clickable { roomManager.selectAudioInput(null) }
                                        .padding(horizontal = 12.dp, vertical = 10.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Icon(
                                            imageVector = Icons.Default.Mic,
                                            contentDescription = null,
                                            tint = if (isDefaultSelected) Color(0xFF4E75FF) else Color(0xFF8E95A5),
                                            modifier = Modifier.size(20.dp)
                                        )
                                        Spacer(modifier = Modifier.width(10.dp))
                                        Text(
                                            text = "Padrão do Sistema",
                                            color = if (isDefaultSelected) Color.White else Color(0xFFCCCCCC),
                                            fontSize = 14.sp,
                                            fontWeight = if (isDefaultSelected) FontWeight.Bold else FontWeight.Normal
                                        )
                                    }
                                    if (isDefaultSelected) {
                                        Icon(
                                            imageVector = Icons.Default.Check,
                                            contentDescription = "Selecionado",
                                            tint = Color(0xFF4E75FF),
                                            modifier = Modifier.size(18.dp)
                                        )
                                    }
                                }

                                // List of specific microphones
                                availableInputs.forEach { dev ->
                                    val isSelected = selectedInputId == dev.id
                                    val (name, icon) = formatInputDeviceName(dev)
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clip(RoundedCornerShape(8.dp))
                                            .background(if (isSelected) Color(0xFF283655) else Color(0xFF222630))
                                            .clickable { roomManager.selectAudioInput(dev) }
                                            .padding(horizontal = 12.dp, vertical = 10.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.SpaceBetween
                                    ) {
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            Icon(
                                                imageVector = icon,
                                                contentDescription = null,
                                                tint = if (isSelected) Color(0xFF4E75FF) else Color(0xFF8E95A5),
                                                modifier = Modifier.size(20.dp)
                                            )
                                            Spacer(modifier = Modifier.width(10.dp))
                                            Text(
                                                text = name,
                                                color = if (isSelected) Color.White else Color(0xFFCCCCCC),
                                                fontSize = 14.sp,
                                                fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal
                                            )
                                        }
                                        if (isSelected) {
                                            Icon(
                                                imageVector = Icons.Default.Check,
                                                contentDescription = "Selecionado",
                                                tint = Color(0xFF4E75FF),
                                                modifier = Modifier.size(18.dp)
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Voice controls if in voice
                    if (isInVoice) {
                        item {
                            Column {
                                Text(
                                    text = "Controle de Fala",
                                    color = Color.White,
                                    fontSize = 14.sp,
                                    fontWeight = FontWeight.Bold
                                )
                                Spacer(modifier = Modifier.height(8.dp))
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(8.dp))
                                        .background(Color(0xFF222630))
                                        .clickable { roomManager.toggleMicrophone() }
                                        .padding(horizontal = 12.dp, vertical = 10.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Icon(
                                            imageVector = if (isMicMuted) Icons.Default.MicOff else Icons.Default.Mic,
                                            contentDescription = null,
                                            tint = if (isMicMuted) Color(0xFFFF5252) else Color(0xFF23A55A),
                                            modifier = Modifier.size(20.dp)
                                        )
                                        Spacer(modifier = Modifier.width(10.dp))
                                        Text(
                                            text = if (isMicMuted) "Microfone Mutado" else "Microfone Aberto",
                                            color = Color.White,
                                            fontSize = 14.sp
                                        )
                                    }
                                    Switch(
                                        checked = !isMicMuted,
                                        onCheckedChange = { roomManager.setMicrophoneMuted(!it) },
                                        colors = SwitchDefaults.colors(
                                            checkedThumbColor = Color.White,
                                            checkedTrackColor = Color(0xFF23A55A),
                                            uncheckedThumbColor = Color(0xFF8E95A5),
                                            uncheckedTrackColor = Color(0xFF161920)
                                        )
                                    )
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = onDismiss,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E5BFF)),
                shape = RoundedCornerShape(8.dp)
            ) {
                Text("Fechar", color = Color.White)
            }
        }
    )
}
