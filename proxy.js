// ============================================
// Proxy universal para AI Analytics Chat
// Soporta: Anthropic, OpenAI, Gemini, Azure OpenAI
// ============================================
// Uso:
//   node proxy.js --provider anthropic --key sk-ant-api03-... --port 3100
//   node proxy.js --provider openai    --key sk-...           --port 3100
//   node proxy.js --provider gemini    --key AIzaSy...        --port 3100
//   node proxy.js --provider azure     --key TU_KEY --azure-url https://TU-RECURSO.openai.azure.com --azure-deployment mi-gpt4 --port 3100
// ============================================

const http  = require("http");
const https = require("https");
const url   = require("url");

const args   = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };

const PROVIDER    = getArg("--provider") || "anthropic";
const API_KEY     = getArg("--key");
const PORT        = parseInt(getArg("--port") || "3100", 10);
const AZURE_URL   = getArg("--azure-url");
const AZURE_DEP   = getArg("--azure-deployment");

if (!API_KEY) {
    console.error("❌  Debes pasar --key TU_API_KEY");
    console.error("    Ejemplo: node proxy.js --provider anthropic --key sk-ant-api03-... --port 3100");
    process.exit(1);
}

const PROVIDER_CONFIGS = {
    anthropic: {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        buildHeaders: (key, bodyLen) => ({
            "Content-Type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "Content-Length": bodyLen
        })
    },
    openai: {
        hostname: "api.openai.com",
        path: "/v1/chat/completions",
        buildHeaders: (key, bodyLen) => ({
            "Content-Type": "application/json",
            "Authorization": `Bearer ${key}`,
            "Content-Length": bodyLen
        })
    },
    gemini: {
        // Gemini uses query param for auth — handled specially below
        hostname: "generativelanguage.googleapis.com",
        path: null, // dynamic
        buildHeaders: (key, bodyLen) => ({
            "Content-Type": "application/json",
            "Content-Length": bodyLen
        })
    },
    azure: {
        hostname: AZURE_URL ? url.parse(AZURE_URL).hostname : "",
        path: AZURE_DEP ? `/openai/deployments/${AZURE_DEP}/chat/completions?api-version=2024-02-01` : "",
        buildHeaders: (key, bodyLen) => ({
            "Content-Type": "application/json",
            "api-key": key,
            "Content-Length": bodyLen
        })
    }
};

const cfg = PROVIDER_CONFIGS[PROVIDER];
if (!cfg) {
    console.error(`❌  Proveedor no soportado: ${PROVIDER}. Usa: anthropic, openai, gemini, azure`);
    process.exit(1);
}

console.log(`✅  Proxy iniciado`);
console.log(`    Proveedor : ${PROVIDER}`);
console.log(`    API Key   : ${API_KEY.substring(0, 16)}...`);
console.log(`    Puerto    : ${PORT}`);
if (PROVIDER === "azure") console.log(`    Azure URL : ${AZURE_URL}\n    Deployment: ${AZURE_DEP}`);
console.log(`    Ctrl+C para detener\n`);

const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (req.method !== "POST") { res.writeHead(404); res.end(JSON.stringify({ error: "Not found" })); return; }

    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch(e) {
            res.writeHead(400); res.end(JSON.stringify({ error: { message: "Invalid JSON body" } })); return;
        }

        // Force correct model for non-azure
        if (PROVIDER === "anthropic" && !parsed.model) parsed.model = "claude-sonnet-4-20250514";
        if (PROVIDER === "openai" && !parsed.model) parsed.model = "gpt-4o";

        const finalBody = JSON.stringify(parsed);
        const bodyLen   = Buffer.byteLength(finalBody);

        // Build target path
        let targetPath = cfg.path;
        if (PROVIDER === "gemini") {
            const model = parsed.model || "gemini-1.5-pro";
            // Convert OpenAI-style messages to Gemini format if needed
            const contents = (parsed.messages || [])
                .filter(m => m.role !== "system")
                .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
            const systemMsg = (parsed.messages || []).find(m => m.role === "system");
            const geminiBody = {
                ...(systemMsg ? { system_instruction: { parts: [{ text: systemMsg.content }] } } : {}),
                contents,
                generationConfig: { maxOutputTokens: parsed.max_tokens || 1000 }
            };
            const gemFinal   = JSON.stringify(geminiBody);
            const gemLen     = Buffer.byteLength(gemFinal);
            targetPath = `/v1beta/models/${model}:generateContent?key=${API_KEY}`;

            const options = {
                hostname: cfg.hostname, path: targetPath, method: "POST",
                headers: { "Content-Type": "application/json", "Content-Length": gemLen }
            };
            forwardRequest(options, gemFinal, res, (d) => {
                // Convert Gemini response to OpenAI-compatible format
                try {
                    const gRes = JSON.parse(d);
                    const text = gRes?.candidates?.[0]?.content?.parts?.[0]?.text || "";
                    return JSON.stringify({ choices: [{ message: { content: text } }] });
                } catch(e) { return d; }
            });
            return;
        }

        const options = {
            hostname: cfg.hostname, path: targetPath, method: "POST",
            headers: cfg.buildHeaders(API_KEY, bodyLen)
        };

        console.log(`📨  ${PROVIDER} ← request (${bodyLen} bytes)`);
        forwardRequest(options, finalBody, res, null);
    });
});

function forwardRequest(options, body, res, transform) {
    const proxyReq = https.request(options, (proxyRes) => {
        let responseBody = "";
        proxyRes.on("data", chunk => responseBody += chunk);
        proxyRes.on("end", () => {
            console.log(`✅  ${PROVIDER} → ${proxyRes.statusCode}`);
            if (proxyRes.statusCode !== 200) console.error(`⚠️  ${responseBody.substring(0, 300)}`);
            const finalResponse = transform ? transform(responseBody) : responseBody;
            res.writeHead(proxyRes.statusCode, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(finalResponse);
        });
    });
    proxyReq.on("error", (e) => {
        console.error("❌  Error de red:", e.message);
        res.writeHead(502); res.end(JSON.stringify({ error: { message: e.message } }));
    });
    proxyReq.write(body);
    proxyReq.end();
}

server.listen(PORT, "127.0.0.1", () => {
    console.log(`🚀  Listo en http://localhost:${PORT}\n`);
});
