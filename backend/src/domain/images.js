// Pictures anyone may see (catalog items, driver photos). Pure checks.
//
// The type comes from the BYTES, never the Content-Type header: a public picture that is
// really an SVG or HTML file would be served from our origin to every customer. Only the three
// raster formats every phone shows.
export const PUBLIC_IMAGE_MAX = 3 * 1024 * 1024;

export function sniffImage(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { type: 'image/png', ext: 'png' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  return null;
}

export function checkPublicImage(bytes) {
  if (!bytes || !bytes.length) return { error: 'empty photo' };
  if (bytes.length > PUBLIC_IMAGE_MAX) return { error: 'the photo is too big (3 MB at most)' };
  const kind = sniffImage(bytes);
  if (!kind) return { error: 'use a JPEG, PNG or WebP photo' };
  return kind;
}
