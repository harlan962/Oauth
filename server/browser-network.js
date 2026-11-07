import { Server } from 'proxy-chain';

// Chromium has no SOCKS5 username/password support. Keep upstream credentials
// inside an ephemeral loopback relay shared by neither users nor sessions.
export async function prepareBrowserNetwork(proxy) {
  if (!proxy) return { launchOptions: { args: ['--no-proxy-server'] }, close: async () => {} };
  if (!proxy.server.startsWith('socks5:') || !proxy.username) {
    return { launchOptions: { proxy: {
      server: proxy.server,
      ...(proxy.username ? { username: proxy.username, password: proxy.password } : {}),
    } }, close: async () => {} };
  }
  const upstream = new URL(proxy.server);
  // Resolve destinations at the SOCKS server, matching Chromium's SOCKS mode.
  upstream.protocol = 'socks5h:';
  upstream.username = encodeURIComponent(proxy.username);
  upstream.password = encodeURIComponent(proxy.password);
  const relay = new Server({
    host: '127.0.0.1', port: 0, verbose: false,
    prepareRequestFunction: () => ({ upstreamProxyUrl: upstream.href }),
  });
  let closing;
  const close = () => closing ||= relay.close(true);
  try { await relay.listen(); }
  catch { await close().catch(() => {}); throw new Error('无法启动本地代理转接'); }
  return { launchOptions: { proxy: { server: `http://127.0.0.1:${relay.port}` } }, close };
}
