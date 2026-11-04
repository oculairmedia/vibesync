/**
 * Length-delimited framing for App Server JSON over Iroh streams.
 *
 * Faithful TypeScript port of letta-mobile's `IrohFrameCodec.kt`
 * (android-compose/sharedLogic/src/jvmAndAndroid/kotlin/com/letta/mobile/
 * data/transport/iroh/IrohFrameCodec.kt, origin/main). Keep byte-for-byte
 * compatible; do not redesign.
 *
 * Plain frame:  4-byte big-endian length (< PART_SENTINEL) + UTF-8 JSON.
 *
 * `frame_part` (capability-gated; advertise FRAME_PART_CAPABILITY in auth):
 * a logical frame larger than maxFrameBytes is split into ordered parts,
 * each: 4-byte sentinel 0x7FFFFFFF, flags(1; bit0 = FIN), part_index(4 BE,
 * 0-based strictly sequential), part_len(4 BE, 1..maxFrameBytes), payload.
 * Parts are strictly sequential on their stream — a plain frame or a bad
 * index mid-reassembly is a protocol error. Reassembly is capped.
 */

export const DEFAULT_MAX_FRAME_BYTES = 1_048_576; // 1 MiB per frame / part
export const DEFAULT_MAX_REASSEMBLED_BYTES = 33_554_432; // 32 MiB logical frame
export const FRAME_PART_CAPABILITY = 'frame_part';

const LENGTH_PREFIX_BYTES = 4;
const PART_SENTINEL = 0x7fffffff;
const PART_HEADER_BYTES = 9; // flags(1) + part_index(4) + part_len(4)
const PART_FLAG_FIN = 0x01;

export class IrohProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IrohProtocolError';
  }
}

/** Typed rejection for frames/reassemblies exceeding the configured bounds. */
export class FrameTooLargeError extends IrohProtocolError {
  constructor(message: string) {
    super(message);
    this.name = 'FrameTooLargeError';
  }
}

function toBytes(frame: string | Uint8Array): Uint8Array {
  return typeof frame === 'string' ? Buffer.from(frame, 'utf8') : frame;
}

export function encodeFrame(frame: string | Uint8Array, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES): Uint8Array {
  const payload = toBytes(frame);
  if (payload.length > maxFrameBytes) {
    throw new FrameTooLargeError(`Iroh frame too large: ${payload.length} bytes > max ${maxFrameBytes}`);
  }
  const out = Buffer.alloc(LENGTH_PREFIX_BYTES + payload.length);
  out.writeUInt32BE(payload.length, 0);
  out.set(payload, LENGTH_PREFIX_BYTES);
  return out;
}

/**
 * One plain frame when it fits in maxFrameBytes, else ordered `frame_part`
 * frames. Only send the multi-part encoding to peers that advertised
 * FRAME_PART_CAPABILITY.
 */
export function encodeFrameParts(
  frame: string | Uint8Array,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  maxTotalBytes = DEFAULT_MAX_REASSEMBLED_BYTES,
): Uint8Array[] {
  const payload = toBytes(frame);
  if (payload.length <= maxFrameBytes) return [encodeFrame(payload, maxFrameBytes)];
  if (payload.length > maxTotalBytes) {
    throw new FrameTooLargeError(`Iroh logical frame too large: ${payload.length} bytes > max ${maxTotalBytes}`);
  }
  const parts: Uint8Array[] = [];
  let offset = 0;
  let index = 0;
  while (offset < payload.length) {
    const partLen = Math.min(maxFrameBytes, payload.length - offset);
    const fin = offset + partLen === payload.length;
    const out = Buffer.alloc(LENGTH_PREFIX_BYTES + PART_HEADER_BYTES + partLen);
    out.writeUInt32BE(PART_SENTINEL, 0);
    out.writeUInt8(fin ? PART_FLAG_FIN : 0, 4);
    out.writeUInt32BE(index, 5);
    out.writeUInt32BE(partLen, 9);
    out.set(payload.subarray(offset, offset + partLen), LENGTH_PREFIX_BYTES + PART_HEADER_BYTES);
    parts.push(out);
    offset += partLen;
    index += 1;
  }
  return parts;
}

/** Incremental decoder: one instance owns exactly one ordered byte stream. */
export class FrameDecoder {
  private expectedLength: number | null = null;
  private readonly prefix = Buffer.alloc(LENGTH_PREFIX_BYTES);
  private prefixBytes = 0;
  private payload: Buffer = Buffer.alloc(0);
  private payloadBytes = 0;

  private readingPartHeader = false;
  private readonly partHeader = Buffer.alloc(PART_HEADER_BYTES);
  private partHeaderBytes = 0;
  private currentSegmentIsPart = false;
  private currentPartFin = false;
  private expectedPartIndex = 0;
  private pendingParts: Buffer[] = [];
  private pendingBytes = 0;

  private readonly maxReassembledBytes: () => number;

