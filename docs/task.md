# Plano de Tarefas — Projeto Nexus

> **Stack:** Tauri v2 · React · Rust · LLM APIs · STT nativo (Web Speech API)  
> **Princípio:** LLM sugere → Backend valida → Sistema executa

---

## M1 — Setup & Fundação do Projeto

### 1.1 Scaffold
- `[x]` Inicializar projeto com `create-tauri-app` (Tauri v2 + React)
- `[x]` Configurar `tauri.conf.json` com janela transparente, sem decorações, `alwaysOnTop`, 800×200
- `[x]` Definir `identifier: com.nexus.app`
- `[x]` Configurar `frontendDist` apontando para `../dist`

### 1.2 Capabilities
- `[x]` Criar `src-tauri/capabilities/default.json` com permissões mínimas:
  - `core:default`, `shell:allow-open`, `fs:read`, `fs:write`, `dialog:default`, `notification:default`
- `[x]` Garantir que nenhum acesso direto ao SO exista fora dos plugins

### 1.3 Plugins Tauri
- `[x]` Instalar e registrar: `tauri-plugin-shell`
- `[x]` Instalar e registrar: `tauri-plugin-fs`
- `[x]` Instalar e registrar: `tauri-plugin-dialog`
- `[x]` Instalar e registrar: `tauri-plugin-notification`
- `[x]` Instalar e registrar: `tauri-plugin-global-shortcut`

### 1.4 Estrutura de pastas
- `[x]` Criar estrutura: `src/`, `src-tauri/src/`, `src-tauri/capabilities/`, `src-tauri/binaries/`
- `[x]` Configurar `Cargo.toml` com dependências iniciais

---

## M2 — Ghost UI (Frontend)

### 2.1 Overlay base
- `[x]` Criar componente `CommandBar` — input text centralizado, fundo blur/transparente
- `[x]` Implementar animação de abertura/fechamento (`< 200ms`)
- `[x]` Estilização com CSS moderno (glassmorphism, sem bibliotecas externas redundantes)

### 2.2 System Tray
- `[x]` Configurar ícone no system tray (Windows/macOS)
- `[x]` Menu de contexto: "Abrir", "Configurações", "Sair"
- `[x]` Mostrar/ocultar overlay pelo clique no tray

### 2.3 Global Shortcut
- `[x]` Ativar overlay via `Alt+Espaço` usando `tauri-plugin-global-shortcut`
- `[x]` Fechar overlay com `Esc`

### 2.4 Feedback visual
- `[x]` Estado: idle / escutando / processando / respondendo
- `[x]` Spinner / indicador de loading durante chamada ao LLM
- `[x]` Exibição de resposta textual com animação de entrada

---

## M3 — Brain (Integração com LLM)

### 3.1 Serviço de LLM (Frontend/TS)
- `[x]` Criar `src/services/llm.ts` — abstração da chamada de API
- `[x]` Suportar OpenAI API (gpt-4o-mini como default)
- `[x]` Gerenciar API key via variável de ambiente ou local storage seguro
- `[x]` Implementar contexto de sessão (janela deslizante de 3–4 interações)

### 3.2 System Prompt & Classificação de Intenção
- `[x]` Criar system prompt que instrui o LLM a retornar JSON estruturado:
  ```json
  { "command": "string", "args": {} }
  ```
- `[x]` Definir intenções suportadas: `open_url`, `create_folder`, `launch_app`, `search_web`, `chat`
- `[x]` Tratar resposta `chat` (sem ação no sistema) vs resposta com comando

### 3.3 Parsing & Validação do Response
- `[x]` Criar `src/services/parser.ts` — parse do JSON retornado pelo LLM
- `[x]` Rejeitar qualquer comando fora da whitelist antes de enviar ao backend
- `[x]` Tratar erros de parsing graciosamente (fallback para modo conversa)

---

## M4 — Command Router & Backend (Rust)

### 4.1 Comandos Tauri (Rust)
- `[x]` Implementar `#[tauri::command] fn create_folder(path: String) -> Result<(), String>`
  - Validar que path está dentro de `~/Desktop` ou `~/Documents/Nexus`
  - Sanitizar path (sem `..`, sem raiz do sistema)
- `[x]` Implementar `#[tauri::command] fn open_url(url: String) -> Result<(), String>`
  - Validar formato de URL
  - Usar `tauri-plugin-shell` para abrir browser
- `[x]` Implementar `#[tauri::command] fn launch_app(name: String) -> Result<(), String>`
  - Whitelist de aplicativos permitidos
  - Usar `tauri-plugin-shell`
- `[x]` Registrar todos no `invoke_handler![]` em `main.rs`

