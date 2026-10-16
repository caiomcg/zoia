# Tasks: Zoia Android Viewer Client

## Module 1: `android-core-auth`

- [x] Task 1.1: Inicializar estrutura do projeto Android em `android/` com Gradle Wrapper, AndroidX, Jetpack Compose e dependências (LiveKit SDK, OkHttp, EncryptedSharedPreferences).
  - Acceptance: Projeto compila e `./gradlew tasks` executa sem erros de configuração.
  - Verify: `./gradlew tasks`
  - Files: `android/build.gradle.kts`, `android/settings.gradle.kts`, `android/app/build.gradle.kts`, `android/app/src/main/AndroidManifest.xml`

- [x] Task 1.2: Implementar modelos de dados e parser de convite (`zoia-invite.json`).
  - Acceptance: Leitura do JSON contendo `server` e `pairingToken` com validação de formato e tratamento de erros.
  - Verify: Teste unitário em `android/app/src/test/kotlin/im/zoia/auth/InviteParserTest.kt`.
  - Files: `android/app/src/main/kotlin/im/zoia/auth/InviteParser.kt`, `android/app/src/main/kotlin/im/zoia/auth/Invite.kt`

- [x] Task 1.3: Implementar cliente HTTP com `OkHttp`, `CookieJar` persistente e endpoints de pareamento/sessão (`/api/pair` e `/api/device/session`).
  - Acceptance: Sucesso ao enviar requisições de pareamento, armazenar credencial no `EncryptedSharedPreferences` e reter cookie `zoia_session`.
  - Verify: Teste com mock ou teste de unidade de serialização e cookies.
  - Files: `android/app/src/main/kotlin/im/zoia/api/ZoiaApiClient.kt`, `android/app/src/main/kotlin/im/zoia/auth/CredentialStore.kt`, `android/app/src/main/kotlin/im/zoia/auth/SessionManager.kt`

- [x] Task 1.4: Construir UI da tela de Pareamento em Jetpack Compose com importação de arquivo.
  - Acceptance: Botão para importar convite abre o seletor nativo de arquivos do Android, processa o arquivo e transiciona de tela ao parear.
  - Verify: Visualização no Compose ou execução no tablet.
  - Files: `android/app/src/main/kotlin/im/zoia/ui/pair/PairingScreen.kt`, `android/app/src/main/kotlin/im/zoia/ui/theme/*`

---

## Module 2: `android-viewer`

- [x] Task 2.1: Implementar gerenciador de conexão com o LiveKit (`LiveKitRoomManager`) obtendo token de `/api/token`.
  - Acceptance: Obter token JWT para a sala e conectar via WebSocket ao LiveKit SFU, listando participantes e tracks.
  - Verify: Conexão bem-sucedida aos eventos de sala do LiveKit.
  - Files: `android/app/src/main/kotlin/im/zoia/livekit/LiveKitRoomManager.kt`

- [x] Task 2.2: Implementar listagem e alternância de canais (`/api/rooms`).
  - Acceptance: Consulta aos canais existentes no servidor e troca dinâmica de canal/sala.
  - Verify: Requisição para `/api/rooms` e reconexão na sala selecionada.
  - Files: `android/app/src/main/kotlin/im/zoia/ui/channels/ChannelDrawer.kt`, `android/app/src/main/kotlin/im/zoia/api/ZoiaApiClient.kt`

- [x] Task 2.3: Construir UI do visualizador de vídeo em Compose (Grade / Foco / Tela Cheia).
  - Acceptance: Renderização fluida das transmissões ativas utilizando decodificação de hardware do LiveKit.
  - Verify: Exibição correta do vídeo com redimensionamento e controles de interface.
  - Files: `android/app/src/main/kotlin/im/zoia/ui/room/RoomScreen.kt`, `android/app/src/main/kotlin/im/zoia/ui/room/StreamCard.kt`

- [x] Task 2.4: Implementar gerenciador de áudio (seleção de áudio de apresentação e controle de volume).
  - Acceptance: Apenas uma transmissão tem áudio ativo por padrão para evitar ruído concorrente; usuário pode alternar ou mutar.
  - Verify: Áudio tocando no alto-falante/fone do tablet com controle de volume.
  - Files: `android/app/src/main/kotlin/im/zoia/livekit/LiveKitRoomManager.kt`

- [x] Task 2.5: Adicionar suporte a Picture-in-Picture (PiP) e Foreground Service para áudio contínuo.
  - Acceptance: Ao sair do app para a tela inicial, entra em PiP automaticamente; ao bloquear a tela, o áudio continua ativo.
  - Verify: Teste manual no tablet com tela desligada e alternando para outros apps.
  - Files: `android/app/src/main/kotlin/im/zoia/MainActivity.kt`, `android/app/src/main/kotlin/im/zoia/livekit/BackgroundAudioService.kt`

---

## Module 3: Build & Deploy

- [x] Task 3.1: Configurar build release/debug do APK (`./gradlew assembleDebug`).
  - Acceptance: Geração do arquivo APK autônomo na pasta `android/app/build/outputs/apk/debug/app-debug.apk`.
  - Verify: Arquivo `.apk` gerado com sucesso.
  - Files: `android/app/build.gradle.kts`

- [x] Task 3.2: Instalação e teste interativo no tablet Android conectado via `adb install`.
  - Acceptance: App instalado no tablet, abrindo sem falhas e pronto para importação do convite.
  - Verify: `adb install -r app-debug.apk` e inicialização via `adb shell am start`.
