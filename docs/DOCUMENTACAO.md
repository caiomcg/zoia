# Documentacao Tecnica do Zoia

## 1. Visao Geral e Intuito

O Zoia e uma aplicacao de codigo aberto para compartilhamento de tela e transmissao de video de baixa latencia (entre 200 e 500 milissegundos) voltada para redes privadas e grupos fechados.

O projeto foi concebido para resolver uma limitacao tecnica concreta presente em navegadores modernos e em servicos comerciais de comunicacao: a impossibilidade de capturar exclusivamente o audio de um aplicativo especifico no sistema operacional Windows.

### O Problema do Audio de Aplicacoes em Navegadores

Nenhum navegador web comum disponibiliza uma API capaz de isolar o fluxo de audio de um processo individual. As APIs padrao da web (como `getDisplayMedia`) oferecem apenas duas opcoes:
1. Capturar o som de uma aba do proprio navegador.
2. Capturar o som mixado de todo o sistema operacional.

Ao transmitir o som do sistema completo, o usuario expoe notificacoes de mensagens, conversas paralelas de outros aplicativos de voz e sons de navegacao pessoal. Servicos corporativos e plataformas de videoconferencia geralmente contornam isso apenas atraves de clientes desktop nativos proprietarios ou forcam o compartilhamento sem som.

O Zoia resolve essa barreira integrando uma aplicacao desktop desenvolvida em Electron com chamadas de baixo nivel a API WASAPI (Windows Audio Session API) em modo de loopback de processo. O audio do executavel selecionado e capturado de forma isolada, em formato PCM linear S16LE a 48 kHz estereo, sem misturar com nenhum outro som do sistema.

### Principais Caracteristicas

- Isolamento acustico de processos: captura de som restrita ao identificador de processo (PID) da janela selecionada.
- Modelo de palco rotativo (Stage): qualquer participante autenticado pode reivindicar um slot de transmissao no canal ativo sem necessidade de privilegios de administrador pre-definidos.
- Topologia com SFU (Selective Forwarding Unit): o transmissor envia seu fluxo apenas uma vez para o servidor LiveKit, que replica os pacotes brutos para os espectadores conectados sem realizar transcodificacao no servidor.
- Multiplos canais independentes: suporte a ate 5 canais simultaneos por servidor, cada um operando como uma sala LiveKit isolada com seu proprio palco.
- Seguranca orientada a dispositivos: o instalador publico do software nao contem credenciais nem endereco do servidor. O pareamento e realizado mediante arquivo de convite individual, com chave criptografada via DPAPI do Windows e revogacao imediata no servidor a cada requisicao.
- Aceleracao por hardware e ingestao WHIP: pipeline opcional de codificacao em placa de video (NVIDIA NVENC, AMD AMF e Intel Quick Sync) com envio direto por WebRTC-HTTP Ingestion Protocol (WHIP) para o LiveKit SFU.
- Transicao inteligente de janelas em jogos: suporte a jogos com arquitetura multiprocesso (como League of Legends), alternando automaticamente entre a janela do inicializador e a tela da partida sem interrupcao do streaming.

---

## 2. Arquitetura do Sistema

A solucao e dividida em tres blocos principais de infraestrutura e software:

```
  CLIENTE DESKTOP (Windows)                          SERVIDOR ZOIA
┌─────────────────────────────────┐        ┌──────────────────────────────┐
│  Processo Principal (Main)      │        │  Caddy (Proxy Reverso TLS)   │
│   ├── desktopCapturer (Janelas) │        │    zoia.<dominio> -> App     │
│   ├── node-window-manager (PID) │        │    sfu.<dominio>  -> LiveKit │
│   ├── WASAPI Loopback (PCM)     │        │    Certificados: DNS-01      │
│   └── safeStorage (DPAPI)       │        └───────┬──────────────┬───────┘
│                                 │                │              │
│  Processo de Renderizacao (UI)  │                ▼              ▼
│   ├── React 19 + TypeScript     │            App Node        LiveKit
│   ├── AudioWorklet (Ring Buffer)│             :3000           :7880
│   └── livekit-client (WebRTC)   │   WSS :443     │              │
└─────────────────────────────────┘ ───────────────┘              │
                 │                                                │
                 │              Trafego UDP :7882 (Midia RTP)     │
                 └───────────────────────────────────────────────►│
                                                                  │
  ESPECTADORES (Mesmo Cliente Desktop) ◄──────────────────────────┘
```

