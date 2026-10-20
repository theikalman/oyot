/**
 * Images, made fit to hand an assistant (ADR 0037, decision 10).
 *
 * Claude reads JPEG, PNG, GIF and WebP, takes the first frame of an animation,
 * and downscales anything past a long edge of 1568 px (2576 px on its newer
 * models) before it looks at it. Claude Desktop is reported to refuse a tool
 * result over 1 MB. So an image that is already small enough is sent as it is,
 * and anything else is scaled to that edge and re-encoded until it fits the
 * byte budget it was given.
 *
 * The decoding and drawing are a `Codec`, the browser's canvas in the app and
 * a stand-in in the tests, so what is decided here can be tested without a
 * DOM.
 */

/** The image types Claude reads. */
export const READABLE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** The long edge Claude downscales past on every model, so nothing is lost by it. */
export const MAX_EDGE = 1568;

/**
 * Raw bytes of image a single tool result may carry, all its images
 * together. Base64 makes that about 933 KB, which leaves room under the 1 MB
 * Claude Desktop is reported to enforce for the text that goes with them.
 */
export const RESULT_IMAGE_BUDGET = 700_000;

/** Images `read_note` puts after a note's text at most. */
export const MAX_IMAGES_PER_NOTE = 5;

/** JPEG qualities tried in turn until the image fits. */
const QUALITIES = [0.85, 0.7, 0.55, 0.4];

export interface Decoded {
    width: number;
    height: number;
    /** Whether any pixel is less than opaque. */
    hasAlpha: boolean;
    /** Whether the image has more than one frame. */
    animated: boolean;
}

/** Decoding and drawing, which only a browser can do. */
export interface Codec {
    decode(bytes: Uint8Array, mime: string): Promise<Decoded>;
    /** The image drawn at `width` by `height` and encoded as `mime`. */
    encode(
        bytes: Uint8Array,
        mime: string,
        width: number,
        height: number,
        outMime: 'image/png' | 'image/jpeg',
        quality: number,
    ): Promise<Uint8Array>;
}

export interface PreparedImage {
    bytes: Uint8Array;
    mime: string;
    width: number;
    height: number;
    /** Whether it was redrawn, rather than sent as it was stored. */
    scaled: boolean;
    /** Whether only its first frame was kept. */
    firstFrameOnly: boolean;
}

export type Prepared =
    { ok: true; image: PreparedImage } | { ok: false; reason: 'unsupported_type' | 'too_large' };

export async function prepareImage(
    bytes: Uint8Array,
    mime: string,
    maxBytes: number,
    codec: Codec,
): Promise<Prepared> {
    const readable = (READABLE_TYPES as readonly string[]).includes(mime);
    let decoded: Decoded;
    try {
        decoded = await codec.decode(bytes, mime);
    } catch {
        return { ok: false, reason: 'unsupported_type' };
    }

    const fits = Math.max(decoded.width, decoded.height) <= MAX_EDGE;
    if (readable && fits && bytes.length <= maxBytes) {
        return {
            ok: true,
            image: {
                bytes,
                mime,
                width: decoded.width,
                height: decoded.height,
                scaled: false,
                firstFrameOnly: false,
            },
        };
    }

    const [width, height] = fitWithin(decoded.width, decoded.height, MAX_EDGE);
    // PNG keeps transparency, which JPEG would fill with black. It has no
    // quality to step down through, so if it does not fit, JPEG is tried after.
    const attempts: ['image/png' | 'image/jpeg', number][] = decoded.hasAlpha
        ? [['image/png', 1], ...QUALITIES.map((q): ['image/jpeg', number] => ['image/jpeg', q])]
        : QUALITIES.map((q): ['image/jpeg', number] => ['image/jpeg', q]);

    for (const [outMime, quality] of attempts) {
        const out = await codec.encode(bytes, mime, width, height, outMime, quality);
        if (out.length <= maxBytes) {
            return {
                ok: true,
                image: {
                    bytes: out,
                    mime: outMime,
                    width,
                    height,
                    scaled: true,
                    firstFrameOnly: decoded.animated,
                },
            };
        }
    }
    return { ok: false, reason: 'too_large' };
}

/** `width` by `height` scaled down, keeping its shape, until neither side passes `edge`. */
export function fitWithin(width: number, height: number, edge: number): [number, number] {
    const long = Math.max(width, height);
    if (long <= edge) return [width, height];
    const scale = edge / long;
    return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

/**
 * The browser's codec: `createImageBitmap` to decode, an `OffscreenCanvas` to
 * draw and encode. An image's EXIF orientation is applied when it is
 * decoded, so what is sent is the way up the editor shows it.
 */
export const browserCodec: Codec = {
    async decode(bytes, mime) {
        const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
        try {
            return {
                width: bitmap.width,
                height: bitmap.height,
                hasAlpha: mime !== 'image/jpeg' && hasTransparency(bitmap),
                // A GIF or WebP might hold more frames; nothing short of
                // parsing them says. Scaling keeps the first either way.
                animated: mime === 'image/gif' || mime === 'image/webp',
            };
        } finally {
            bitmap.close();
        }
    },
    async encode(bytes, mime, width, height, outMime, quality) {
        const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
        try {
            const canvas = new OffscreenCanvas(width, height);
            const context = canvas.getContext('2d');
            if (!context) throw new Error('no 2d context');
            context.imageSmoothingQuality = 'high';
            context.drawImage(bitmap, 0, 0, width, height);
            const blob = await canvas.convertToBlob({ type: outMime, quality });
            return new Uint8Array(await blob.arrayBuffer());
        } finally {
            bitmap.close();
        }
    },
};

/**
 * Whether a bitmap has a pixel that is not fully opaque, looked for on a
 * small copy: transparency worth keeping covers more than a pixel or two.
 */
function hasTransparency(bitmap: ImageBitmap): boolean {
    const [width, height] = fitWithin(bitmap.width, bitmap.height, 256);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return true;
    context.drawImage(bitmap, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] < 255) return true;
    }
    return false;
}
