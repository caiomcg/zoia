package im.zoia.ui.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import im.zoia.auth.AuthResult
import im.zoia.auth.PasswordRules
import im.zoia.auth.SessionManager
import kotlinx.coroutines.launch

private enum class Mode { SIGN_IN, SIGN_UP, CODE }

private val Muted = Color(0xFF8E95A5)
private val Accent = Color(0xFF4E75FF)
private val Ok = Color(0xFF23A55A)

/**
 * Before this device is signed in: sign in, create an account, or set a new
 * password with a code from an admin. See ADR 0031.
 *
 * The server address is a field, typed without https:// if you like; it
 * starts with the server last signed in to. The column scrolls, so the form
 * fits a phone held sideways with the keyboard up.
 */
@Composable
fun AuthScreen(sessionManager: SessionManager, initialMessage: String?) {
    val scope = rememberCoroutineScope()
    var mode by remember { mutableStateOf(Mode.SIGN_IN) }
    var server by remember { mutableStateOf(sessionManager.getLastServerUrl() ?: "") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(initialMessage) }

    fun switchTo(next: Mode) {
        mode = next
        error = null
        password = ""
        confirm = ""
    }

    fun submit() {
        if (busy) return
        if (mode != Mode.SIGN_IN && !PasswordRules.isStrong(password)) {
            error = "A senha ainda não atende a todos os requisitos."
            return
        }
        if (mode != Mode.SIGN_IN && password != confirm) {
            error = "As senhas não são iguais."
            return
        }
        busy = true
        error = null
        scope.launch {
            val result = when (mode) {
                Mode.SIGN_IN -> sessionManager.signIn(server, email, password)
                Mode.SIGN_UP -> sessionManager.signUp(server, email, password)
                Mode.CODE -> sessionManager.redeem(server, code, password)
            }
            busy = false
            if (result is AuthResult.Failed) error = result.message
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0D0F12))
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier
                .widthIn(max = 420.dp)
                .fillMaxWidth()
        ) {
            Text(text = "Zoia", color = Color.White, fontSize = 36.sp, fontWeight = FontWeight.Bold, letterSpacing = 2.sp)
            Spacer(Modifier.height(8.dp))
            Text(
                text = when (mode) {
                    Mode.SIGN_IN -> "Entre para assistir com seu grupo."
                    Mode.SIGN_UP -> "Um admin aprova as contas novas antes de elas poderem entrar."
                    Mode.CODE -> "Digite o código que um admin te enviou e escolha uma senha nova."
                },
                color = Muted,
                fontSize = 14.sp,
                textAlign = TextAlign.Center
            )
            Spacer(Modifier.height(28.dp))

            Field("Servidor", server, { server = it }, busy, KeyboardType.Uri, placeholder = "zoia.exemplo.com")
            if (mode == Mode.CODE) {
                Field("Código", code, { code = it }, busy, KeyboardType.Ascii)
            } else {
                Field("E-mail", email, { email = it }, busy, KeyboardType.Email)
            }
            Field(
                if (mode == Mode.CODE) "Senha nova" else "Senha",
                password,
                { password = it },
                busy,
                KeyboardType.Password,
                secret = true
            )
            if (mode != Mode.SIGN_IN) {
                PasswordChecklist(password)
                Field("Confirme a senha", confirm, { confirm = it }, busy, KeyboardType.Password, secret = true)
            }

            Spacer(Modifier.height(16.dp))
            Button(
                onClick = { submit() },
                enabled = !busy,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E5BFF)),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp)
            ) {
                if (busy) {
                    CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                } else {
                    Text(
                        text = when (mode) {
                            Mode.SIGN_IN -> "Entrar"
                            Mode.SIGN_UP -> "Criar conta"
                            Mode.CODE -> "Definir senha"
                        },
                        color = Color.White,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }

            if (mode != Mode.SIGN_IN) SwitchLink("Já tem conta? Entre", busy) { switchTo(Mode.SIGN_IN) }
            if (mode != Mode.SIGN_UP) SwitchLink("Ainda não tem conta? Crie uma", busy) { switchTo(Mode.SIGN_UP) }
            if (mode != Mode.CODE) SwitchLink("Tem um código de um admin?", busy) { switchTo(Mode.CODE) }

            error?.let {
                Spacer(Modifier.height(16.dp))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0x33FF4D4D), RoundedCornerShape(8.dp))
                        .padding(14.dp)
                ) {
                    Text(text = it, color = Color(0xFFFF6B6B), fontSize = 14.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
                }
            }
        }
    }
}

@Composable
private fun Field(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    busy: Boolean,
    keyboard: KeyboardType,
    secret: Boolean = false,
    placeholder: String? = null,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label, color = Muted) },
        placeholder = placeholder?.let { { Text(it, color = Color(0xFF6B7280)) } },
        singleLine = true,
        enabled = !busy,
        visualTransformation = if (secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = keyboard, autoCorrectEnabled = false),
        colors = OutlinedTextFieldDefaults.colors(
            focusedTextColor = Color.White,
            unfocusedTextColor = Color.White,
            disabledTextColor = Muted,
            focusedBorderColor = Accent,
            unfocusedBorderColor = Color(0xFF333842),
            focusedContainerColor = Color(0xFF161920),
            unfocusedContainerColor = Color(0xFF161920),
            disabledContainerColor = Color(0xFF161920)
        ),
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp)
    )
}

/** What a new password still needs, ticked off while it is typed. The server checks the same rule. */
@Composable
private fun PasswordChecklist(password: String) {
    Column(
        verticalArrangement = Arrangement.spacedBy(2.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 4.dp, bottom = 6.dp)
    ) {
        for (rule in PasswordRules.Rule.entries) {
            val met = rule.check(password)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (met) "✓" else "•", color = if (met) Ok else Muted, fontSize = 12.sp, modifier = Modifier.widthIn(min = 14.dp))
                Text(rule.label, color = if (met) Ok else Muted, fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun SwitchLink(text: String, busy: Boolean, onClick: () -> Unit) {
    TextButton(onClick = onClick, enabled = !busy) {
        Text(text, color = Muted, fontSize = 13.sp)
    }
}
