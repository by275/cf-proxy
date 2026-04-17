import { readFileSync } from 'node:fs';

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_WORKER_COOLDOWN_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS_PER_WORKER = 32;
const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;

const createRequestId = () => crypto.randomUUID();

const formatTimestamp = (date = new Date()) => {
    const pad = (value) => String(value).padStart(2, '0');

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const shortenRequestId = (requestId) => requestId ? requestId.slice(0, 8) : '--------';

const parseWorkers = (value) => String(value)
    .split(',')
    .map(worker => worker.trim())
    .filter(Boolean);

const isValidWorker = (worker) => /^[\w\-]+(\.[\w\-]+)+$/.test(worker);
const isValidRoutingMode = (value) => value === 'worker' || value === 'direct';
const isValidFallbackMode = (value) => value === 'worker' || value === 'direct';

const formatTextLog = (level, event, fields) => {
    const parts = [
        `[${level}]`,
        fields.ts,
        fields.req,
        event.padEnd(15, ' '),
        `worker=${fields.worker ?? '-'}`,
        `target=${fields.target ?? '-'}`,
    ];
    const extras = Object.entries(fields)
        .filter(([key, value]) => !['ts', 'req', 'worker', 'target'].includes(key) && value !== undefined)
        .map(([key, value]) => `${key}=${value}`);

    return [...parts, ...extras].join(' ');
};

const getEventVerbosity = (event) => {
    if (event.startsWith('proxy.error') || event.startsWith('proxy.reject'))
        return 0;

    if (event === 'proxy.connect.open' || event === 'proxy.close')
        return 1;

    return 2;
};

const logEvent = (options, socket, event, fields = {}) => {
    const payload = {
        ts: formatTimestamp(),
        req: shortenRequestId(socket.requestId),
        event,
        worker: socket.worker ?? options.worker,
        target: socket.target,
        ...fields,
    };

    if ((options.verbosity ?? 0) < getEventVerbosity(event))
        return;

    const level = fields.level ?? (event.startsWith('proxy.error')
        ? 'ERR'
        : event.startsWith('proxy.reject')
            ? 'WRN'
            : 'INF');

    if (options.jsonLog) {
        console.log(JSON.stringify({
            level,
            ...payload,
        }));
        return;
    }

    console.log(formatTextLog(level, event.replace(/^proxy\./, ''), payload));
};

const parseHttpRequest = (data) => {
    try {
        const text = Buffer.from(data).toString('latin1');
        const headerEnd = text.indexOf('\r\n\r\n');

        if (headerEnd === -1)
            return { complete: false };

        const headerText = text.slice(0, headerEnd);
        const lines = headerText.split('\r\n');
        const requestLine = lines[0] ?? '';
        const [method, requestTarget] = requestLine.split(' ');

        if (method === 'CONNECT' && requestTarget)
            return { complete: true, target: requestTarget.trim(), forwardData: null };

        const hostLine = lines.find(line => line.toLowerCase().startsWith('host: '));

        if (!hostLine)
            return { complete: true, target: '', forwardData: null };

        return {
            complete: true,
            target: hostLine.split(': ').slice(1).join(': ').trim(),
            forwardData: Buffer.from(data),
        };
    } catch (e) {
        // log
    }

    return { complete: true, target: '', forwardData: null };
};

const parseTargetAddress = (target) => {
    if (!target)
        return null;

    if (target.startsWith('[')) {
        const end = target.indexOf(']');

        if (end === -1 || target[end + 1] !== ':')
            return null;

        const host = target.slice(1, end);
        const port = Number(target.slice(end + 2));

        if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
            return null;

        return { host, port };
    }

    const separator = target.lastIndexOf(':');

    if (separator === -1)
        return null;

    const host = target.slice(0, separator);
    const port = Number(target.slice(separator + 1));

    if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
        return null;

    return { host, port };
};

const parseJsonObject = (value, fallback = {}) => {
    if (!value)
        return fallback;

    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
        return fallback;
    }
};

const normalizePolicy = (policy) => {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy))
        return {};

    const normalized = {};

    if (isValidRoutingMode(policy.mode))
        normalized.mode = policy.mode;

    if (isValidFallbackMode(policy.fallback))
        normalized.fallback = policy.fallback;

    if (Array.isArray(policy.preferredWorkers)) {
        normalized.preferredWorkers = policy.preferredWorkers
            .map(worker => String(worker).trim())
            .filter(worker => isValidWorker(worker));
    }

    return normalized;
};

