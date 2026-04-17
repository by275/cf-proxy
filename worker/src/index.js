import { connect } from 'cloudflare:sockets';

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

export default {
    async fetch(request, env) {
        const token = env.PROXY_AUTH_TOKEN;

        if (!token)
            return new Response('Worker is not configured', { status: 500 });

        if (request.headers.get('Authorization') !== token)
            return new Response('Unauthorized', { status: 401 });

        const upgradeHeader = request.headers.get('Upgrade');

        if (!upgradeHeader || upgradeHeader !== 'websocket')
            return new Response('Expected Upgrade: websocket', { status: 426 });

        const proxyTarget = request.headers.get('X-Proxy-Target');
        const validation = validateTarget(proxyTarget);

        if (!validation.ok)
            return new Response(validation.message, { status: validation.status });

        try {
            const target = connect(proxyTarget);
            const writer = target.writable.getWriter();
            const websocket = new WebSocketPair();
            const [client, server] = Object.values(websocket);

            server.accept();
            server.addEventListener('message', e => writer.write(e.data));

            target.readable.pipeTo(new WritableStream({
                write(chunk) {
                    server.send(chunk);
                },
            }));

            return new Response(null, { status: 101, webSocket: client, });
        } catch (e) {
            return new Response(e, { status: 500 });
        }
    }
}