  constructor(
    private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    maxReassembledBytes: number | (() => number) = DEFAULT_MAX_REASSEMBLED_BYTES,
  ) {
    this.maxReassembledBytes = typeof maxReassembledBytes === 'function' ? maxReassembledBytes : () => maxReassembledBytes;
  }

  feed(chunk: Uint8Array): string[] {
    const frames: string[] = [];
    if (chunk.length === 0) return frames;
    const src = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    while (offset < src.length) {
      const length = this.expectedLength;
      if (this.readingPartHeader) {
        const n = Math.min(PART_HEADER_BYTES - this.partHeaderBytes, src.length - offset);
        src.copy(this.partHeader, this.partHeaderBytes, offset, offset + n);
        this.partHeaderBytes += n;
        offset += n;
        if (this.partHeaderBytes === PART_HEADER_BYTES) this.beginPartPayload();
      } else if (length === null) {
        const n = Math.min(LENGTH_PREFIX_BYTES - this.prefixBytes, src.length - offset);
        src.copy(this.prefix, this.prefixBytes, offset, offset + n);
        this.prefixBytes += n;
        offset += n;
        if (this.prefixBytes === LENGTH_PREFIX_BYTES) {
          this.prefixBytes = 0;
          const decoded = this.prefix.readInt32BE(0);
          if (decoded === PART_SENTINEL) {
            this.readingPartHeader = true;
            this.partHeaderBytes = 0;
          } else {
            if (this.reassemblyInProgress()) {
              throw new IrohProtocolError(
                `Plain Iroh frame interleaved mid frame_part sequence (expected part ${this.expectedPartIndex})`,
              );
            }
            if (decoded < 0 || decoded > this.maxFrameBytes) {
              throw new IrohProtocolError(`Iroh frame too large: ${decoded} bytes > max ${this.maxFrameBytes}`);
            }
            this.currentSegmentIsPart = false;
            this.expectedLength = decoded;
            this.payload = Buffer.alloc(decoded);
            this.payloadBytes = 0;
            if (decoded === 0) {
              frames.push('');
              this.resetSegment();
            }
          }
        }
      } else {
        const n = Math.min(length - this.payloadBytes, src.length - offset);
        src.copy(this.payload, this.payloadBytes, offset, offset + n);
        this.payloadBytes += n;
        offset += n;
        if (this.payloadBytes === length) {
          if (this.currentSegmentIsPart) {
            this.pendingParts.push(this.payload);
            this.pendingBytes += this.payload.length;
            this.expectedPartIndex += 1;
            const fin = this.currentPartFin;
            this.resetSegment();
            if (fin) frames.push(this.drainPendingParts());
          } else {
            frames.push(this.payload.toString('utf8'));
            this.resetSegment();
          }
        }
      }
    }
    return frames;
  }

  /** Call at end-of-stream: throws if the stream ended mid-frame. */
  finish(): void {
    if (this.prefixBytes !== 0 || this.expectedLength !== null || this.readingPartHeader || this.reassemblyInProgress()) {
      throw new IrohProtocolError('Truncated Iroh frame: stream ended mid-frame');
    }
  }

  private reassemblyInProgress(): boolean {
    return this.pendingParts.length > 0 || this.expectedPartIndex !== 0;
  }

  private beginPartPayload(): void {
    this.readingPartHeader = false;
    this.partHeaderBytes = 0;
    const flags = this.partHeader.readUInt8(0);
    const index = this.partHeader.readInt32BE(1);
    const partLen = this.partHeader.readInt32BE(5);
    if ((flags & ~PART_FLAG_FIN) !== 0) {
      throw new IrohProtocolError(`Unknown frame_part flags: 0x${flags.toString(16)}`);
    }
    if (index !== this.expectedPartIndex) {
      throw new IrohProtocolError(
        `Out-of-sequence frame_part: expected part ${this.expectedPartIndex}, received part ${index}`,
      );
    }
    if (partLen < 1 || partLen > this.maxFrameBytes) {
      throw new IrohProtocolError(`Invalid frame_part payload length: ${partLen} bytes (max ${this.maxFrameBytes})`);
    }
    const max = this.maxReassembledBytes();
    if (this.pendingBytes + partLen > max) {
      throw new FrameTooLargeError(`Reassembled Iroh frame too large: ${this.pendingBytes + partLen} bytes > max ${max}`);
    }
    this.currentSegmentIsPart = true;
    this.currentPartFin = (flags & PART_FLAG_FIN) !== 0;
    this.expectedLength = partLen;
    this.payload = Buffer.alloc(partLen);
    this.payloadBytes = 0;
  }

  private drainPendingParts(): string {
    const out = Buffer.concat(this.pendingParts, this.pendingBytes).toString('utf8');
    this.pendingParts = [];
    this.pendingBytes = 0;
    this.expectedPartIndex = 0;
    return out;
  }

  private resetSegment(): void {
    this.expectedLength = null;
    this.payload = Buffer.alloc(0);
    this.payloadBytes = 0;
    this.currentSegmentIsPart = false;
    this.currentPartFin = false;
  }
}