const loadRoutingPolicies = (options) => {
    let filePolicies = {};

    if (options.routingPolicyFile) {
        try {
            filePolicies = parseJsonObject(readFileSync(options.routingPolicyFile, 'utf8'));
        } catch (error) {
            throw new Error(`Failed to read routing policy file: ${options.routingPolicyFile}`);
        }
    }

    const jsonPolicies = parseJsonObject(options.routingPolicyJson);
    const merged = { ...filePolicies, ...jsonPolicies };

    return Object.fromEntries(
        Object.entries(merged).map(([host, policy]) => [host.toLowerCase(), normalizePolicy(policy)])
    );
};

const getRoutingPolicy = (options, target) => {
    const host = parseTargetAddress(target)?.host?.toLowerCase();
    const defaultPolicy = options.routingPolicies?.['*'] ?? {};
    const targetPolicy = host ? options.routingPolicies?.[host] ?? {} : {};

    return {
        mode: targetPolicy.mode ?? defaultPolicy.mode ?? 'worker',
        fallback: targetPolicy.fallback ?? defaultPolicy.fallback,
        preferredWorkers: targetPolicy.preferredWorkers ?? defaultPolicy.preferredWorkers ?? [],
    };
};

const getTimeoutMs = (value, fallback) => {
    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;

    return parsed;
};

const getRetryCount = (value, fallback) => {
    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed < 0)
        return fallback;

    return parsed;
};

const getWorkerState = (options, worker) => {
    options.workerState ||= new Map();

    if (!options.workerState.has(worker))
        options.workerState.set(worker, { cooldownUntil: 0, activeConnections: 0, waitQueue: [] });

    return options.workerState.get(worker);
};

const markWorkerFailure = (options, worker) => {
    const state = getWorkerState(options, worker);
    state.cooldownUntil = Date.now() + options.workerCooldownMs;
};

const markWorkerSuccess = (options, worker) => {
    const state = getWorkerState(options, worker);
    state.cooldownUntil = 0;
};

const releaseWorkerSlot = (options, worker) => {
    if (!worker)
        return;

    const state = getWorkerState(options, worker);
    state.activeConnections = Math.max(0, state.activeConnections - 1);

    while (state.waitQueue.length > 0 && state.activeConnections < options.maxConnectionsPerWorker) {
        const waiter = state.waitQueue.shift();

        if (waiter.socket?.proxyClosed)
            continue;

        state.activeConnections++;
        waiter.resolve();
        break;
    }
};

const acquireWorkerSlot = (options, worker, socket) => {
    const state = getWorkerState(options, worker);

    if (state.activeConnections < options.maxConnectionsPerWorker) {
        state.activeConnections++;
        return Promise.resolve();
    }

    logEvent(options, socket, 'proxy.queue.wait', {
        target: socket.target,
        worker,
        queueDepth: state.waitQueue.length + 1,
    });

    return new Promise((resolve) => {
        state.waitQueue.push({ resolve, socket });
    });
};

const clearSocketTimers = (socket) => {
    clearTimeout(socket.connectTimeoutId);
    clearTimeout(socket.idleTimeoutId);
    socket.connectTimeoutId = undefined;
    socket.idleTimeoutId = undefined;
};

const sendUpstream = (socket, data) => {
    if (!socket.proxy)
        return;

    if (typeof socket.proxy.send === 'function')
        socket.proxy.send(data);
    else if (typeof socket.proxy.write === 'function')
        socket.proxy.write(data);
};

const closeUpstream = (socket) => {
    if (!socket.proxy)
        return;

    try {
        if (typeof socket.proxy.close === 'function')
            socket.proxy.close();
        else if (typeof socket.proxy.end === 'function')
            socket.proxy.end();
    } catch {
        // ignore close errors
    }
};

const removeActiveSocket = (options, socket) => {
    options.activeSockets?.delete(socket);
};

