# Spec: Zoia Android Client (`zoia-android`)

## Capability Map

| Module id | Responsibility | Depends on |
|---|---|---|
| `android-core-auth` | Conta com e-mail e senha aprovada por um admin (ADR 0031): entrar (`/api/login`), criar conta (`/api/signup`), código de redefinição (`/api/reset`), tela de espera até a aprovação, armazenamento seguro da credencial do aparelho via `EncryptedSharedPreferences`, sessão (`/api/device/session`, `/api/session`), sair (`/api/device/forget`) e gerenciador de cookies. | — |
| `android-viewer` | Conexão LiveKit Room, exibição em tela cheia/grade de streams de vídeo ativas, seleção de áudio de apresentação, controle de volume, navegação de canais (`/api/rooms`), Picture-in-Picture (PiP) e áudio em segundo plano. | `android-core-auth` |

*(Nota: O módulo de transmissão `android-broadcaster` foi postergado para uma etapa futura conforme alinhamento com o usuário).*

**Ordem de construção:** `android-core-auth` → `android-viewer`.

---

## Objective

Disponibilizar o Zoia para dispositivos móveis e tablets **Android (Android 10+ / API 29+)** com foco exclusivo na **experiência de visualização (Viewer)**:
1. Permitir que o usuário entre em salas privadas com sua conta (e-mail e senha), aprovada por um admin.
2. Assistir a transmissões com baixíssima latência (WebRTC SFU via LiveKit).
3. Alternar entre canais e selecionar qual stream terá o áudio executado.
4. Suportar Picture-in-Picture (PiP) e reprodução contínua de áudio em segundo plano (com tela desligada).

