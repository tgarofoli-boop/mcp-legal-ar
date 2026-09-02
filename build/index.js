import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { spawn, execSync } from "child_process";
import * as readline from "readline";
import * as path from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// FIX BUG 1: Rutas relativas al propio archivo, no a ~/legal-hub hardcodeado.
// Funciona independientemente de donde estÃ© instalado el repo.
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");                     // raiz del repo
const LEGAL_MCP = path.join(ROOT, "servers", "legal-mcp");
const SAIJ_DIR  = path.join(ROOT, "servers", "saij-mcp");
// FIX: resolveNode con fallback via where/which (compatibilidad nvm/fnm/Claude Desktop)
function resolveNode() {
    if (process.platform === "win32") {
        try { return execSync("where node", { encoding: "utf8" }).split("\n")[0].trim(); } catch {}
    } else {
        try { return execSync("which node", { encoding: "utf8" }).trim(); } catch {}
    }
    return process.execPath;
}
const NODE = resolveNode();

// ---------------------------------------------------------------------------
// FIX BUG 6: Todos los conectores heredan NODE_TLS_REJECT_UNAUTHORIZED=0
// para uniformidad. SCBA y SAIJ tambiÃ©n lo necesitan.
// ---------------------------------------------------------------------------
const TLS_ENV = { NODE_TLS_REJECT_UNAUTHORIZED: "0" };

// ---------------------------------------------------------------------------
// Timeouts por conector (ms). SCBA y pjnjuris hacen scraping pesado.
// FIX BUG 4: timeouts diferenciados en lugar de 15 s fijo para todos.
// ---------------------------------------------------------------------------
const TIMEOUTS = {
    default:  20000,
    scba:     60000,
    pjnjuris: 60000,
    pjn:      30000,
    saij:     30000,
};

// ---------------------------------------------------------------------------
// FIX BUG 7: Evitar nombres dobles como saij__saij_search_*
// Solo stripear el prefijo con doble guiÃ³n bajo (tÃ©cnico).
// NO stripear prefijo con guiÃ³n simple: algunos conectores como SAIJ usan
// saij_search_* como nombre semÃ¡ntico propio, no como prefijo tÃ©cnico.
// Ejemplo correcto: saij__saij_search_jurisprudencia -> saij_search_jurisprudencia
// Ejemplo incorrecto anterior: saij__search_jurisprudencia (rompÃ­a el callTool)
// ---------------------------------------------------------------------------
function stripInternalPrefix(prefix, toolName) {
    const techPrefix = `${prefix}__`;
    if (toolName.startsWith(techPrefix)) return toolName.slice(techPrefix.length);
    return toolName;
}

const CONNECTORS = [
    { prefix: "bora",         command: NODE, args: [path.join(LEGAL_MCP, "build", "bora.js")],         cwd: LEGAL_MCP, env: TLS_ENV },
    { prefix: "bopba",        command: NODE, args: [path.join(LEGAL_MCP, "build", "bopba.js")],        cwd: LEGAL_MCP, env: TLS_ENV },
    { prefix: "infoleg",      command: NODE, args: [path.join(LEGAL_MCP, "build", "infoleg.js")],      cwd: LEGAL_MCP, env: TLS_ENV },
    { prefix: "normativapba", command: NODE, args: [path.join(LEGAL_MCP, "build", "normativapba.js")], cwd: LEGAL_MCP, env: TLS_ENV },
    { prefix: "juba",         command: NODE, args: [path.join(LEGAL_MCP, "build", "juba.js")],         cwd: LEGAL_MCP, env: TLS_ENV },
    { prefix: "pjn",      command: NODE, args: [path.join(LEGAL_MCP, "build", "pjn.js")],      cwd: LEGAL_MCP, env: TLS_ENV },
    { prefix: "pjnjuris", command: NODE, args: [path.join(LEGAL_MCP, "build", "pjnjuris.js")], cwd: LEGAL_MCP, env: TLS_ENV },
    { prefix: "ptn",          command: NODE, args: [path.join(LEGAL_MCP, "build", "ptn.js")],          cwd: LEGAL_MCP, env: TLS_ENV },
    { prefix: "tfn",          command: NODE, args: [path.join(LEGAL_MCP, "build", "tfn.js")],          cwd: LEGAL_MCP, env: TLS_ENV },
    { prefix: "saij", command: NODE, args: [path.join(LEGAL_MCP, "build", "saij.js")], cwd: LEGAL_MCP, env: TLS_ENV },
    { prefix: "scba",         command: NODE, args: [path.join(LEGAL_MCP, "build", "scba.js")],         cwd: LEGAL_MCP, env: TLS_ENV },
];

class ChildMcpClient {
    prefix;
    proc;
    rl;
    pending = new Map();
    idCounter = 1;
    tools = [];
    ready = false;
    // FIX BUG 5: flag para saber si el proceso muriÃ³ en runtime
    dead = false;