const closeSocketProxy = (socket, reason, options) => {
    if (socket.proxyClosed)
        return;

    socket.proxyClosed = true;
    socket.connecting = false;
    clearSocketTimers(socket);
    releaseWorkerSlot(options, socket.workerSlotOwner);
    socket.workerSlotOwner = null;

    logEvent(options, socket, 'proxy.close', {
        target: socket.target,
        reason,
        durationMs: socket.startedAt ? Date.now() - socket.startedAt : undefined,
    });

    if (options.verbose && reason)
        console.log(`[!] Closing ${options.type} proxy connection: ${reason}`);

    closeUpstream(socket);

    socket.shutdown();
};

const queuePendingClientData = (socket, data, options) => {
    const chunk = Buffer.from(data);
    socket.pendingClientBytes = (socket.pendingClientBytes ?? 0) + chunk.length;

    if (socket.pendingClientBytes > options.maxPendingBytes) {
        logEvent(options, socket, 'proxy.error.backpressure', {
            target: socket.target,
            pendingBytes: socket.pendingClientBytes,
            limitBytes: options.maxPendingBytes,
        });
        closeSocketProxy(socket, 'pending client buffer exceeded', options);
        return false;
    }

    socket.pendingClientData.push(chunk);
    return true;
};

const flushPendingClientData = (socket, ws) => {
    if (socket.pendingClientData.length === 0)
        return;

    for (const chunk of socket.pendingClientData)
        if (typeof ws.send === 'function')
            ws.send(chunk);
        else if (typeof ws.write === 'function')
            ws.write(chunk);

    socket.pendingClientData = [];
    socket.pendingClientBytes = 0;
};

const registerSocket = (options, socket) => {
    options.activeSockets ||= new Set();
    options.activeSockets.add(socket);
};

const refreshIdleTimeout = (socket, options) => {
    clearTimeout(socket.idleTimeoutId);
    socket.idleTimeoutId = setTimeout(() => {
        closeSocketProxy(socket, `idle timeout after ${options.idleTimeoutMs}ms`, options);
    }, options.idleTimeoutMs);
};

const sendProxyReady = (socket, options) => {
    if (socket.proxyHandshakeSent)
        return;

    socket.proxyHandshakeSent = true;

    if (options.type == 'HTTP')
        socket.write('HTTP/1.1 200 OK\r\n\r\n');
    else
        socket.write(Buffer.from([0x5, 0x00, 0x00, 0x01, 0x7f, 0x00, 0x00, 0x01, 0x00, 0x00]));
};

const sendProxyFailure = (socket, options, statusLine = 'HTTP/1.1 500 Internal Server Error\r\n\r\n') => {
    if (socket.proxyHandshakeSent)
        return;

    socket.proxyHandshakeSent = true;

    if (options.type == 'HTTP')
        socket.write(statusLine);
    else
        socket.write(Buffer.from([0x5, 0x05, 0x00, 0x01, 0x7f, 0x00, 0x00, 0x01, 0x00, 0x00]));
};

const selectWorker = (options, excludedWorkers = new Set(), preferredWorkers = []) => {
    const now = Date.now();

    const orderedWorkers = [
        ...preferredWorkers.filter(worker => options.workers.includes(worker)),
        ...options.workers.filter(worker => !preferredWorkers.includes(worker)),
    ];

    for (let i = 0; i < orderedWorkers.length; i++) {
        const worker = orderedWorkers[(options.workerCursor + i) % orderedWorkers.length];
        const state = getWorkerState(options, worker);

        if (excludedWorkers.has(worker) || state.cooldownUntil > now)
            continue;

        options.workerCursor = (options.workers.indexOf(worker) + 1) % options.workers.length;
        return worker;
    }

    return null;
};

const maybeRetryConnection = (socket, options, reason, extraFields = {}) => {
    if (socket.proxyHandshakeSent || socket.routingMode !== 'worker')
        return false;

    const retriesUsed = socket.connectAttempt - 1;

    if (retriesUsed >= options.connectRetries) {
        logEvent(options, socket, 'proxy.error.retry_exhausted', {
            target: socket.target,
            reason,
            attempts: socket.connectAttempt,
            ...extraFields,
        });
        return false;
    }

    socket.proxy = undefined;
    socket.connecting = false;
    clearSocketTimers(socket);
    releaseWorkerSlot(options, socket.workerSlotOwner);
    socket.workerSlotOwner = null;

    logEvent(options, socket, 'proxy.error.retry', {
        target: socket.target,
        reason,
        attempt: socket.connectAttempt,
        nextAttempt: socket.connectAttempt + 1,
        ...extraFields,
    });

    startProxyConnection(socket.target, socket, options);
    return true;
};

