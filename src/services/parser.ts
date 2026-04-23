// parser.ts — LLM response parser & command validator
// Enforces the Command Contract defined in TECHNICAL_SCOPE §9.
// This is the FRONTEND whitelist — the backend router (router.rs) is the final authority.

// ── Command types ──────────────────────────────────────────────────────────

export type NexusCommand =
  | { command: "open_url";      args: { url: string };    display?: string }
  | { command: "search_web";    args: { query: string };  display?: string }
  | { command: "create_folder"; args: { path: string };   display?: string }
  | { command: "launch_app";    args: { name: string };   display?: string }
  | { command: "run_skill";     args: { skill_id: string; inputs: Record<string, string | number | boolean> }; display?: string }
  | { command: "chat";          args: { message: string }; display?: string };

export type CommandName = NexusCommand["command"];

// Exhaustive list — must match router.rs ALLOWED_COMMANDS when M4 commands are unlocked
const ALLOWED_COMMANDS: CommandName[] = [
  "open_url",
  "search_web",
  "create_folder",
  "launch_app",
  "run_skill",
  "chat",
];

// ── Parsers ────────────────────────────────────────────────────────────────

/**
 * Extracts and validates the JSON command from an LLM response string.
 * LLMs sometimes wrap JSON in markdown code fences or add surrounding text,
 * so we use a regex to find the JSON object within the response.
 *
 * Falls back to a "chat" command on any parsing failure so the user
 * always sees a response rather than a silent error.
 */
export function parseLLMResponse(raw: string): NexusCommand {
  // Step 1: strip markdown code fences if present
  const stripped = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // Step 2: find the outermost JSON object
  const jsonMatch = stripped.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return chatFallback(raw);
  }

  // Step 3: parse JSON
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return chatFallback(raw);
  }

  // Step 4: validate command name against whitelist
  const cmd = parsed.command as string | undefined;
  if (!cmd || !ALLOWED_COMMANDS.includes(cmd as CommandName)) {
    console.warn("[parser] Rejected unknown command:", cmd);
    return chatFallback(
      (parsed.display as string) ?? "Não entendi. Pode reformular?"
    );
  }

  // Step 5: validate required args per command
  const args = (parsed.args ?? {}) as Record<string, unknown>;
  const validationError = validateArgs(cmd as CommandName, args);
  if (validationError) {
    console.warn("[parser] Arg validation failed:", validationError);
    return chatFallback(`Argumento inválido para "${cmd}": ${validationError}`);
  }

  return {
    command: cmd as CommandName,
    args: args as never,
    display: parsed.display as string | undefined,
  } as NexusCommand;
}

/** Returns a human-readable description of what a command will do. */
export function describeCommand(cmd: NexusCommand): string {
  if (cmd.display) return cmd.display;
  switch (cmd.command) {
    case "open_url":      return `Abrindo ${cmd.args.url}`;
    case "search_web":    return `Pesquisando: ${cmd.args.query}`;
    case "create_folder": return `Criando pasta: ${cmd.args.path}`;
    case "launch_app":    return `Abrindo ${cmd.args.name}`;
    case "run_skill":     return `Executando skill: ${cmd.args.skill_id}`;
    case "chat":          return cmd.args.message;
  }
}

// ── Internals ──────────────────────────────────────────────────────────────

function chatFallback(message: string): NexusCommand {
  return { command: "chat", args: { message } };
}

function validateArgs(
  command: CommandName,
  args: Record<string, unknown>
): string | null {
  switch (command) {
    case "open_url":
      if (typeof args.url !== "string" || !args.url.startsWith("http"))
        return "url deve ser uma string começando com http";
      return null;
    case "search_web":
      if (typeof args.query !== "string" || !args.query.trim())
        return "query não pode ser vazia";
      return null;
    case "create_folder":
      if (typeof args.path !== "string" || !args.path.trim())
        return "path não pode ser vazio";
      return null;
    case "launch_app":
      if (typeof args.name !== "string" || !args.name.trim())
        return "name não pode ser vazio";
      return null;
    case "run_skill":
      if (typeof args.skill_id !== "string" || !args.skill_id.trim())
        return "skill_id não pode ser vazio";
      if (!args.inputs || typeof args.inputs !== "object" || Array.isArray(args.inputs))
        return "inputs deve ser objeto";
      for (const [key, value] of Object.entries(args.inputs as Record<string, unknown>)) {
        const type = typeof value;
        if (type !== "string" && type !== "number" && type !== "boolean") {
          return `inputs.${key} deve ser string, number ou boolean`;
        }
      }
      return null;
    case "chat":
      if (typeof args.message !== "string")
        return "message deve ser uma string";
      return null;
  }
}