### Componentes de Infraestrutura

1. **Caddy (Borda e Terminador TLS)**:
   - Porta publica exposta: 443 TCP.
   - Atende estritamente a dois nomes de host configurados: a aplicacao Node (`zoia.<dominio>`) e o servico de sinalizacao do SFU (`sfu.<dominio>`).
   - Obtencao e renovacao automatica de certificados TLS via desafio Cloudflare DNS-01. Nao ha necessidade de expor a porta 80 HTTP para a internet.
   - As portas de midia WebRTC nao passam pelo Caddy: os pacotes de midia trafegam diretamente para a maquina host e para o container do LiveKit.

2. **LiveKit SFU (Servidor de Midia)**:
   - Porta 7882 UDP (Mux de midia WebRTC) e porta 7881 TCP (Fallback para redes restritivas).
   - Responsavel por receber os pacotes RTP de quem esta transmitindo e distribui-los para os espectadores inscritos.
   - O servidor nao realiza transcodificacao (decodificacao e recodificacao de video). Isso mantem o uso de CPU no servidor muito baixo (geralmente abaixo de 5% a 10% mesmo com multiplos participantes), transferindo o limitador de capacidade para a taxa de upload da rede do servidor.

3. **Backend Node.js (Servico de Controle)**:
   - Executa internamente na porta 3000, alcancavel exclusivamente atraves do Caddy.
   - Implementado com Express 5 e modulos ESM nativos.
   - Gerencia autenticacao, pareamento de novos dispositivos, controle de permissoes de transmissao (palco), emissao de credenciais JWT para o LiveKit e recepcao de relatorios de erros.
   - Nao utiliza bancos de dados relacionais ou servicos externos complexos: os dados de chaves, dispositivos e pareamentos sao persistidos em arquivos JSON com operacoes atomicas de gravacao e renomeacao sob controle de mutex em memoria.

4. **Cliente Desktop (Electron 44 + React 19 + TypeScript)**:
   - Plataforma alvo: Windows x64.
   - Interface construida com React 19, componentes funcionais e suporte nativo aos idiomas portugues, ingles e espanhol.
   - Modulo C++ nativo para integracao com APIs Win32 e DirectX 11.

---

## 3. Detalhamento Tecnico dos Modulos

### Pipeline de Audio (Process Loopback WASAPI)

O audio do aplicativo e o ponto central do sistema. A captura ocorre no processo principal do Electron e e transmitida para o processo de renderizacao atraves de canais IPC:

```
WASAPI loopback           Processo Principal               Formato
 (PID da janela)   ──►   src/main/audio.ts   ──►   S16LE 48 kHz estereo
                                                            │
                                                            │ Canal IPC
                                                            ▼
  MediaStreamTrack  ◄──   AudioWorklet (Ring Buffer) ◄──   Renderer
    (Publicado)               pcm-worklet.js
```

1. **Captura no Sistema Operacional**:
   A biblioteca nativa `loopback-capture` inicializa uma sessao WASAPI vinculada ao identificador de processo (PID) da janela selecionada. O som e extraido diretamente em formato PCM puro (Signed 16-bit Little Endian) com taxa de amostragem fixa em 48 kHz estereo.

2. **Garantia de Sincronismo e Prevencao de Desvio (Drift)**:
   O `AudioContext` do navegador no processo de renderizacao e expressamente configurado com `sampleRate: 48000`. Essa configuracao impede a insercao de um reamostrador de software pelo Chromium, fator comum de perda de sincronismo entre audio e video ao longo de transmissoes longas.

