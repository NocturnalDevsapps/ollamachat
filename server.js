const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3001);
const MAX_PORT_ATTEMPTS = Number(process.env.MAX_PORT_ATTEMPTS || 10);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 0);
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://n8nwebhook.bukamdotcom.click/webhook/c751b7eb-8ee8-4b2a-9520-cc81319af756';
const FALLBACK_WEBHOOK_URL = process.env.FALLBACK_WEBHOOK_URL || '';
const ROOT_DIR = __dirname;
const SHOULD_AUTO_SELECT_PORT = !process.env.PORT;

let activePort = PORT;

const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8'
};

function getWebhookCandidates() {
    return [...new Set([WEBHOOK_URL, FALLBACK_WEBHOOK_URL].filter(Boolean))];
}

function getBaseUrl(request) {
    return `http://${request.headers.host || `${HOST}:${activePort}`}`;
}

function setCorsHeaders(response) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendText(response, statusCode, body) {
    setCorsHeaders(response);
    response.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8'
    });
    response.end(body);
}

function sendFile(response, filePath) {
    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            sendText(response, 404, 'Not found');
            return;
        }

        setCorsHeaders(response);
        response.writeHead(200, {
            'Content-Type': contentType
        });
        response.end(content);
    });
}

function buildWebhookErrorMessage(statusCode, responseBody) {
    const normalizedBody = responseBody.toLowerCase();

    if (
        statusCode === 404 &&
        normalizedBody.includes('webhook') &&
        normalizedBody.includes('not registered')
    ) {
        return 'Your n8n webhook is not active. Activate the workflow for the production URL, or click "Execute workflow" before using the test URL.';
    }

    return responseBody || `Webhook request failed with status ${statusCode}`;
}

function detectWorkflowSetupIssue(responseBody) {
    try {
        const parsedBody = JSON.parse(responseBody);
        const items = Array.isArray(parsedBody) ? parsedBody : [parsedBody];

        const isPreparedOllamaRequest = items.some(item => {
            if (!item || typeof item !== 'object') {
                return false;
            }

            const candidate = item.json && typeof item.json === 'object'
                ? item.json
                : item;

            return Boolean(candidate.ollamaUrl && candidate.ollamaBody);
        });

        if (isPreparedOllamaRequest) {
            return 'Your n8n webhook is returning the Code node payload instead of the Ollama reply. Add an HTTP Request node after the Code node, then have Respond to Webhook return the HTTP Request node output.';
        }
    } catch (error) {
        return '';
    }

    return '';
}

function readRequestBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];

        request.on('data', chunk => {
            chunks.push(chunk);
        });

        request.on('end', () => {
            resolve(Buffer.concat(chunks).toString('utf8'));
        });

        request.on('error', reject);
    });
}