const maybeFallbackConnection = (socket, options, reason, extraFields = {}) => {
    if (socket.proxyHandshakeSent)
        return false;

    const fallback = socket.routingPolicy?.fallback;

    if (!fallback || fallback === socket.routingMode || socket.usedFallback)
        return false;

    socket.proxy = undefined;
    socket.connecting = false;
    clearSocketTimers(socket);
    releaseWorkerSlot(options, socket.workerSlotOwner);
    socket.workerSlotOwner = null;
    socket.usedFallback = true;

    logEvent(options, socket, 'proxy.error.fallback', {
        target: socket.target,
        reason,
        fallback,
        ...extraFields,
    });

    if (fallback === 'direct') {
        startDirectConnection(socket.target, socket, options);
        return true;
    }

    socket.triedWorkers = new Set();
    socket.connectAttempt = 0;
    startProxyConnection(socket.target, socket, options);
    return true;
};

const startProxyConnection = async (target, socket, options) => {
    if (options.shuttingDown) {
        closeSocketProxy(socket, 'proxy shutting down', options);
        return null;
    }

    socket.requestId = socket.requestId || createRequestId();
    socket.startedAt = socket.startedAt || Date.now();
    socket.target = target;
    socket.routingMode = 'worker';
    socket.triedWorkers ||= new Set();
    socket.connectAttempt = (socket.connectAttempt ?? 0) + 1;
    socket.worker = selectWorker(options, socket.triedWorkers, socket.routingPolicy?.preferredWorkers ?? []);

    if (!socket.worker) {
        logEvent(options, socket, 'proxy.error.no_worker_available', {
            target,
            attempts: socket.connectAttempt,
        });

        if (maybeFallbackConnection(socket, options, 'no_worker_available', { attempts: socket.connectAttempt }))
            return null;

        sendProxyFailure(socket, options, 'HTTP/1.1 503 Service Unavailable\r\n\r\n');
        closeSocketProxy(socket, 'no worker available', options);
        return null;
    }

    socket.triedWorkers.add(socket.worker);
    socket.connecting = true;

    logEvent(options, socket, 'proxy.connect.start', {
        target,
        attempt: socket.connectAttempt,
    });

    await acquireWorkerSlot(options, socket.worker, socket);

    if (socket.proxyClosed)
        return null;

    if (options.shuttingDown) {
        closeSocketProxy(socket, 'proxy shutting down', options);
        return null;
    }

    socket.workerSlotOwner = socket.worker;

    logEvent(options, socket, 'proxy.queue.acquire', {
        target,
        attempt: socket.connectAttempt,
    });

    socket.proxyClosed = false;
    socket.proxyHandshakeSent = false;

    const ws = new WebSocket(`wss://${socket.worker}`, {
        headers: {
            Authorization: options.authorization,
            'X-Proxy-Target': target,
        }
    });
    socket.proxy = ws;

    socket.connectTimeoutId = setTimeout(() => {
        if (socket.proxy !== ws)
            return;

        markWorkerFailure(options, socket.worker);
        logEvent(options, socket, 'proxy.error.connect_timeout', {
            target,
            timeoutMs: options.connectTimeoutMs,
            attempt: socket.connectAttempt,
        });

        if (!maybeRetryConnection(socket, options, 'connect_timeout', { timeoutMs: options.connectTimeoutMs })) {
            if (maybeFallbackConnection(socket, options, 'connect_timeout', { timeoutMs: options.connectTimeoutMs }))
                return;

            sendProxyFailure(socket, options, 'HTTP/1.1 504 Gateway Timeout\r\n\r\n');
            closeSocketProxy(socket, 'worker connect timeout', options);
        }
    }, options.connectTimeoutMs);

    ws.onopen = () => {
        if (socket.proxy !== ws)
            return;

        clearTimeout(socket.connectTimeoutId);
        markWorkerSuccess(options, socket.worker);
        socket.connecting = false;
        logEvent(options, socket, 'proxy.connect.open', {
            target,
            durationMs: Date.now() - socket.startedAt,
            attempt: socket.connectAttempt,
        });
        sendProxyReady(socket, options);
        refreshIdleTimeout(socket, options);

        if (socket.pendingForwardData) {
            ws.send(socket.pendingForwardData);
            socket.pendingForwardData = null;
        }

        flushPendingClientData(socket, ws);
    };

    ws.onerror = () => {
        if (socket.proxy !== ws)
            return;

        markWorkerFailure(options, socket.worker);
        logEvent(options, socket, 'proxy.error.websocket', { target });

        if (!maybeRetryConnection(socket, options, 'websocket_error')) {
            if (maybeFallbackConnection(socket, options, 'websocket_error'))
                return;

            sendProxyFailure(socket, options);
            closeSocketProxy(socket, 'worker websocket error', options);
        }
    };

    ws.onclose = (e) => {
        if (socket.proxy !== ws)
            return;

        clearSocketTimers(socket);

        if (e.reason == "Expected 101 status code") {
            markWorkerFailure(options, socket.worker);
            logEvent(options, socket, 'proxy.error.handshake', {
                target,
                code: e.code,
                reason: e.reason,
                attempt: socket.connectAttempt,
            });

            if (maybeRetryConnection(socket, options, 'handshake_failed', { code: e.code }))
                return;

            if (maybeFallbackConnection(socket, options, 'handshake_failed', { code: e.code }))
                return;

            sendProxyFailure(socket, options);
        }

        closeSocketProxy(socket, `worker websocket closed (${e.code})`, options);
    };

    ws.onmessage = (e) => {
        if (socket.proxy !== ws)
            return;

        refreshIdleTimeout(socket, options);
        socket.write(e.data);
    };

    return ws;
};