3. **Tratamento de Buffer no AudioWorklet (`pcm-worklet.js`)**:
   O processamento de audio roda em uma thread dedicada do Web Audio. Um anel de buffer (ring buffer) acomoda as oscilacoes de entrega entre o processo Node e o navegador:
   - Margem de inicializacao (Priming cushion): retencao inicial de amostras para absorver variacoes de latencia no inicio da transmissao.
   - Teto maximo de latencia (Latency ceiling): caso o transmissor atrase a entrega de dados ou o sistema sofra sobrecarga temporaria, o worklet descarta os blocos mais antigos para manter o atraso estritamente delimitado, impedindo que a defasagem entre audio e video cresca indefinidamente.

4. **Regra de Seguranca para Telas Cheias**:
   Ao selecionar o compartilhamento de tela inteira (desktop), o Zoia desativa expressamente o envio de audio. Uma tela completa nao pertence a um processo unico; o unico audio possivel seria a mixagem geral do sistema operacional, violando a premissa de privacidade do software.

### Pipeline de Video e Aceleracao por Hardware (WHIP e WGC)

Por padrao, o aplicativo utiliza o codificador de video de software integrado ao Chromium. No entanto, no Windows, o Chromium nao dispoe de codificador de video acelerado por hardware para WebRTC. Em resolucoes elevadas (1080p a 60 fps ou 4K), a codificacao puramente por CPU pode sobrecarregar o processador durante jogos.

Para contornar esse obstaculo, o Zoia possui um pipeline alternativo de codificacao em GPU:

```
Janela Aberta
     │
     ▼ (Windows Graphics Capture - WGC)
Textura D3D11 na GPU
     │
     ▼ (Codificacao por Hardware)
Placas NVIDIA (NVENC) / AMD (AMF) / Intel (Quick Sync)
     │
     ▼ (Fluxo H.264 comprimido)
Processo FFmpeg interno
     │
     ▼ (HTTPS POST / Protocolo WHIP)
Caddy (sfu.<dominio>/whip/v1)
     │
     ▼ (Porta interna 7880)
LiveKit SFU ──► Encaminhamento via UDP 7882 para a sala
```

#### Medidas de Estabilidade do Pipeline de GPU (ADR 0024)

Testes em cenarios reais de jogos exigiram o desenvolvimento de mecanismos avancados de protecao:

- **Controle de Taxa de Quadros na Origem**:
  A API Windows Graphics Capture entrega quadros orientados a eventos de apresentacao do DirectX. Em jogos rodando a 144 Hz, 240 Hz ou com taxa de quadros destravada, a captura gerava centenas de quadros por segundo. Em formatos nao comprimidos (como BGRA, com ~8.3 MB por quadro em 1080p), isso esgotava a memoria heap do Node.js (V8) em poucos segundos, gerando pausas de Garbage Collection e congelamento da interface. O modulo nativo em C++ (`addon.cpp`) implementa um descarte temporal de quadros: qualquer quadro entregue antes do intervalo configurado `(1000 / fpsAlvo) - 2 ms` e descartado imediatamente na GPU antes de qualquer copia de memoria.

- **Gerenciamento de Contrapressao (Backpressure)**:
  Caso o processo do FFmpeg atrase o consumo do canal de entrada (`stdin`), buffers brutos pendentes sao descartados imediatamente, mantendo o uso de memoria estavel. No caso de fluxos ja comprimidos pelo NVENC, unidades NAL essenciais sao preservadas para evitar corrupcao de quadros de referencia (GOP).

- **Fallback Automatico e Atomico**:
  Caso ocorra falha na inicializacao do encoder da GPU ou na negociacao WHIP, o cliente transfere a transmissao automaticamente para o modo de captura tradicional por CPU mantendo o slot do palco previamente reservado, sem que a sessao caia ou exiba mensagens de erro impeditivas para o usuario.

### Transicao Inteligente em Jogos: Caso League of Legends

Jogos como League of Legends utilizam processos separados para o cliente de navegacao/selecao de campeoes e para a partida propriamente dita:
- O cliente de lobby e selecao de campeoes roda sobre Chromium Embedded Framework com o executavel `LeagueClientUx.exe`.
- A partida roda em tela cheia atraves de `League of Legends.exe`.

