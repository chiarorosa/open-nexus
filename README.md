# 🧠 Open Nexus

<div align="center">

![Open Nexus Banner](https://img.shields.io/badge/Open%20Nexus-Intelligent%20Desktop%20Assistant-6C63FF?style=for-the-badge&logo=openai&logoColor=white)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-FFC131?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Rust](https://img.shields.io/badge/Rust-1.x-000000?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org)

**An open-source, privacy-first intelligent desktop assistant powered by Large Language Models.**

[✨ Features](#-purpose) · [🛠 Tech Stack](#-technology-stack) · [🤝 Contributing](#-contributing) · [📄 License](#-license)

---

### 🖥️ UI Preview

![Open Nexus UI Preview](https://raw.githubusercontent.com/chiarorosa/open-nexus/main/docs/preview_ptbr.png)

</div>

---

## ✨ Purpose

**Open Nexus** is a fully open-source desktop assistant designed to bring the power of Large Language Models directly to your desktop — privately, efficiently, and without locking you into any single cloud provider.

### The Problem

Modern AI assistants are powerful but come with significant trade-offs:
- **Vendor lock-in** — tied to a single provider's API and pricing model
- **Privacy concerns** — your queries and context are sent to third-party servers
- **Lack of extensibility** — closed ecosystems that resist customization
- **Heavy resource usage** — browser-based or Electron-based solutions that consume excessive RAM and CPU

### Our Solution

Open Nexus is built around three core principles:

| Principle | Description |
|-----------|-------------|
| 🔒 **Privacy First** | Your data stays on your machine. All context processing happens locally; only inference calls go upstream when needed. |
| 🔌 **Provider Agnostic** | Seamlessly switch between OpenRouter, OpenAI, Anthropic, local Ollama models, or any OpenAI-compatible endpoint. |
| 🧩 **Skill-Driven Architecture** | Extend the assistant's capabilities by writing skills — small, composable modules that can be learned, planned, and executed dynamically. |

### Key Features

- 🎙️ **Voice Input** — Speak your commands with integrated Speech-to-Text (STT)
- ⌨️ **Global Hotkey** — Summon Nexus from anywhere on your desktop instantly
- 🤖 **LLM Integration** — Connect to any LLM via OpenRouter or direct API
- 🧠 **Skill System** — Dynamic skill registry with planning, learning, and routing capabilities
- 📝 **Dictation Refinement** — AI-powered post-processing to clean up voice transcriptions
- ⚙️ **Configurable** — Persistent user settings with a clean in-app settings panel
- 🪶 **Lightweight** — Native performance thanks to Tauri's Rust backend; no Electron overhead

---

## 🛠 Technology Stack

Open Nexus is built with a modern, performant, and cross-platform stack:

### Frontend

| Technology | Version | Role |
|------------|---------|------|
| [React](https://react.dev) | 18.x | UI component framework |
| [TypeScript](https://www.typescriptlang.org) | 5.x | Strongly-typed JavaScript |
| [Vite](https://vitejs.dev) | 5.x | Lightning-fast build tool and dev server |
| CSS Modules | — | Scoped, maintainable component styles |

### Backend / Desktop Shell

| Technology | Version | Role |
|------------|---------|------|
| [Tauri](https://tauri.app) | 2.x | Rust-powered native desktop framework |
| [Rust](https://www.rust-lang.org) | 1.x | Backend commands, system integration, and IPC bridge |

### AI & Language Models

| Technology | Role |
|------------|------|
| [OpenRouter](https://openrouter.ai) | Unified API gateway to 100+ LLMs (GPT-4, Claude, Gemma, Mistral, etc.) |
| OpenAI-compatible endpoints | Direct integration with self-hosted or third-party providers |
| [Ollama](https://ollama.com) | Local LLM execution for fully offline operation |
| Web Speech API | Browser-native speech recognition for voice input |

### Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                   FRONTEND (React/TS)            │
│  ┌──────────┐  ┌────────────┐  ┌─────────────┐  │
│  │CommandBar│  │ResponseView│  │SettingsPanel│  │
│  └──────────┘  └────────────┘  └─────────────┘  │
│                                                   │
│  ┌─────────────────────────────────────────────┐ │
│  │              Services Layer                  │ │
│  │  STT → Parser → SkillRouter → LLM → Output  │ │
│  └─────────────────────────────────────────────┘ │
└──────────────────────┬──────────────────────────┘
                       │ Tauri IPC (invoke)
┌──────────────────────▼──────────────────────────┐
│                BACKEND (Rust/Tauri)              │
│   Commands · Router · System Integrations        │
└─────────────────────────────────────────────────┘
```

### Project Structure

```
open-nexus/
├── src/                    # React frontend
│   ├── components/         # UI components (CommandBar, SettingsPanel, etc.)
│   ├── services/           # Business logic (LLM, STT, SkillRouter, Parser...)
│   └── hooks/              # Custom React hooks
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── commands.rs     # Tauri command handlers
│   │   ├── router.rs       # Internal command routing
│   │   └── lib.rs          # App setup and plugin registration
│   └── tauri.conf.json     # App configuration
├── docs/                   # Project documentation
└── public/                 # Static assets
```

---

## 🤝 Contributing

Open Nexus thrives on community contributions. Whether you're fixing a bug, adding a new skill, improving docs, or suggesting a feature — **all contributions are welcome!**

### Getting Started

#### Prerequisites

Before you begin, make sure you have the following installed:

- **Node.js** ≥ 18.x — [Download](https://nodejs.org)
- **Rust & Cargo** (via rustup) — [Install](https://rustup.rs)
- **Tauri CLI** — Install with `cargo install tauri-cli`
- **Git** — [Download](https://git-scm.com)

#### Setup

```bash
# 1. Fork the repository on GitHub, then clone your fork:
git clone https://github.com/<your-username>/open-nexus.git
cd open-nexus

# 2. Install frontend dependencies:
npm install

# 3. Run in development mode (starts both Rust backend and Vite dev server):
npm run tauri dev
```

### Contribution Workflow

We follow the **GitHub Flow** branching strategy:

```
main  ←── Pull Requests  ←── feature/your-feature
                              fix/your-bugfix
                              docs/your-docs
                              skill/new-skill-name
```

#### Step-by-Step

1. **Fork** the repository and **clone** your fork locally
2. **Create a branch** with a descriptive name:
   ```bash
   git checkout -b feature/voice-language-selector
   # or
   git checkout -b fix/settings-panel-not-saving
   # or
   git checkout -b skill/open-browser-url
   ```
3. **Make your changes** — write clean, readable code with comments where needed
4. **Test your changes** thoroughly before committing
5. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/) format:
   ```bash
   git commit -m "feat: add language selector to voice input settings"
   git commit -m "fix: persist settings panel state across restarts"
   git commit -m "docs: update skill writing guide"
   ```
6. **Push** your branch to your fork:
   ```bash
   git push origin feature/voice-language-selector
   ```
7. **Open a Pull Request** against the `main` branch of this repository

### Contribution Guidelines

- **Code Style**: TypeScript strict mode is enforced; Rust code must pass `cargo clippy`
- **Commits**: Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, `skill:`)
- **PR Size**: Keep PRs focused — one feature or fix per PR
- **Tests**: Add tests for new services or skill logic where applicable
- **Documentation**: Update relevant docs if your change impacts behavior

### Writing a New Skill

Skills are the heart of Open Nexus. A skill is a composable module that the assistant can invoke dynamically. To create one:

1. Create a new skill file following the existing skill structure in `src/services/`
2. Register it in the `SkillRegistry` service
3. Add a brief description so the planner can invoke it intelligently
4. Open a PR with the prefix `skill/` in the branch name

### Reporting Issues

Found a bug or have a feature request? [Open an issue](https://github.com/chiarorosa/open-nexus/issues) and use the appropriate template. Please include:
- Your OS and version
- Steps to reproduce (for bugs)
- Expected vs. actual behavior
- Screenshots or logs if applicable

### Code of Conduct

This project is committed to providing a welcoming and inclusive environment for all contributors. Please be respectful, constructive, and collaborative in all interactions.

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

<div align="center">

Built with ❤️ by [Pablo De Chiaro Rosa](https://github.com/chiarorosa) and the open-source community.

⭐ **Star this repo** if you find it useful — it helps others discover the project!

</div>