const startDirectConnection = async (target, socket, options) => {
    const address = parseTargetAddress(target);

    if (!address) {
        logEvent(options, socket, 'proxy.reject.invalid_target', { target });
        sendProxyFailure(socket, options, 'HTTP/1.1 400 Bad Request\r\n\r\n');
        closeSocketProxy(socket, 'invalid direct target', options);
        return null;
    }

    socket.requestId = socket.requestId || createRequestId();
    socket.startedAt = socket.startedAt || Date.now();
    socket.target = target;
    socket.worker = 'direct';
    socket.routingMode = 'direct';
    socket.connecting = true;

    logEvent(options, socket, 'proxy.connect.start', {
        target,
        mode: 'direct',
    });

    try {
        const directSocket = await Bun.connect({
            hostname: address.host,
            port: address.port,
            socket: {
                open(connection) {
                    if (socket.proxy !== connection)
                        return;

                    socket.connecting = false;
                    logEvent(options, socket, 'proxy.connect.open', {
                        target,
                        durationMs: Date.now() - socket.startedAt,
                        mode: 'direct',
                    });
                    sendProxyReady(socket, options);
                    refreshIdleTimeout(socket, options);

                    if (socket.pendingForwardData) {
                        connection.write(socket.pendingForwardData);
                        socket.pendingForwardData = null;
                    }

                    flushPendingClientData(socket, connection);
                },
                data(connection, data) {
                    if (socket.proxy !== connection)
                        return;

                    refreshIdleTimeout(socket, options);
                    socket.write(data);
                },
                close(connection) {
                    if (socket.proxy !== connection)
                        return;

                    closeSocketProxy(socket, 'direct socket closed', options);
                },
                end(connection) {
                    if (socket.proxy !== connection)
                        return;

                    closeSocketProxy(socket, 'direct socket ended', options);
                },
                error(connection) {
                    if (socket.proxy !== connection)
                        return;

                    logEvent(options, socket, 'proxy.error.direct_socket', {
                        target,
                        mode: 'direct',
                    });

                    if (maybeFallbackConnection(socket, options, 'direct_socket_error'))
                        return;

                    sendProxyFailure(socket, options, 'HTTP/1.1 502 Bad Gateway\r\n\r\n');
                    closeSocketProxy(socket, 'direct socket error', options);
                },
                connectError(connection) {
                    if (socket.proxy !== connection)
                        return;

                    logEvent(options, socket, 'proxy.error.direct_connect', {
                        target,
                        mode: 'direct',
                    });

                    if (maybeFallbackConnection(socket, options, 'direct_connect_error'))
                        return;

                    sendProxyFailure(socket, options, 'HTTP/1.1 502 Bad Gateway\r\n\r\n');
                    closeSocketProxy(socket, 'direct connect error', options);
                },
                timeout(connection) {
                    if (socket.proxy !== connection)
                        return;

                    logEvent(options, socket, 'proxy.error.direct_timeout', {
                        target,
                        timeoutMs: options.connectTimeoutMs,
                        mode: 'direct',
                    });

                    if (maybeFallbackConnection(socket, options, 'direct_timeout', { timeoutMs: options.connectTimeoutMs }))
                        return;

                    sendProxyFailure(socket, options, 'HTTP/1.1 504 Gateway Timeout\r\n\r\n');
                    closeSocketProxy(socket, 'direct connect timeout', options);
                },
            },
        });

        socket.proxy = directSocket;
        socket.connectTimeoutId = setTimeout(() => {
            if (socket.proxy !== directSocket)
                return;

            logEvent(options, socket, 'proxy.error.direct_timeout', {
                target,
                timeoutMs: options.connectTimeoutMs,
                mode: 'direct',
            });
            sendProxyFailure(socket, options, 'HTTP/1.1 504 Gateway Timeout\r\n\r\n');
            closeSocketProxy(socket, 'direct connect timeout', options);
        }, options.connectTimeoutMs);

        return directSocket;
    } catch {
        logEvent(options, socket, 'proxy.error.direct_connect', {
            target,
            mode: 'direct',
        });

        if (maybeFallbackConnection(socket, options, 'direct_connect_error'))
            return null;

        sendProxyFailure(socket, options, 'HTTP/1.1 502 Bad Gateway\r\n\r\n');
        closeSocketProxy(socket, 'direct connect error', options);
        return null;
    }
};