O modulo `league.ts` e o processo de captura do Zoia implementam deteccao de processos em tempo real:
1. Ao transmitir League of Legends, o sistema monitora ambos os executaveis.
2. Quando a partida comeca, a captura de video e o audio WASAPI migram automaticamente para a janela do jogo (`League of Legends.exe`).
3. Quando a partida termina e a janela do jogo fecha, o Zoia entra em uma janela de espera de ate 7.5 segundos enquanto a janela do inicializador e recriada pelo sistema, reconectando o video e o audio ao lobby sem encerrar a transmissao.

---

## 4. Modelo de Seguranca e Controle de Acesso

O Zoia opera sob um modelo de seguranca defensivo, projetado para evitar acessos indesejados sem a sobrecarga de criacao de contas com login e senha convencionais.

### Invariantes de Seguranca Fundamentais

1. **Tokens de Conexao Sempre Somente Leitura**:
   Todo token JWT emitido pela rota `/api/token` possui obrigatoriamente a permissao `canPublish: false`. Ninguem que entra em uma sala tem permissao de transmitir por padrao.

2. **Permissao de Publicacao Concedida Apenas no Servidor**:
   A capacidade de publicar video ou audio e liberada exclusivamente via API de backend (`stage.claim()`), que invoca o metodo `updateParticipant` do LiveKit Server SDK. Modificacoes locais no codigo JavaScript do cliente nao conseguem burlar essa restricao, pois o SFU valida as permissoes criptograficas de cada pacote RTP no nivel do protocolo.

3. **Estado de Transmissao Derivado**:
   O status de quem esta no palco e consultado dinamicamente a partir da lista de participantes ativos no SFU, em vez de ser mantido em variaveis estaticas na memoria do backend. Se um transmissor perder a conexao de internet ou fechar o computador repentinamente, o LiveKit detecta a desconexao e o slot e liberado de forma limpa para outro participante.

4. **Credenciais Fora do Binario Publico**:
   O arquivo de instalacao `.exe` distribuido nos lancamentos publicos do GitHub e identico para todos os usuarios e nao contem enderecos de servidores nem senhas.

### Fluxo de Pareamento de Dispositivos (Device Pairing)

```
Administrador                        Novo Usuario                      Servidor Zoia
     │                                    │                                  │
     │  keytool pair:new                  │                                  │
     ├───────────────────────────────────►│                                  │
     │  (Gera zoia-invite.json)           │                                  │
     │                                    │  Arrasta convite no app          │
     │                                    ├─────────────────────────────────►│ POST /api/pair
     │                                    │                                  │ (Consome ativacao)
     │                                    │◄─────────────────────────────────┤ Retorna credencial
     │                                    │                                  │ do dispositivo
     │                                    │  Armazena via DPAPI local        │
     │                                    │                                  │
     │                                    │  Inicializacao do app            │
     │                                    ├─────────────────────────────────►│ POST /api/device/session
     │                                    │◄─────────────────────────────────┤ Cookie assinado
     │                                    │                                  │ zoia_sid (device:<id>)
```

1. O administrador gera um arquivo `zoia-invite.json` com um limite maximo de ativacoes simultaneas (`--max-activations`).
2. O arquivo contem apenas a URL do servidor e um token descartavel de pareamento (`zpair_...`).
3. Ao abrir o aplicativo pela primeira vez, o usuario importa esse arquivo. O aplicativo envia o token para a rota `/api/pair`.
4. O servidor consome a ativacao e retorna uma credencial de dispositivo gerada aleatoriamente com 256 bits de entropia.
5. O aplicativo cliente armazena essa credencial no cofre de senhas do sistema operacional atraves do `safeStorage` do Electron (que utiliza a API DPAPI nativa do Windows).
6. Nas sessoes subsequentes, o cliente apresenta essa credencial para a rota `/api/device/session` e recebe um cookie assinado contendo apenas o identificador publico do dispositivo (`device:<id>`).

### Revogacao Imediata de Acesso

O cookie de sessao contem apenas o identificador do dispositivo ou chave. A cada requisicao recebida pelo backend, o identificador e consultado no arquivo de registros em disco.
- Ao executar a revogacao de um dispositivo no servidor via CLI, o bloqueio entra em vigor imediatamente na proxima requisicao HTTP, sem necessidade de aguardar o vencimento do cookie.
- Existem dois niveis de corte:
  1. Revogacao do token de convite (`pair:revoke`): impede que novas maquinas realizem o pareamento. Dispositivos ja autorizados continuam operando normalmente.
  2. Revogacao do dispositivo (`device:revoke`): desconecta e bloqueia uma maquina especifica imediatamente.