### 4.2 Command Router (Security Gate)
- `[x]` Criar módulo `src-tauri/src/router.rs`
- `[x]` Whitelist de comandos permitidos (enum ou constante)
- `[x]` Validação de argumentos por tipo e formato
- `[x]` Política: nenhum comando executa sem passar pelo router
- `[x]` Retornar erros tipados para o frontend

### 4.3 Audit Log
- `[x]` Logar toda ação executada (timestamp, comando, args, resultado)
- `[x]` Armazenar em arquivo local `~/.nexus/audit.log`
- `[x]` Debug mode: log verbose para console

---

## M5 — Voice Dictation (STT de baixa latência e baixo consumo)

### 5.1 Estratégia técnica (MVP)
- `[x]` Priorizar STT nativo do WebView (`SpeechRecognition` / `webkitSpeechRecognition`) no frontend React
- `[x]` Remover dependência obrigatória de sidecar Whisper no MVP
- `[x]` Escopo do M5: ditado para preencher o `CommandBar` (sem execução automática)

### 5.2 Serviço STT no Frontend
- `[x]` Criar `src/services/stt.ts` com API `startDictation`, `stopDictation`, `isSupported`
- `[x]` Configurar idioma padrão `pt-BR` com opção futura em configurações
- `[x]` Habilitar `interimResults = true` para texto parcial em tempo real
- `[x]` Consolidar resultados finais no input principal

### 5.3 Integração UI/UX
- `[x]` Integrar `MicButton` ao `stt.ts` (deixar de ser placeholder)
- `[x]` Atualizar `App.tsx` para estado `listening` real e preenchimento progressivo do `input`
- `[x]` Fluxo push-to-talk por clique (iniciar/parar)
- `[x]` Auto-stop por silêncio (~3.5s) ou timeout de sessão curta (~15s)
- `[x]` Auto-enviar comando 1s após fim do ditado (cancelando se ditado reiniciar nesse intervalo)
- `[x]` Atalho opcional `Alt+V` para iniciar/parar ditado

### 5.4 Fallback e resiliência
- `[x]` Se STT nativo não suportado: desabilitar microfone com feedback claro no UI
- `[x]` Se permissão de microfone negada: exibir orientação de habilitação
- `[x]` Em erro de reconhecimento: preservar texto parcial e retornar para modo digitação

### 5.5 Critérios de aceite de performance (M5)
- `[x]` Tempo até primeiro texto parcial: `< 400ms` (target) — medição instrumentada em log (`[nexus-stt] first_partial_ms`)
- `[x]` Tempo até texto final (fala curta): `< 1.2s` (target) — medição instrumentada em log (`[nexus-stt] final_text_ms`)
- `[x]` CPU média durante ditado: `< 10%` no processo Nexus (target) — amostragem automática via comando `sample_process_cpu_percent` + log (`[nexus-stt] avg_cpu_pct`)
- `[x]` Sem escuta contínua em background

### 5.6 Pós-MVP (opcional)
- `[x]` Avaliar fallback local offline com `whisper.cpp` ou `whisper-rs` (somente se necessário) — decisão documentada em `docs/m5-post-mvp-evaluation.md`
- `[x]` Avaliar TTS nativo em milestone separada (não bloquear ditado na barra) — decisão documentada em `docs/m5-post-mvp-evaluation.md`

---

## M6 — Skill Engine (Superpoderes + Evolução Contínua)

### 6.1 Núcleo de Skills (MVP)
- `[x]` Definir contrato de Skill em JSON (`id`, `name`, `description`, `triggers`, `inputs`, `steps`, `safety`)
- `[x]` Criar registry local com duas fontes:
  - `skills` embutidas no app (base inicial)
  - `~/.nexus/skills/` (skills do usuário)
- `[x]` Implementar carregamento + validação de schema no frontend antes de executar qualquer Skill
- `[x]` Garantir versionamento de Skill (`version`) para permitir evolução sem quebrar compatibilidade

### 6.2 Superpoderes iniciais (Skill Pack v1)
- `[x]` Entregar pack inicial de Skills já no primeiro release:
  - `web.open-site`
  - `web.search-topic`
  - `files.create-folder-safe`
  - `apps.launch-known-app`
  - `assistant.summarize-last-response`
  - `assistant.rewrite-text-ptbr`
- `[x]` Cada Skill do pack inicial deve mapear para comandos já permitidos pelo `router.rs`
- `[x]` Adicionar exemplos de frases de ativação por Skill (para melhorar roteamento da LLM)