const proxyConnect = (target, socket, options) => {
    socket.routingPolicy = getRoutingPolicy(options, target);
    socket.connectAttempt = 0;
    socket.triedWorkers = new Set();
    socket.usedFallback = false;
    socket.pendingForwardData = null;
    socket.pendingClientData = [];
    socket.pendingClientBytes = 0;

    if (socket.routingPolicy.mode === 'direct') {
        startDirectConnection(target, socket, options);
        return null;
    }

    startProxyConnection(target, socket, options);
    return null;
};

const initializeSocket = (socket, options, extra = {}) => {
    registerSocket(options, socket);
    socket.requestId = createRequestId();
    socket.startedAt = Date.now();
    socket.pendingClientData = [];
    socket.pendingClientBytes = 0;
    socket.httpBuffer = Buffer.alloc(0);
    Object.assign(socket, extra);

    if (options.shuttingDown)
        socket.shutdown();
};

const httpServer = (options) => Bun.listen({
    port: options.port || 8080,
    hostname: '0.0.0.0',
    socket: {
        async open(socket) {
            initializeSocket(socket, options);
        },
        async data(socket, data) {
            if (options.shuttingDown) {
                closeSocketProxy(socket, 'proxy shutting down', options);
                return;
            }

            if (!socket.proxy) {
                socket.httpBuffer = Buffer.concat([socket.httpBuffer, Buffer.from(data)]);
                const parsed = parseHttpRequest(socket.httpBuffer);

                if (!parsed.complete)
                    return;

                const target = parsed.target;

                if (!target) {
                    logEvent(options, socket, 'proxy.reject.invalid_target', {
                        target,
                    });
                    socket.shutdown();
                    return;
                }

                if (parsed.forwardData)
                    socket.pendingForwardData = parsed.forwardData;

                proxyConnect(target, socket, options);
                socket.httpBuffer = Buffer.alloc(0);
            } else if (socket.proxy) {
                refreshIdleTimeout(socket, options);
                sendUpstream(socket, data);
            } else if (socket.connecting) {
                queuePendingClientData(socket, data, options);
            }
        },
        async close(socket) {
            removeActiveSocket(options, socket);
            closeSocketProxy(socket, 'client socket closed', options);
        }
    }
});