---

## 5. Guia de Instalacao e Operacao do Servidor

### Requisitos de Infraestrutura

- Servidor Linux (Ubuntu 22.04 LTS ou superior recomendado), com no minimo 2 vCPUs e 2 GB de memoria RAM.
- Docker Engine com Docker Compose v2 ou superior.
- Dominio configurado no Cloudflare (necessario para a geracao automatica de certificados TLS via desafio DNS).
- IP publico (estatico ou com servico de DNS dinamico atualizado).
- Portas liberadas e encaminhadas no roteador de borda ou firewall:
  - `443` TCP: Acesso HTTPS / WSS unificado via Caddy.
  - `7882` UDP: Trafego de midia WebRTC (obrigatorio para funcionamento de video e audio).
  - `7881` TCP: Fallback de WebRTC sobre TCP para redes corporativas com bloqueio de UDP.

### Passo 1: Configuracao de DNS no Cloudflare

Crie dois registros do tipo `A` apontando para o IP publico do seu servidor:
- `zoia.seudominio.com`
- `sfu.seudominio.com`

**Regra Obrigatoria**: ambos os registros devem estar configurados com o status **DNS Only (Nuvem Cinza)**. O proxy da rede Cloudflare (Nuvem Laranja) nao suporta transmissao de midia via protocolo WebRTC UDP e adiciona latencia na conexao WebSocket de sinalizacao.

### Passo 2: Token de API do Cloudflare

Gere um token de API no painel do Cloudflare:
1. Acesse: *Perfil > Tokens de API > Criar Token*.
2. Selecione o modelo *Editar DNS da zona*.
3. Defina as permissoes: `Zona > DNS > Editar`.
4. Em *Recursos de Zona*, restrinja para a zona do seu dominio.
5. Guarde o valor do token gerado.

### Passo 3: Configuracao do Projeto e Ambiente

Clone o repositorio no servidor:

```bash
git clone https://github.com/caiomcg/zoia.git /opt/zoia
cd /opt/zoia
```

Gere o arquivo de ambiente `.env` utilizando o script automatizado:

```bash
./scripts/gen-env.sh zoia.seudominio.com sfu.seudominio.com > .env
chmod 600 .env
```

Abra o arquivo `.env` e preencha a variavel `CLOUDFLARE_API_TOKEN` com o token gerado no passo anterior:

```ini
CLOUDFLARE_API_TOKEN=seu_token_aqui
```

### Passo 4: Inicializacao dos Containers

Suba os servicos via Docker Compose:

```bash
docker compose up -d
```

Execute o teste de pre-voo para verificar a integridade da instalacao:

```bash
bash scripts/preflight.sh
```

O script confirmara a resolucao correta de DNS, o funcionamento dos certificados e a resposta dos containers.

### Passo 5: Geracao de Convites

Para permitir que usuarios se conectem, gere um arquivo de convite:

```bash
docker compose exec app node server/bin/keytool.js \
  pair:new --name "amigos" --max-activations 5 --invite zoia-invite.json
```

O comando criara o arquivo `zoia-invite.json`. Envie esse arquivo de forma privada para os usuarios autorizados.

---

## 6. Guia do Usuario Final (Cliente Desktop)

### Requisitos do Sistema

- Sistema Operacional: Windows 10 ou Windows 11 (64-bit).
- Dispositivo de audio compativel com WASAPI.

### Primeiro Uso

1. Baixe o instalador mais recente (`Zoia-Setup-x.x.x-x64.exe`) na secao de Releases do repositorio.
2. Execute o instalador (por nao possuir certificado comercial assinado, confirme o aviso inicial do SmartScreen clicando em "Mais informacoes" e depois em "Executar assim mesmo").
3. Na tela inicial de boas-vindas, arraste o arquivo `zoia-invite.json` recebido do administrador ou clique para seleciona-lo no disco.
4. O aplicativo realizara o pareamento automatico com o servidor e salvara a credencial no cofre seguro do Windows.

