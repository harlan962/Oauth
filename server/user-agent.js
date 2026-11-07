// A compact "Chrome 141 · Windows 11" label. Full user-agent strings are kept in
// the database for forensics; this is only what a human reads at a glance, so it
// deliberately stays short and honest about what it cannot identify.
const browsers = [
  [/(Edg|Edge)\/([\d.]+)/, 'Edge'],
  [/OPR\/([\d.]+)/, 'Opera'],
  [/Firefox\/([\d.]+)/, 'Firefox'],
  // Must precede Chrome: "HeadlessChrome/141" also matches /Chrome\/([\d.]+)/.
  [/HeadlessChrome\/([\d.]+)/, 'Headless Chrome'],
  [/Chrome\/([\d.]+)/, 'Chrome'],
  [/Version\/([\d.]+).*Safari/, 'Safari'],
  [/curl\/([\d.]+)/, 'curl'],
  [/node(?:-fetch)?\/([\d.]+)/i, 'Node'],
  [/python-requests\/([\d.]+)/, 'python-requests'],
  [/PostmanRuntime\/([\d.]+)/, 'Postman'],
];

const systems = [
  [/Windows NT 10\.0/, 'Windows 10/11'],
  [/Windows NT 6\.3/, 'Windows 8.1'],
  [/Windows NT 6\.1/, 'Windows 7'],
  [/Android ([\d.]+)/, 'Android'],
  [/(iPhone|iPad|iPod).*OS ([\d_]+)/, 'iOS'],
  [/Mac OS X ([\d_]+)/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Ubuntu/, 'Ubuntu'],
  [/Linux/, 'Linux'],
];

function version(value) {
  if (!value) return '';
  const major = String(value).split('.')[0];
  return major ? ` ${major}` : '';
}

export function describeAgent(ua) {
  if (typeof ua !== 'string' || !ua.trim()) return '未知设备';
  const source = ua.slice(0, 400);
  let browser = null;
  for (const [pattern, name] of browsers) {
    const match = pattern.exec(source);
    if (match) {
      // Edge, Opera and HeadlessChrome all carry "Chrome/x" in the string, so the
      // first match wins and the list is ordered from most to least specific.
      browser = name + version(match[match.length - 1]);
      break;
    }
  }
  let system = null;
  for (const [pattern, name] of systems) {
    const match = pattern.exec(source);
    if (match) {
      system = name + (name === 'Android' || name === 'iOS' || name === 'macOS' ? version((match[2] || match[1] || '').replace(/_/g, '.')) : '');
      break;
    }
  }
  if (!browser && !system) return '无法识别的客户端';
  return [browser, system].filter(Boolean).join(' · ');
}
