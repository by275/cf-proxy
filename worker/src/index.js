import { connect } from 'cloudflare:sockets';

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

        try {
            const target = connect(request.headers.get('X-Proxy-Target'));
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