### Transmitindo Conteudo

1. Escolha o canal desejado no menu lateral.
2. Clique no botao de compartilhamento para abrir o seletor de fontes.
3. Escolha entre:
   - **Janela de Aplicativo**: captura a janela visual e transmite o audio exclusivo daquele processo.
   - **Tela Inteira**: captura a area de trabalho completa (sem audio, preservando sua privacidade).
   - **Camera**: transmite sua webcam acompanhada do microfone selecionado com medidor de volume previo.
4. Para jogos com processos duplos (como League of Legends), basta clicar no banner dedicado "Transmitir LoL"; o Zoia sincronizara as janelas e os audios da partida e do lobby de forma automatica.

### Assistindo Transmissoes

- Multiplas pessoas podem transmitir ao mesmo tempo no mesmo canal.
- Cada espectador pode selecionar quais telas deseja expandir ou focar.
- Para evitar sobreposicao sonora confusa, apenas uma transmissao de audio permanece ativa por padrao. O espectador pode alternar qual transmissao deseja ouvir ou ajustar volumes individuais diretamente no reprodutor de cada tela.

---

## 7. Referencia de Comandos Administrativos (Keytool)

O utilitario `server/bin/keytool.js` permite gerenciar acessos diretamente no servidor:

```bash
# Listar convites de pareamento ativos e uso de assentos
docker compose exec app node server/bin/keytool.js pair:list

# Criar novo convite com limite de assentos
docker compose exec app node server/bin/keytool.js pair:new --name "TimeAlpha" --max-activations 3 --invite convite.json

# Revogar um convite existente (impede novos pareamentos)
docker compose exec app node server/bin/keytool.js pair:revoke <pairingId>

# Listar todos os dispositivos autorizados e a data do ultimo acesso (lastSeen)
docker compose exec app node server/bin/keytool.js device:list

# Revogar imediatamente o acesso de um dispositivo especifico
docker compose exec app node server/bin/keytool.js device:revoke <deviceId>
```

---

## 8. Destaques de Engenharia para Apresentacao Profissional

Caso queira compartilhar a construcao deste projeto no LinkedIn, em artigos tecnicos ou no seu portfolio, os seguintes topicos demonstram escolhas maduras de engenharia de software e arquitetura de sistemas:

1. **Resolucao do Gargalo de Audio por Processo no Windows**:
   - Explicacao de como a combinacao de Win32, WASAPI Loopback e AudioWorklet no Electron contornou uma limitacao historica de aplicacoes web, garantindo audio cristalino de jogos ou programas sem vazamento de notificacoes pessoais.

2. **Topologia de Midia em Tempo Real (SFU vs Mesh vs MCU)**:
   - Demonstracao pratica do calculo de largura de banda residencial: por que redes P2P Mesh saturam conexoes domesticas e como um SFU sem transcodificacao permite transmissao em alta definicao com consumo insignificante de processamento no servidor.

3. **Arquitetura Zero Trust em Transmissoes WebRTC**:
   - A decisao de arquitetura onde nenhum cliente recebe tokens de publicacao por padrao. As permissoes sao elevadas dinamicamente no SFU por requisicoes assinadas de backend, tornando inviavel a violacao de permissoes atraves de inspecao de codigo no cliente.

4. **Tratamento de Contrapressao e Aceleracao Grafica com FFmpeg e WHIP**:
   - O desenvolvimento de salvaguardas para telas com altas taxas de atualizacao (144Hz a 240Hz), evitando esgotamento de memoria na engine V8 do Node.js atraves de descarte temporal de quadros em nivel C++/DirectX 11 e adaptacao dinamica ao buffer VBV do FFmpeg.

5. **Infraestrutura Enxuta e Imutavel**:
   - Uso eficiente do Caddy com certificados via DNS-01, eliminando a exposicao desnecessaria da porta 80 HTTP, e persistencia atomica em disco via padrao write-then-rename, garantindo resiliencia operacional sem a complexidade de manter bancos de dados externos para dados pequenos de autenticacao.