const socks5Server = (options) => Bun.listen({
    port: options.port || 1080,
    hostname: '0.0.0.0',
    socket: {
        async open(socket) {
            initializeSocket(socket, options, { step: 0 });
        },
        async data(socket, data) {
            if (options.shuttingDown) {
                closeSocketProxy(socket, 'proxy shutting down', options);
                return;
            }

            if (socket.proxy) {
                refreshIdleTimeout(socket, options);
                sendUpstream(socket, data);
                return;
            }

            if (socket.connecting) {
                queuePendingClientData(socket, data, options);
                return;
            }

            switch (socket.step) {
                case 0:
                    if (data[0] != 0x05) {
                        logEvent(options, socket, 'proxy.reject.socks_version', {});
                        if (options.verbose) console.log('[!] SOCKS version mismatch');
                        socket.shutdown();
                    }

                    if (!data.slice(2).includes(0x00)) {
                        // either is not a real socks client, or it needs to be authenticated somehow
                        logEvent(options, socket, 'proxy.reject.socks_client_error', {});
                        if (options.verbose) console.log('[!] SOCKS client error');
                        socket.shutdown();
                    }

                    // no auth required
                    socket.write(Buffer.from([0x5, 0x00]));
                    socket.step++;

                    break;

                case 1:
                    if (data[0] != 0x05 || data[2] != 0x00) {
                        logEvent(options, socket, 'proxy.reject.socks_version', {});
                        if (options.verbose) console.log('[!] SOCKS version mismatch');
                        socket.shutdown();
                    }

                    // we only allow connect (0x01) requests
                    if (data[1] != 0x01) {
                        logEvent(options, socket, 'proxy.reject.socks_command', {});
                        if (options.verbose) console.log('[!] Client request could not be satisfied');
                        socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
                        socket.shutdown();
                    }

                    // now we parse the target information
                    let target = '';

                    if (data[3] == 0x1) {
                        // ipv4
                        target = data.slice(4, 8).map(n => n.toString()).join('.');
                    } else if (data[3] == 0x3) {
                        // domain
                        target = String(Buffer.from(data.slice(5, 5 + data[4])));
                    } else if (data[3] == 0x4) {
                        // ipv6
                        const ipv6 = Array.from(data.slice(4, 20)).map(b => b.toString(16).padStart(2, 0));

                        for (let i = 0; i < ipv6.length; i += 2) {
                            if (i != 0) target += ':';
                            target += ipv6.slice(i, i + 2).join('');
                        }

                        // ipv6 short form
                        target = target.replaceAll(':00', ':').replaceAll(':00', ':');
                        target = `[${target.replaceAll(':::', ':')}]`;
                    } else {
                        // unknown
                        logEvent(options, socket, 'proxy.reject.socks_address_type', {});
                        if (options.verbose)
                            console.log('[!] Client request could not be satisfied');
                        socket.shutdown();
                    }

                    const port = data.at(-1) + data.at(-2) * 256;
                    target = `${target}:${port}`;
                    proxyConnect(target, socket, options);

                    break;
            }
        },
        async close(socket) {
            removeActiveSocket(options, socket);
            closeSocketProxy(socket, 'client socket closed', options);
        }
    }
});

const parseOptions = (argv) => {
    // poor man's arg parser

    if (argv.length < 2) {
        return { help: true };
    }

    const options = {};

    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case '-h':
            case '--help':
                return { help: true };
            case '-v':
                options.verbosity = Math.max(options.verbosity ?? 0, 1);
                break;
            case '-vv':
            case '--verbose':
                options.verbosity = 2;
                break;
            case '-p':
            case '--port':
                options.port = parseInt(argv[++i]);
                break;
            case '-a':
            case '--auth':
                options.authorization = argv[++i];
                break;
            case '--connect-timeout-ms':
                options.connectTimeoutMs = parseInt(argv[++i]);
                break;
            case '--idle-timeout-ms':
                options.idleTimeoutMs = parseInt(argv[++i]);
                break;
            case '--connect-retries':
                options.connectRetries = parseInt(argv[++i]);
                break;
            case '--worker-cooldown-ms':
                options.workerCooldownMs = parseInt(argv[++i]);
                break;
            case '--max-connections-per-worker':
                options.maxConnectionsPerWorker = parseInt(argv[++i]);
                break;
            case '--max-pending-bytes':
                options.maxPendingBytes = parseInt(argv[++i]);
                break;
            case '--json-log':
                options.jsonLog = true;
                break;
            case '--routing-policy-file':
                options.routingPolicyFile = argv[++i];
                break;
            case '--routing-policy-json':
                options.routingPolicyJson = argv[++i];
                break;
            case 'socks':
                options.type = 'SOCKS5';
                options.server = socks5Server;
                break;
            case 'http':
                options.type = 'HTTP';
                options.server = httpServer;
                break;
            default:
                if (argv[i].includes(',') || isValidWorker(argv[i])) {
                    options.workers = parseWorkers(argv[i]);

                    if (!options.workers.length || options.workers.some(worker => !isValidWorker(worker))) {
                        console.log(`Invalid option: ${argv[i]}`);
                        return null;
                    }

                    options.worker = options.workers[0];
                } else {
                    console.log(`Invalid option: ${argv[i]}`);
                    return null;
                }
                break;
        }
    }
    return options;
};

