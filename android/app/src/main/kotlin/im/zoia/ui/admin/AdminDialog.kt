package im.zoia.ui.admin

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import im.zoia.api.AdminAccount
import im.zoia.api.IssuedResetCode
import im.zoia.api.ZoiaApiClient
import im.zoia.ui.common.UserAvatar
import kotlinx.coroutines.launch

@Composable
fun AdminDialog(
    apiClient: ZoiaApiClient,
    myAccountId: String,
    myRole: String,
    serverUrl: String,
    onDismiss: () -> Unit,
    onRefreshRooms: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var selectedTab by remember { mutableIntStateOf(0) }
    var accounts by remember { mutableStateOf<List<AdminAccount>?>(null) }
    var isLoading by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var busyAccountId by remember { mutableStateOf<String?>(null) }
    var issuedCode by remember { mutableStateOf<Pair<String, IssuedResetCode>?>(null) }

    val isSuperAdmin = myRole == "super_admin"

    fun loadAccounts() {
        scope.launch {
            isLoading = true
            errorMessage = null
            try {
                accounts = apiClient.getAdminAccounts()
            } catch (e: Exception) {
                errorMessage = e.message ?: "Erro ao carregar contas."
            } finally {
                isLoading = false
            }
        }
    }

    LaunchedEffect(Unit) {
        loadAccounts()
    }

    // Modal to show generated reset code
    if (issuedCode != null) {
        val (targetName, codeObj) = issuedCode!!
        AlertDialog(
            onDismissRequest = { issuedCode = null },
            containerColor = Color(0xFF161920),
            title = {
                Text(
                    text = "Código de Redefinição",
                    color = Color.White,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold
                )
            },
            text = {
                Column {
                    Text(
                        text = "Entregue este código para $targetName. Ele permite definir uma nova senha e expira em breve.",
                        color = Color(0xFF8E95A5),
                        fontSize = 14.sp
                    )
                    Spacer(modifier = Modifier.height(16.dp))
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .background(Color(0xFF0D0F12))
                            .padding(16.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = codeObj.code ?: "---",
                            color = Color(0xFF4E75FF),
                            fontSize = 22.sp,
                            fontWeight = FontWeight.Bold,
                            fontFamily = FontFamily.Monospace
                        )
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        val clip = ClipData.newPlainText("Código Zoia", codeObj.code ?: "")
                        clipboard.setPrimaryClip(clip)
                        Toast.makeText(context, "Código copiado!", Toast.LENGTH_SHORT).show()
                        issuedCode = null
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E5BFF)),
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Text("Copiar Código", color = Color.White)
                }
            },
            dismissButton = {
                TextButton(onClick = { issuedCode = null }) {
                    Text("Fechar", color = Color(0xFF8E95A5))
                }
            }
        )
    }

    val pendingList = accounts?.filter { it.status == "pending" } ?: emptyList()
    val otherList = accounts?.filter { it.status != "pending" } ?: emptyList()

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Color(0xFF161920),
        title = {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        imageVector = Icons.Default.AdminPanelSettings,
                        contentDescription = null,
                        tint = Color(0xFF4E75FF),
                        modifier = Modifier.size(22.dp)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "Administração",
                        color = Color.White,
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
                IconButton(onClick = { loadAccounts() }, enabled = !isLoading) {
                    Icon(
                        imageVector = Icons.Default.Refresh,
                        contentDescription = "Recarregar",
                        tint = Color(0xFF8E95A5)
                    )
                }
            }
        },
        text = {
            Column(modifier = Modifier.fillMaxWidth().heightIn(min = 300.dp, max = 500.dp)) {
                // Tabs
                TabRow(
                    selectedTabIndex = selectedTab,
                    containerColor = Color(0xFF161920),
                    contentColor = Color(0xFF4E75FF),
                    divider = {}
                ) {
                    Tab(
                        selected = selectedTab == 0,
                        onClick = { selectedTab = 0 },
                        text = {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("Aprovações", fontWeight = if (selectedTab == 0) FontWeight.Bold else FontWeight.Normal)
                                if (pendingList.isNotEmpty()) {
                                    Spacer(modifier = Modifier.width(6.dp))
                                    Box(
                                        modifier = Modifier
                                            .clip(CircleShape)
                                            .background(Color(0xFFE53935))
                                            .padding(horizontal = 6.dp, vertical = 1.dp)
                                    ) {
                                        Text(
                                            text = "${pendingList.size}",
                                            color = Color.White,
                                            fontSize = 10.sp,
                                            fontWeight = FontWeight.Bold
                                        )
                                    }
                                }
                            }
                        }
                    )
                    Tab(
                        selected = selectedTab == 1,
                        onClick = { selectedTab = 1 },
                        text = {
                            Text(
                                text = "Membros (${otherList.size})",
                                fontWeight = if (selectedTab == 1) FontWeight.Bold else FontWeight.Normal
                            )
                        }
                    )
                }

                Spacer(modifier = Modifier.height(12.dp))

                if (isLoading && accounts == null) {
                    Box(modifier = Modifier.fillMaxWidth().height(200.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = Color(0xFF4E75FF))
                    }
                } else if (errorMessage != null) {
                    Text(text = errorMessage!!, color = Color(0xFFFF6B6B), fontSize = 13.sp)
                } else {
                    when (selectedTab) {
                        0 -> {
                            if (pendingList.isEmpty()) {
                                Box(
                                    modifier = Modifier.fillMaxWidth().height(150.dp),
                                    contentAlignment = Alignment.Center
                                ) {
                                    Text(
                                        text = "Nenhuma conta aguardando aprovação.",
                                        color = Color(0xFF8E95A5),
                                        fontSize = 14.sp
                                    )
                                }
                            } else {
                                LazyColumn(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalArrangement = Arrangement.spacedBy(8.dp)
                                ) {
                                    items(items = pendingList, key = { it.id }) { item ->
                                        PendingAccountItem(
                                            account = item,
                                            isBusy = busyAccountId == item.id,
                                            onApprove = {
                                                scope.launch {
                                                    busyAccountId = item.id
                                                    try {
                                                        apiClient.adminApproveAccount(item.id)
                                                        loadAccounts()
                                                        onRefreshRooms()
                                                    } catch (e: Exception) {
                                                        errorMessage = e.message ?: "Erro ao aprovar."
                                                    } finally {
                                                        busyAccountId = null
                                                    }
                                                }
                                            },
                                            onReject = {
                                                scope.launch {
                                                    busyAccountId = item.id
                                                    try {
                                                        apiClient.adminRejectAccount(item.id)
                                                        loadAccounts()
                                                        onRefreshRooms()
                                                    } catch (e: Exception) {
                                                        errorMessage = e.message ?: "Erro ao rejeitar."
                                                    } finally {
                                                        busyAccountId = null
                                                    }
                                                }
                                            }
                                        )
                                    }
                                }
                            }
                        }
                        1 -> {
                            LazyColumn(
                                modifier = Modifier.fillMaxWidth(),
                                verticalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                items(items = otherList, key = { it.id }) { item ->
                                    val canManage = item.id != myAccountId &&
                                            item.role != "super_admin" &&
                                            (item.role != "admin" || isSuperAdmin)

                                    MemberAccountItem(
                                        account = item,
                                        serverUrl = serverUrl,
                                        canManage = canManage,
                                        isSuperAdmin = isSuperAdmin,
                                        isBusy = busyAccountId == item.id,
                                        onResetPassword = {
                                            scope.launch {
                                                busyAccountId = item.id
                                                try {
                                                    val res = apiClient.adminResetAccount(item.id)
                                                    issuedCode = item.name to res
                                                } catch (e: Exception) {
                                                    errorMessage = e.message ?: "Erro ao redefinir."
                                                } finally {
                                                    busyAccountId = null
                                                }
                                            }
                                        },
                                        onToggleRole = {
                                            scope.launch {
                                                busyAccountId = item.id
                                                try {
                                                    val newRole = if (item.role == "admin") "user" else "admin"
                                                    apiClient.adminSetRole(item.id, newRole)
                                                    loadAccounts()
                                                } catch (e: Exception) {
                                                    errorMessage = e.message ?: "Erro ao alterar papel."
                                                } finally {
                                                    busyAccountId = null
                                                }
                                            }
                                        },
                                        onToggleStatus = {
                                            scope.launch {
                                                busyAccountId = item.id
                                                try {
                                                    if (item.status == "disabled") {
                                                        apiClient.adminEnableAccount(item.id)
                                                    } else {
                                                        apiClient.adminDisableAccount(item.id)
                                                    }
                                                    loadAccounts()
                                                } catch (e: Exception) {
                                                    errorMessage = e.message ?: "Erro ao alterar status."
                                                } finally {
                                                    busyAccountId = null
                                                }
                                            }
                                        }
                                    )
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("Fechar", color = Color(0xFF4E75FF))
            }
        }
    )
}

@Composable
private fun PendingAccountItem(
    account: AdminAccount,
    isBusy: Boolean,
    onApprove: () -> Unit,
    onReject: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(Color(0xFF222630))
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = account.email,
                color = Color.White,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold
            )
            Spacer(modifier = Modifier.height(2.dp))
            Text(
                text = "Cadastrado: ${account.createdAt.take(10)} • IP: ${account.signupIp ?: "—"}",
                color = Color(0xFF8E95A5),
                fontSize = 11.sp
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = onApprove,
                enabled = !isBusy,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF23A55A)),
                shape = RoundedCornerShape(6.dp),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
            ) {
                Text("Aprovar", fontSize = 12.sp, color = Color.White)
            }
            OutlinedButton(
                onClick = onReject,
                enabled = !isBusy,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFFFF6B6B)),
                shape = RoundedCornerShape(6.dp),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
            ) {
                Text("Recusar", fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun MemberAccountItem(
    account: AdminAccount,
    serverUrl: String,
    canManage: Boolean,
    isSuperAdmin: Boolean,
    isBusy: Boolean,
    onResetPassword: () -> Unit,
    onToggleRole: () -> Unit,
    onToggleStatus: () -> Unit
) {
    val avatarUrl = remember(account.id, account.avatar) {
        if (!account.avatar.isNullOrEmpty()) {
            "$serverUrl/api/avatar/account/${account.id}?v=${account.avatar}"
        } else null
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(Color(0xFF222630))
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.weight(1f)
        ) {
            UserAvatar(
                name = account.name.ifBlank { account.email },
                avatarUrl = avatarUrl,
                role = account.role,
                size = 36.dp
            )
            Spacer(modifier = Modifier.width(10.dp))
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = account.name.ifBlank { account.email },
                        color = Color.White,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )
                    if (account.role != "user") {
                        Spacer(modifier = Modifier.width(6.dp))
                        val roleColor = if (account.role == "super_admin") Color(0xFFFFD700) else Color(0xFFB0B8C8)
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(4.dp))
                                .background(roleColor.copy(alpha = 0.2f))
                                .padding(horizontal = 4.dp, vertical = 1.dp)
                        ) {
                            Text(
                                text = if (account.role == "super_admin") "Super Admin" else "Admin",
                                color = roleColor,
                                fontSize = 10.sp,
                                fontWeight = FontWeight.Bold
                            )
                        }
                    }
                    if (account.status == "disabled") {
                        Spacer(modifier = Modifier.width(6.dp))
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(4.dp))
                                .background(Color(0xFFFF5252).copy(alpha = 0.2f))
                                .padding(horizontal = 4.dp, vertical = 1.dp)
                        ) {
                            Text(
                                text = "Desativado",
                                color = Color(0xFFFF5252),
                                fontSize = 10.sp,
                                fontWeight = FontWeight.Bold
                            )
                        }
                    }
                }
                Spacer(modifier = Modifier.height(2.dp))
                Text(
                    text = "${account.email} • ${account.devices} dispositivo(s)",
                    color = Color(0xFF8E95A5),
                    fontSize = 11.sp
                )
            }
        }

        if (canManage) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                // Reset password button
                IconButton(onClick = onResetPassword, enabled = !isBusy) {
                    Icon(
                        imageVector = Icons.Default.VpnKey,
                        contentDescription = "Redefinir senha",
                        tint = Color(0xFF4E75FF),
                        modifier = Modifier.size(18.dp)
                    )
                }

                // Make/remove admin (super_admin only)
                if (isSuperAdmin && account.status == "active") {
                    IconButton(onClick = onToggleRole, enabled = !isBusy) {
                        Icon(
                            imageVector = Icons.Default.Star,
                            contentDescription = if (account.role == "admin") "Remover Admin" else "Tornar Admin",
                            tint = if (account.role == "admin") Color(0xFFFFD700) else Color(0xFF8E95A5),
                            modifier = Modifier.size(18.dp)
                        )
                    }
                }

                // Disable / Enable account
                IconButton(onClick = onToggleStatus, enabled = !isBusy) {
                    Icon(
                        imageVector = if (account.status == "disabled") Icons.Default.CheckCircle else Icons.Default.Block,
                        contentDescription = if (account.status == "disabled") "Ativar" else "Desativar",
                        tint = if (account.status == "disabled") Color(0xFF23A55A) else Color(0xFFFF6B6B),
                        modifier = Modifier.size(18.dp)
                    )
                }
            }
        }
    }
}