async function proxyWebhookRequest(requestBody) {
    let parsedBody;

    try {
        parsedBody = JSON.parse(requestBody);
    } catch (error) {
        return {
            statusCode: 400,
            contentType: 'text/plain; charset=utf-8',
            body: 'Invalid JSON payload.'
        };
    }

    const webhookCandidates = getWebhookCandidates();

    for (let index = 0; index < webhookCandidates.length; index += 1) {
        const webhookUrl = webhookCandidates[index];
        const controller = new AbortController();
        const timeoutId = REQUEST_TIMEOUT_MS > 0
            ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
            : null;

        try {
            const webhookResponse = await fetch(webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/plain, */*'
                },
                body: JSON.stringify(parsedBody),
                signal: controller.signal
            });

            const responseBody = await webhookResponse.text();
            const trimmedResponseBody = responseBody.trim();

            if (!webhookResponse.ok) {
                const isLastCandidate = index === webhookCandidates.length - 1;

                if (webhookResponse.status === 404 && !isLastCandidate) {
                    continue;
                }

                return {
                    statusCode: webhookResponse.status,
                    contentType: 'text/plain; charset=utf-8',
                    body: buildWebhookErrorMessage(webhookResponse.status, trimmedResponseBody)
                };
            }

            if (!trimmedResponseBody) {
                return {
                    statusCode: 502,
                    contentType: 'text/plain; charset=utf-8',
                    body: 'Your n8n webhook returned 200 OK but no response body. Add a Respond to Webhook step that returns the Ollama reply text.'
                };
            }

            const workflowSetupIssue = detectWorkflowSetupIssue(trimmedResponseBody);

            if (workflowSetupIssue) {
                return {
                    statusCode: 502,
                    contentType: 'text/plain; charset=utf-8',
                    body: workflowSetupIssue
                };
            }

            return {
                statusCode: 200,
                contentType: webhookResponse.headers.get('content-type') || 'text/plain; charset=utf-8',
                body: responseBody
            };
        } catch (error) {
            if (error.name === 'AbortError') {
                return {
                    statusCode: 504,
                    contentType: 'text/plain; charset=utf-8',
                    body: 'The webhook request timed out. Increase REQUEST_TIMEOUT_MS or set it to 0 to disable the timeout.'
                };
            }

            return {
                statusCode: 502,
                contentType: 'text/plain; charset=utf-8',
                body: `Unable to reach the webhook: ${error.message}`
            };
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        }
    }

    return {
        statusCode: 502,
        contentType: 'text/plain; charset=utf-8',
        body: 'No webhook URL is configured.'
    };
}

function resolveStaticPath(requestUrl, baseUrl) {
    const parsedUrl = new URL(requestUrl, baseUrl);
    const pathname = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
    const resolvedPath = path.normalize(path.join(ROOT_DIR, pathname));

    if (!resolvedPath.startsWith(ROOT_DIR)) {
        return null;
    }

    return resolvedPath;
}

const server = http.createServer(async (request, response) => {
    if (!request.url) {
        sendText(response, 400, 'Invalid request');
        return;
    }

    const baseUrl = getBaseUrl(request);
    const parsedUrl = new URL(request.url, baseUrl);

    if (request.method === 'OPTIONS') {
        setCorsHeaders(response);
        response.writeHead(204);
        response.end();
        return;
    }

    if (request.method === 'POST' && parsedUrl.pathname === '/api/chat') {
        try {
            const requestBody = await readRequestBody(request);
            const proxiedResponse = await proxyWebhookRequest(requestBody);

            setCorsHeaders(response);
            response.writeHead(proxiedResponse.statusCode, {
                'Content-Type': proxiedResponse.contentType
            });
            response.end(proxiedResponse.body);
        } catch (error) {
            sendText(response, 500, `Unexpected server error: ${error.message}`);
        }
        return;
    }

    if (request.method === 'GET' && parsedUrl.pathname === '/api/health') {
        setCorsHeaders(response);
        response.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8'
        });
        response.end(JSON.stringify({
            ok: true,
            host: HOST,
            port: activePort,
            apiPath: '/api/chat'
        }));
        return;
    }

    if (request.method !== 'GET') {
        sendText(response, 405, 'Method not allowed');
        return;
    }

    const filePath = resolveStaticPath(request.url, baseUrl);

    if (!filePath) {
        sendText(response, 403, 'Forbidden');
        return;
    }

    sendFile(response, filePath);
});

function startServer(port, attemptsRemaining = MAX_PORT_ATTEMPTS) {
    const handleListening = () => {
        server.off('error', handleError);
        activePort = port;
        console.log(`Chat app server running at http://${HOST}:${port}`);
    };

    const handleError = error => {
        server.off('listening', handleListening);

        if (
            error.code === 'EADDRINUSE' &&
            SHOULD_AUTO_SELECT_PORT &&
            attemptsRemaining > 1
        ) {
            const nextPort = port + 1;
            console.warn(`Port ${port} is already in use. Trying ${nextPort}...`);
            startServer(nextPort, attemptsRemaining - 1);
            return;
        }

        if (error.code === 'EADDRINUSE') {
            console.error(
                `Port ${port} is already in use. Close the app using it, or run this server on another port, for example: PORT=${port + 1} node server.js`
            );
            process.exit(1);
            return;
        }

        console.error(`Unable to start the chat app server: ${error.message}`);
        process.exit(1);
    };

    server.once('listening', handleListening);
    server.once('error', handleError);
    server.listen(port, HOST);
}

startServer(PORT);