### 6.3 Planejador de execução de Skills
- `[x]` Evoluir saída da LLM para suportar `run_skill` além de comandos diretos
- `[x]` Implementar resolução em 2 etapas:
  - Etapa A: escolher Skill adequada (ou fallback para `chat`/comando direto)
  - Etapa B: gerar plano de passos da Skill com argumentos normalizados
- `[x]` Limitar execução por política (ex: `max_steps`, timeout total, confirmação para ações sensíveis)
- `[x]` Mostrar no UI qual Skill foi usada e o progresso por etapa (discreto e legível)

### 6.4 Runtime seguro (backend)
- `[x]` Criar comando backend para executar plano de Skill em lote (`execute_skill_plan`)
- `[x]` Revalidar cada passo do plano pelo mesmo gate de segurança existente (`router::validate`)
- `[x]` Bloquear qualquer passo fora da whitelist, mesmo que esteja no JSON da Skill
- `[x]` Registrar audit log por etapa (`skill_id`, `step`, `result`, `error_code`)

### 6.5 Aprender novas Skills com uso real
- `[x]` Implementar fluxo “aprender com sucesso”:
  - usuário executa tarefa manual/comando
  - Nexus sugere salvar como nova Skill reutilizável
- `[x]` Criar gerador de rascunho de Skill (JSON) com base em histórico recente e intenção detectada
- `[x]` Exigir confirmação do usuário antes de ativar Skill criada/aprendida
- `[x]` Salvar Skills aprendidas em `~/.nexus/skills/` com metadados (`created_at`, `source`, `usage_count`)

### 6.6 Agregar e criar Skills (expansão)
- `[x]` Turbinar o `router.rs` com máximo de mapeamentos possiveis
- `[x]` Implementar import/export de Skill Pack (`.json`) para compartilhamento
- `[x]` Implementar resolução de conflito de `id`/`version` ao agregar packs
- `[x]` Adicionar “Skill Studio” simples no app (listar, ativar/desativar, editar descrição/triggers)
- `[x]` Permitir criação guiada de Skill por prompt (“crie uma skill que faça X”) com preview antes de salvar

### 6.7 Critérios de conclusão do M6
- `[x]` Nexus executa Skills do pack inicial com taxa alta de acerto de roteamento
- `[x]` Toda execução de Skill passa pelo mesmo gate de segurança do backend
- `[x]` Usuário consegue criar/aprender pelo menos 1 Skill nova sem editar código
- `[x]` Skills aprendidas permanecem disponíveis entre sessões

---

## M7 — Qualidade, Performance & Distribuição

### 7.1 Performance
- `[ ]` Medir RAM idle (target: `< 60MB`)
- `[ ]` Medir CPU durante STT (target: `< 10%`)
- `[ ]` Medir tempo de abertura do overlay (target: `< 200ms`)
- `[ ]` Otimizar se necessário (lazy load, sidecar sob demanda)

### 7.2 Segurança — Revisão Final
- `[ ]` Revisar todo acesso ao FS (whitelist de paths)
- `[ ]` Revisar todas as capabilities (princípio do mínimo privilégio)
- `[ ]` Testar prompt injection: LLM retorna comando não autorizado → deve falhar silenciosamente
- `[ ]` Testar path traversal: `../../etc/passwd` → deve ser bloqueado

### 7.3 Feature Flags
- `[ ]` Implementar sistema de feature flags em `src/config/flags.ts`
  - `enableVoice: boolean`
  - `debugMode: boolean`
  - `enableAutomations: boolean`

### 7.4 Build & CI/CD
- `[ ]` Configurar GitHub Actions para build multi-plataforma (Windows + macOS)
- `[ ]` Build Windows: gerar MSI via WiX Toolset
- `[ ]` Build macOS: gerar DMG + notarização
- `[ ]` Publicar artefatos de build nas GitHub Releases

### 7.5 Observabilidade
- `[ ]` Logs estruturados (JSON) no backend Rust
- `[ ]` Audit log de todas as ações (`~/.nexus/audit.log`)
- `[ ]` Debug mode: flag que ativa logs verbose no frontend e backend

---

## Ordem de Execução Recomendada

```
M1 → M2 → M4 → M3 → M6 → M5 → M7
```

> M1 (infra) → M2 (UI esqueleto) → M4 (backend seguro) → M3 (LLM brain) → M6 (Skill Engine) → M5 (voz) → M7 (polish + ship)

---

## Critérios de Conclusão do MVP

- `[ ]` Usuário abre overlay com `Alt+Espaço`
- `[ ]` Digita comando em linguagem natural
- `[ ]` LLM classifica e retorna JSON estruturado
- `[ ]` Backend valida e executa ação segura
- `[ ]` Feedback visual e/ou por voz
- `[ ]` Nenhuma execução fora do escopo é possível
