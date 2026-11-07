import { useMemo } from "react";
import qrcode from "qrcode-generator";

/**
 * A QR code drawn from the otpauth:// URI.
 *
 * Rendered as inline SVG rather than an <img> from a data URL: the code is a
 * secret (it contains the TOTP seed), so it stays inside the DOM and is never
 * turned into a cacheable resource. The library is bundled locally — the app
 * must work with no outbound network, and posting the secret to an online chart
 * API would leak the second factor to a third party.
 *
 * `value` is any short string; the encoder picks the smallest version that
 * fits at error-correction level M (the level authenticator apps expect).
 */
export function QrCode({
  value,
  size = 176,
  label = "两步验证二维码",
}: {
  value: string;
  size?: number;
  label?: string;
}) {
  const code = useMemo(() => {
    if (!value) return null;
    try {
      const qr = qrcode(0, "M");
      qr.addData(value);
      qr.make();
      const count = qr.getModuleCount();
      // One path with a sub-path per dark module keeps the DOM to a handful of
      // nodes instead of thousands of <rect>s.
      let path = "";
      for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
          if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
        }
      }
      return { path, count };
    } catch {
      return null;
    }
  }, [value]);

  if (!code) return null;
  return (
    <div className="qr-frame" style={{ width: size, height: size }}>
      <svg
        viewBox={`0 0 ${code.count} ${code.count}`}
        className="qr-code"
        role="img"
        aria-label={label}
        shapeRendering="crispEdges"
      >
        <path d={code.path} fill="#111827" />
      </svg>
    </div>
  );
}