    constructor(prefix, config) {
        this.prefix = prefix;
        const env = { ...process.env, ...(config.env ?? {}) };
        this.proc = spawn(config.command, config.args, {
            cwd: config.cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.rl = readline.createInterface({ input: this.proc.stdout });
        this.rl.on("line", (line) => {
            line = line.trim();
            if (!line) return;
            try {
                const msg = JSON.parse(line);
                if (msg.id !== undefined) {
                    const pending = this.pending.get(msg.id);
                    if (pending) {
                        this.pending.delete(msg.id);
                        if (msg.error) {
                            pending.reject(new Error(`[${this.prefix}] ${msg.error.message} (code ${msg.error.code})`));
                        } else {
                            pending.resolve(msg.result);
                        }
                    }
                }
            } catch {
                // linea no JSON - ignorar
            }
        });
        this.proc.stderr?.on("data", (d) => {
            const txt = d.toString().trim();
            if (txt) process.stderr.write(`[${this.prefix}] ${txt}\n`);
        });
        // FIX BUG 5: marcar como muerto y limpiar pendientes en lugar de dejarlos colgados
        this.proc.on("exit", (code) => {
            this.dead = true;
            this.ready = false;
            process.stderr.write(`[${this.prefix}] proceso terminado (code ${code})\n`);
            // Rechazar todos los pendientes para que no queden esperando timeout
            for (const [id, p] of this.pending) {
                p.reject(new Error(`[${this.prefix}] proceso terminado inesperadamente (code ${code})`));
            }
            this.pending.clear();
        });
    }

    send(method, params, timeoutMs) {
        // FIX BUG 5: rechazar inmediatamente si el proceso ya muriÃ³
        if (this.dead) {
            return Promise.reject(new Error(`[${this.prefix}] conector no disponible (proceso terminado)`));
        }
        const ms = timeoutMs ?? TIMEOUTS.default;
        return new Promise((resolve, reject) => {
            const id = this.idCounter++;
            const req = { jsonrpc: "2.0", id, method, params: params ?? {} };
            this.pending.set(id, { resolve, reject });
            try {
                this.proc.stdin.write(JSON.stringify(req) + "\n");
            } catch (e) {
                this.pending.delete(id);
                reject(e);
                return;
            }
            // FIX BUG 4: usar el timeout configurado por conector
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`[${this.prefix}] timeout (${ms}ms) en ${method}`));
                }
            }, ms);
        });
    }

    notify(method, params) {
        const msg = { jsonrpc: "2.0", method, params: params ?? {} };
        try {
            this.proc.stdin.write(JSON.stringify(msg) + "\n");
        } catch {
            // ignorar errores en notificaciones
        }
    }

    async initialize() {
        await this.send("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            clientInfo: { name: "mcp-legal-ar-proxy", version: "2.1.0" },
        }, 20000);
        this.notify("notifications/initialized");
        const result = (await this.send("tools/list", {}, 15000));
        this.tools = (result.tools ?? []).map((t) => ({
            ...t,
            name: `${this.prefix}__${stripInternalPrefix(this.prefix, t.name)}`,
        }));
        this.ready = true;
        process.stderr.write(`[${this.prefix}] ok - ${this.tools.length} tools\n`);
    }

    async callTool(prefixedName, args) {
        // FIX BUG 5: verificar que el proceso siga vivo antes de intentar la llamada
        if (this.dead) {
            throw new Error(`[${this.prefix}] conector no disponible (proceso terminado)`);
        }
        const originalName = prefixedName.slice(`${this.prefix}__`.length);
        // FIX BUG 4: usar timeout especÃ­fico para este conector
        const ms = TIMEOUTS[this.prefix] ?? TIMEOUTS.default;
        return this.send("tools/call", { name: originalName, arguments: args }, ms);
    }

    kill() {
        this.proc.kill();
    }
}

// ---------------------------------------------------------------------------
// Servidor principal
// ---------------------------------------------------------------------------
async function main() {
    const server = new Server(
        { name: "mcp-legal-ar", version: "2.1.0" },
        { capabilities: { tools: {} } }
    );

    process.stderr.write("[mcp-legal-ar] iniciando conectores...\n");
    process.stderr.write(`[mcp-legal-ar] ROOT: ${ROOT}\n`);

    const clients = [];
    await Promise.allSettled(
        CONNECTORS.map(async (cfg) => {
            const client = new ChildMcpClient(cfg.prefix, cfg);
            try {
                await client.initialize();
                clients.push(client);
            } catch (e) {
                process.stderr.write(`[${cfg.prefix}] ERROR al inicializar: ${e.message}\n`);
            }
        })
    );

    const toolMap = new Map();
    const allTools = [];
    for (const client of clients) {
        for (const tool of client.tools) {
            toolMap.set(tool.name, client);
            allTools.push(tool);
        }
    }

    process.stderr.write(`[mcp-legal-ar] listo - ${clients.length} conectores, ${allTools.length} tools totales\n`);

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: allTools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args = {} } = request.params;

        const client = toolMap.get(name);
        if (!client) {
            return {
                content: [{ type: "text", text: `Tool "${name}" no encontrada en legal-hub.` }],
                isError: true,
            };
        }

        // FIX BUG 5: verificar liveness antes de llamar
        if (client.dead) {
            return {
                content: [{ type: "text", text: `[${client.prefix}] conector no disponible. El proceso hijo terminÃ³ inesperadamente.` }],
                isError: true,
            };
        }

        try {
            const result = await client.callTool(name, args);
            if (result && typeof result === "object" && "content" in result) {
                return result;
            }
            return {
                content: [
                    {
                        type: "text",
                        text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
                    },
                ],
            };
        } catch (e) {
            return {
                content: [{ type: "text", text: `Error: ${e.message}` }],
                isError: true,
            };
        }
    });

    process.on("SIGINT", () => {
        clients.forEach((c) => c.kill());
        process.exit(0);
    });
    process.on("SIGTERM", () => {
        clients.forEach((c) => c.kill());
        process.exit(0);
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write("[mcp-legal-ar] conectado y escuchando\n");
}

main().catch((e) => {
    process.stderr.write(`[mcp-legal-ar] error fatal: ${e.message}\n`);
    process.exit(1);
});

