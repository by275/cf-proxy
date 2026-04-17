import { connect } from 'cloudflare:sockets';

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

const errorResponse = (status, code, message) => new Response(JSON.stringify({
    error: code,
    message,
}), {
    status,
    headers: {
        'Content-Type': 'application/json',
    },
});

const getJsonObject = (value) => {
    if (!value)
        return {};

    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
};

const isPrivateIpv4 = (host) => {
    const parts = host.split('.').map(Number);

    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255))
        return false;

    if (parts[0] === 10)
        return true;

    if (parts[0] === 127)
        return true;

    if (parts[0] === 192 && parts[1] === 168)
        return true;

    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        return true;

    return false;
};

const parseTarget = (value) => {
    if (!value)
        return null;

    if (value.startsWith('[')) {
        const end = value.indexOf(']');

        if (end === -1 || value[end + 1] !== ':')
            return null;

        return {
            host: value.slice(1, end),
            port: value.slice(end + 2),
        };
    }

    const separator = value.lastIndexOf(':');

    if (separator === -1)
        return null;

    return {
        host: value.slice(0, separator),
        port: value.slice(separator + 1),
    };
};

const validateTarget = (value) => {
    const target = parseTarget(value);

    if (!target || !target.host || !/^\d+$/.test(target.port))
        return { ok: false, status: 400, message: 'Invalid proxy target' };

    const host = target.host.toLowerCase();
    const port = Number(target.port);

    if (port < 1 || port > 65535)
        return { ok: false, status: 400, message: 'Invalid proxy target' };

    if (host === 'localhost' || host === '::1' || isPrivateIpv4(host))
        return { ok: false, status: 403, message: 'Target is not allowed' };

    return { ok: true };
};

const getTimeoutMs = (value, fallback) => {
    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;

    return parsed;
};

const withTimeout = async (promise, timeoutMs, onTimeout) => {
    let timeoutId;

    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timeoutId = setTimeout(async () => {
                    try {
                        await onTimeout();
                    } catch {
                        // ignore cleanup errors
                    }

                    reject(new Error('Timed out'));
                }, timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timeoutId);
    }
};

const classifyError = (error) => {
    if (error instanceof Error) {
        if (error.message === 'Timed out')
            return { status: 504, code: 'upstream_connect_timeout', message: 'Upstream connect timeout' };

        if (/proxy request failed|cannot connect|network connection lost|connection closed/i.test(error.message))
            return { status: 502, code: 'upstream_connect_failed', message: 'Failed to connect to upstream target' };
    }

    return { status: 500, code: 'internal_error', message: 'Internal worker error' };
};

const getTargetPolicy = (env, host) => {
    const policies = getJsonObject(env.PROXY_TARGET_POLICIES);
    const defaultPolicy = policies['*'];
    const hostPolicy = policies[host];

    return {
        ...(defaultPolicy && typeof defaultPolicy === 'object' ? defaultPolicy : {}),
        ...(hostPolicy && typeof hostPolicy === 'object' ? hostPolicy : {}),
    };
};

export default {
    async fetch(request, env) {
        const token = env.PROXY_AUTH_TOKEN;

        if (!token)
            return errorResponse(500, 'worker_not_configured', 'Worker is not configured');

        if (request.headers.get('Authorization') !== token)
            return errorResponse(401, 'unauthorized', 'Unauthorized');

        const upgradeHeader = request.headers.get('Upgrade');

        if (!upgradeHeader || upgradeHeader !== 'websocket')
            return errorResponse(426, 'upgrade_required', 'Expected Upgrade: websocket');

        const proxyTarget = request.headers.get('X-Proxy-Target');
        const validation = validateTarget(proxyTarget);

        if (!validation.ok)
            return errorResponse(validation.status, 'invalid_target', validation.message);

        const parsedTarget = parseTarget(proxyTarget);
        const policy = getTargetPolicy(env, parsedTarget.host.toLowerCase());

        if (policy.allow === false)
            return errorResponse(403, 'target_blocked_by_policy', 'Target is blocked by policy');

        const connectTimeoutMs = getTimeoutMs(
            policy.connectTimeoutMs,
            getTimeoutMs(env.PROXY_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS)
        );
        const idleTimeoutMs = getTimeoutMs(
            policy.idleTimeoutMs,
            getTimeoutMs(env.PROXY_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS)
        );

        try {
            const target = connect(proxyTarget);
            const websocket = new WebSocketPair();
            const [client, server] = Object.values(websocket);
            let idleTimeoutId;
            let closed = false;

            const closeEverything = async (code = 1011, reason = 'Proxy closed') => {
                if (closed)
                    return;

                closed = true;
                clearTimeout(idleTimeoutId);

                try {
                    await target.close();
                } catch {
                    // ignore close errors
                }

                try {
                    server.close(code, reason);
                } catch {
                    // ignore close errors
                }
            };

            await withTimeout(target.opened, connectTimeoutMs, () => target.close());

            const writer = target.writable.getWriter();
            const refreshIdleTimeout = () => {
                clearTimeout(idleTimeoutId);
                idleTimeoutId = setTimeout(() => {
                    closeEverything(1011, 'Idle timeout');
                }, idleTimeoutMs);
            };

            server.accept();
            refreshIdleTimeout();

            server.addEventListener('message', event => {
                refreshIdleTimeout();
                writer.write(event.data).catch(() => closeEverything(1011, 'Upstream write failed'));
            });
            server.addEventListener('close', () => closeEverything(1000, 'Client closed'));
            server.addEventListener('error', () => closeEverything(1011, 'Client websocket error'));

            target.readable.pipeTo(new WritableStream({
                write(chunk) {
                    refreshIdleTimeout();
                    server.send(chunk);
                },
                close() {
                    closeEverything(1000, 'Upstream closed');
                },
                abort() {
                    closeEverything(1011, 'Upstream aborted');
                },
            })).catch(() => closeEverything(1011, 'Upstream read failed'));

            target.closed
                .catch(() => closeEverything(1011, 'Upstream socket error'))
                .finally(() => closeEverything(1000, 'Upstream socket closed'));

            return new Response(null, { status: 101, webSocket: client, });
        } catch (e) {
            const classified = classifyError(e);
            return errorResponse(classified.status, classified.code, classified.message);
        }
    }
}