### Casos de Uso Primários
1. **Conta:** O usuário abre o app, digita o endereço do servidor (https:// é assumido) e entra com e-mail e senha, ou cria uma conta e espera a aprovação de um admin. O login devolve um `deviceCredential`, guardado de forma segura, para que a senha seja digitada uma vez por aparelho.
2. **Espectador Móvel (Viewer):** O usuário conecta ao canal padrão ou escolhe um canal, visualiza os streams disponíveis, escuta o áudio do stream ativo e pode colocar em modo tela cheia ou PiP.
3. **Distribuição e Teste:** Geração de arquivo `.apk` diretamente para instalação e teste no tablet conectado via USB Debugging (`adb`).

---

## Tech Stack

- **Plataforma:** Android Nativo (Kotlin)
- **Versão Mínima:** Android 10 (API Level 29) — necessária para suporte a `AudioPlaybackCapture` e padrões modernos de segurança WebRTC. Versão alvo: Android 14+ (API 34/35).
- **Linguagem:** Kotlin 2.x
- **UI Toolkit:** Jetpack Compose + Material 3 (Design minimalista e escuro, consistente com a identidade visual do Zoia Desktop).
- **WebRTC / Mídia:** `io.livekit:livekit-android:2.x` (SDK oficial LiveKit Android com suporte a hardware decoding H.264/VP8/VP9 e otimização de bateria).
- **Rede & HTTP:** `OkHttp 4.x` (com `CookieJar` persistente e interceptors de autenticação) + `Retrofit` / `Kotlinx.serialization`.
- **Armazenamento Seguro:** `AndroidX Security Crypto` (`EncryptedSharedPreferences` / Android Keystore) para persistir o `deviceCredential` com segurança em repouso.
- **Injeção de Dependência:** Koin ou Hilt.

*(Nota: Avaliou-se React Native, porém o ecossistema Android nativo com Jetpack Compose e o SDK oficial `livekit-android` elimina pontes de interoperabilidade para serviços em segundo plano, Picture-in-Picture, gerenciamento de foco de áudio do sistema e captura de tela via MediaProjection).*

---

## Commands

```bash
# Compilar APK de debug
./gradlew assembleDebug

# Executar testes unitários
./gradlew testDebugUnitTest

# Executar verificação estática / linter
./gradlew lintDebug detekt

# Instalar no dispositivo ou emulador conectado
./gradlew installDebug
```

---

## Project Structure

Diretório dedicado no repositório: `android/`

```
android/
├── app/
│   ├── build.gradle.kts
│   └── src/
│       ├── main/
│       │   ├── AndroidManifest.xml
│       │   └── kotlin/im/zoia/
│       │       ├── ZoiaApp.kt
│       │       ├── auth/                 # Módulo: android-core-auth
│       │       │   ├── CredentialStore.kt # EncryptedSharedPreferences
│       │       │   ├── SessionManager.kt  # Entrar, criar conta, código, sair
│       │       │   ├── ServerUrl.kt       # https:// assumido; http só em localhost
│       │       │   └── PasswordRules.kt   # A mesma regra do servidor
│       │       ├── api/                  # Clientes HTTP (OkHttp + Retrofit)
│       │       │   ├── ZoiaApi.kt
│       │       │   └── SessionCookieJar.kt
│       │       ├── livekit/              # Módulo: android-viewer
│       │       │   ├── LiveKitRoomManager.kt
│       │       │   ├── AudioRouteController.kt # Foco de áudio e background service
│       │       │   └── BackgroundMediaService.kt
│       │       ├── ui/                   # Jetpack Compose UI
│       │       │   ├── theme/            # Cores escuras e tipografia
│       │       │   ├── auth/             # Telas de entrada e de espera pela aprovação
│       │       │   ├── room/             # Visualizador de vídeo, grade e palco
│       │       │   ├── channels/         # Seletor de canais
│       │       │   └── components/       # Player de vídeo LiveKit, controles de som
│       │       └── broadcast/            # Módulo: android-broadcaster (Fase 2)
│       │           ├── ScreenCaptureService.kt
│       │           └── StageController.kt
│       └── test/                         # Testes unitários JVM
│           └── kotlin/im/zoia/
│               ├── auth/ServerUrlTest.kt
│               ├── auth/PasswordRulesTest.kt
│               └── api/SessionCookieJarTest.kt
├── build.gradle.kts
├── settings.gradle.kts
└── gradle/
```

---

## Code Style

- Padrões oficiais Kotlin e regras de formatação `ktlint` / `detekt`.
- UI declarativa e desacoplada de lógica de rede através de ViewModels (`androidx.lifecycle.ViewModel`).
- Fluxo de dados unidirecional com Coroutines e `StateFlow`.
- Exemplo de estilo:

```kotlin
class SessionManager(
    private val api: ZoiaApi,
    private val credentialStore: CredentialStore
) {
    private val _sessionState = MutableStateFlow<SessionState>(SessionState.Initial)
    val sessionState: StateFlow<SessionState> = _sessionState.asStateFlow()

    suspend fun restoreSession(): Result<UserSession> = withContext(Dispatchers.IO) {
        val credential = credentialStore.loadCredential() 
            ?: return@withContext Result.failure(NoCredentialException())
        
        runCatching {
            val response = api.deviceSession(DeviceSessionRequest(credential))
            UserSession(id = response.id, name = response.name).also {
                _sessionState.value = SessionState.Authenticated(it)
            }
        }.onFailure { err ->
            if (err is HttpException && err.code() == 401) {
                credentialStore.clear()
                _sessionState.value = SessionState.SignedOut()
            }
        }
    }
}
```

---

## Testing Strategy

- **Testes Unitários (JVM - `testDebugUnitTest`):**
  - Endereço do servidor (`ServerUrlTest`) e regra de senha (`PasswordRulesTest`).
  - Gerenciamento de credenciais e ciclo de sessão: expiração de cookie, tratamento de 401 e revogação.
  - Lógica do Stage e seleção de áudio (Mock de participantes do LiveKit).
- **Testes de Integração / API (MockWebServer):**
  - Validação do fluxo completo de entrada (`/api/login` → `Set-Cookie` → `/api/token`).
- **Testes Manuais / Verificação em Dispositivo Real:**
  - Latência de áudio e vídeo em conexões Wi-Fi e 4G/5G.
  - Picture-in-Picture e reprodução de áudio com a tela bloqueada.

---

## Boundaries

- **Always do:**
  - Respeitar estritamente os invariantes do Zoia definidos em `AGENTS.md` (ex: tokens de conexão emitidos por `/api/token` **nunca** possuem `canPublish: true` por padrão; o servidor é o único guardião do palco).
  - Nunca persistir a senha, nem expor o `deviceCredential` em texto plano ou logs (usar `EncryptedSharedPreferences` com master key no Android Keystore).
  - Tratar revogação imediatamente (se a API retornar 401/403, limpar as credenciais e voltar para a tela de entrada).
  - Exibir visualmente o estado de múltiplos streams com opção de silenciar/mutar ou focar áudio.
- **Ask first:**
  - Alterar contratos existentes da API do servidor Node.js (a meta é manter 100% de compatibilidade retroativa com o backend atual sem necessitar de novas rotas, apenas consumindo as existentes).
  - Adicionar suporte a push notifications remotas (pois exigiria serviços terceiros como FCM e alteração no servidor).
- **Never do:**
  - Gravar logs de tokens LiveKit, senhas, credenciais de aparelho ou códigos de redefinição.
  - Burlar os limites de publicação sem transição via `/api/stage`.

---

## Success Criteria

1. **Entrada:** Um usuário Android entra com sua conta aprovada (ou cria uma e espera a aprovação) e chega à sala.
2. **Autenticação Contínua:** Fechar e reabrir o app restaura a sessão automaticamente via `/api/device/session` usando a credencial segura salva.
3. **Visualização WebRTC em Tempo Real:** Conectar ao canal padrão (ou canais criados via `/api/rooms`) e assistir a 1 ou mais streams de vídeo em tempo real (latência < 500ms) utilizando decodificação de hardware do Android.
4. **Áudio Ativo Selecionável:** Permitir alternar o áudio entre diferentes apresentadores concorrentes, com controle de volume individual.
5. **Background & PiP:** Permitir que o vídeo continue tocando em Picture-in-Picture ao sair do app e o áudio continue tocando quando a tela for desligada.

---

## Open Questions

1. **Escopo da Fase 1:** Você prefere focar a entrega inicial exclusivamente no **Viewer** (assistir, canais, áudio e PiP) antes de implementar o Broadcaster (compartilhamento de tela do Android via MediaProjection)?
2. **Distribuição do App:** Como planeja distribuir o APK do Android? (Ex: Release no GitHub com `.apk` direto para sideload, ou via Google Play / F-Droid?)
