// Guards for the few places where a report value becomes an attribute (an image source or a link). Every other report value is rendered as
// React text, which is escaped. The server's Content-Security-Policy allows inline script (the viewer is one inlined file), so these
// guards are what keep a hostile report from turning a value into a script or a tracking request.
import { isHttpUrl } from './contract';

/** The address itself when it is a plain http: or https: address, otherwise undefined (never a javascript:, data:, file: or relative address). */
export const safeHttpUrl = (s: unknown): string | undefined => (typeof s === 'string' && isHttpUrl(s) ? s : undefined);

const IMAGE_URI = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
/** An inline raster image (no SVG, no HTML, no remote address) or undefined. */
export const safeImageSrc = (s: unknown): string | undefined => (typeof s === 'string' && s.length <= 1_500_000 && IMAGE_URI.test(s) ? s : undefined);
