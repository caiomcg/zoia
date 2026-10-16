# Implementation Plan: Zoia Android Viewer Client

## Overview
Construção do cliente Android nativo para o Zoia focado 100% no papel de **Viewer** (visualizador), permitindo conectar via convite (`zoia-invite.json`), assistir a transmissões em tempo real via LiveKit SFU, trocar de canal, selecionar áudio e assistir em Picture-in-Picture (PiP).

---

## Architecture & Modules

### 1. `android-core-auth`
- **Responsabilidade:** 
  - Estrutura base Gradle + Jetpack Compose.
  - Leitura e validação de `zoia-invite.json`.
  - Pareamento do dispositivo via `POST /api/pair`.
  - Armazenamento seguro de `deviceCredential` em `EncryptedSharedPreferences`.
  - Reativação de sessão via `POST /api/device/session` e gerenciamento do cookie `zoia_session`.
  - Tela de pareamento com design escuro limpo.

### 2. `android-viewer`
- **Responsabilidade:**
  - Obtenção do token LiveKit via `POST /api/token`.
  - Integração com `io.livekit:livekit-android` para conexão com a sala WebRTC.
  - Interface em grade ou foco com renderização de vídeo acelerada por hardware (`SurfaceViewRenderer`).
  - Navegação entre canais (`GET /api/rooms`, `POST /api/rooms`).
  - Controle de áudio: reprodução de uma stream ativa por vez, volume ajustável e muting.
  - Suporte a Picture-in-Picture (PiP) e serviço de reprodução contínua em segundo plano com tela desligada.

---

## Build & Test Strategy
- Compilação via Gradle wrapper (`./gradlew assembleDebug`).
- Instalação e depuração automatizada no tablet Android via ADB (`adb install -r app-debug.apk`).
- Validação contra servidor local/remoto do Zoia com convite de teste.