function main() {
    const options = parseOptions(Bun.argv.slice(2));

    if (!options) return -1;

    options.connectTimeoutMs = getTimeoutMs(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    options.idleTimeoutMs = getTimeoutMs(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
    options.workerCooldownMs = getTimeoutMs(options.workerCooldownMs, DEFAULT_WORKER_COOLDOWN_MS);
    options.maxConnectionsPerWorker = getRetryCount(options.maxConnectionsPerWorker, DEFAULT_MAX_CONNECTIONS_PER_WORKER);
    options.maxPendingBytes = getTimeoutMs(options.maxPendingBytes, DEFAULT_MAX_PENDING_BYTES);
    options.verbosity = options.verbosity ?? 0;
    options.verbose = options.verbosity > 0;
    options.workers = options.workers?.length ? options.workers : options.worker ? [options.worker] : [];
    options.worker = options.workers[0];
    options.workerCursor = 0;
    options.connectRetries = getRetryCount(options.connectRetries, Math.max(0, options.workers.length - 1));
    options.routingPolicies = loadRoutingPolicies(options);

    if (!options.server || !options.workers.length) {
        console.log('Missing proxy type or worker endpoint');
        return -1;
    }

    if (options.help) {
        console.log(`${import.meta.file} - Proxy requests through CloudFlare workers`);
        console.log(`Usage: bun ${import.meta.file} [options] <socks|http> <worker[,worker2,...]>`);
        console.log('')
        console.log('Options:');
        console.log('')
        console.log('-h, --help         Show this help message and exit');
        console.log('-p, --port         Port to listen on (defaults to 1080 for socks and 8080 for http)');
        console.log('-a, --auth         Authorization header');
        console.log('--connect-timeout-ms  Worker connect timeout in milliseconds (default: 10000)');
        console.log('--idle-timeout-ms     Idle timeout in milliseconds (default: 30000)');
        console.log('--connect-retries     Retry failed worker connects (default: workers-1)');
        console.log('--worker-cooldown-ms  Exclude failed workers for this long (default: 30000)');
        console.log('--max-connections-per-worker  Limit concurrent connects per worker (default: 32)');
        console.log('--max-pending-bytes   Cap queued client bytes before connect/open (default: 1048576)');
        console.log('--routing-policy-file Path to routing policy JSON file');
        console.log('--routing-policy-json Inline routing policy JSON');
        console.log('--json-log            Emit logs as JSON instead of human-readable text');
        console.log('-v                    Show connect.open and close logs');
        console.log('-vv, --verbose        Show full connection lifecycle logs');
        console.log('')
        console.log(`Example: bun ${import.meta.file} -vv -a auth-secret socks my-a.workers.dev,my-b.workers.dev`);
        console.log('')
        console.log('By Lucas V. Araujo <root@lva.sh>');
        console.log('More at https://github.com/lvmalware');

        return 0;
    }

    const server = options.server(options);
    console.log(`[+] ${options.type} proxy server listening on ${server.hostname}:${server.port} using ${options.workers.length} worker(s)`);

    const shutdown = (signal) => {
        if (options.shuttingDown)
            return;

        options.shuttingDown = true;
        console.log(`[+] Received ${signal}, shutting down ${options.type} proxy`);

        for (const socket of options.activeSockets ?? [])
            closeSocketProxy(socket, `shutdown (${signal})`, options);

        if (typeof server.stop === 'function')
            server.stop();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    return 0;
}

if (import.meta.main) {
    main();
}
