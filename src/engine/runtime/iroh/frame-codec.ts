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

  /**
   * Decode every complete frame in `chunk`. A chunk may end anywhere (inside a
   * length prefix, a part header or a payload); the decoder keeps that partial
   * state and resumes on the next chunk.
   */
  feed(chunk: Uint8Array): string[] {
    const frames: string[] = [];
    const src = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    while (offset < src.length) {
      offset = this.consume(src, offset, frames);
    }
    return frames;
  }

  /** Read as much of the current field as `src` holds from `offset`; return the new offset. */
  private consume(src: Buffer, offset: number, frames: string[]): number {
    if (this.readingPartHeader) return this.readPartHeader(src, offset);
    if (this.expectedLength === null) return this.readLengthPrefix(src, offset, frames);
    return this.readPayload(src, offset, this.expectedLength, frames);
  }

  private readPartHeader(src: Buffer, offset: number): number {
    const n = fill(src, offset, this.partHeader, this.partHeaderBytes);
    this.partHeaderBytes += n;
    if (this.partHeaderBytes === PART_HEADER_BYTES) this.beginPartPayload();
    return offset + n;
  }

  private readLengthPrefix(src: Buffer, offset: number, frames: string[]): number {
    const n = fill(src, offset, this.prefix, this.prefixBytes);
    this.prefixBytes += n;
    if (this.prefixBytes === LENGTH_PREFIX_BYTES) {
      this.prefixBytes = 0;
      this.beginSegment(this.prefix.readInt32BE(0), frames);
    }
    return offset + n;
  }

  /** A complete length prefix: either the frame_part sentinel or the size of a plain frame. */
  private beginSegment(decoded: number, frames: string[]): void {
    if (decoded === PART_SENTINEL) {
      this.readingPartHeader = true;
      this.partHeaderBytes = 0;
      return;
    }
    if (this.reassemblyInProgress()) {
      throw new IrohProtocolError(
        `Plain Iroh frame interleaved mid frame_part sequence (expected part ${this.expectedPartIndex})`,
      );
    }
    if (decoded < 0 || decoded > this.maxFrameBytes) {
      throw new IrohProtocolError(`Iroh frame too large: ${decoded} bytes > max ${this.maxFrameBytes}`);
    }
    this.startPayload(decoded, false, false);
    if (decoded === 0) {
      frames.push('');
      this.resetSegment();
    }
  }

  private readPayload(src: Buffer, offset: number, length: number, frames: string[]): number {
    const n = Math.min(length - this.payloadBytes, src.length - offset);
    src.copy(this.payload, this.payloadBytes, offset, offset + n);
    this.payloadBytes += n;
    if (this.payloadBytes === length) this.completeSegment(frames);
    return offset + n;
  }

  /** A whole payload has arrived: emit a plain frame, or bank a part and emit on FIN. */
  private completeSegment(frames: string[]): void {
    if (!this.currentSegmentIsPart) {
      frames.push(this.payload.toString('utf8'));
      this.resetSegment();
      return;
    }
    this.pendingParts.push(this.payload);
    this.pendingBytes += this.payload.length;
    this.expectedPartIndex += 1;
    const fin = this.currentPartFin;
    this.resetSegment();
    if (fin) frames.push(this.drainPendingParts());
  }

  private startPayload(length: number, isPart: boolean, fin: boolean): void {
    this.currentSegmentIsPart = isPart;
    this.currentPartFin = fin;
    this.expectedLength = length;
    this.payload = Buffer.alloc(length);
    this.payloadBytes = 0;
  }

  /** Call at end-of-stream: throws if the stream ended mid-frame. */
  finish(): void {
    if (this.midFrame()) {
      throw new IrohProtocolError('Truncated Iroh frame: stream ended mid-frame');
    }
  }

  /** Any field partly read, or a frame_part sequence not yet closed by FIN. */
  private midFrame(): boolean {
    const partialField = this.prefixBytes !== 0 || this.expectedLength !== null || this.readingPartHeader;
    return partialField || this.reassemblyInProgress();
  }

  private reassemblyInProgress(): boolean {
    return this.pendingParts.length > 0 || this.expectedPartIndex !== 0;
  }

  private beginPartPayload(): void {
    this.readingPartHeader = false;
    this.partHeaderBytes = 0;
    const flags = this.partHeader.readUInt8(0);
    const partLen = this.partHeader.readInt32BE(5);
    this.checkPartHeader(flags, this.partHeader.readInt32BE(1), partLen);
    this.startPayload(partLen, true, (flags & PART_FLAG_FIN) !== 0);
  }

  /** A part header must carry known flags, the next index in sequence, and a length that fits. */
  private checkPartHeader(flags: number, index: number, partLen: number): void {
    if ((flags & ~PART_FLAG_FIN) !== 0) {
      throw new IrohProtocolError(`Unknown frame_part flags: 0x${flags.toString(16)}`);
    }
    if (index !== this.expectedPartIndex) {
      throw new IrohProtocolError(
        `Out-of-sequence frame_part: expected part ${this.expectedPartIndex}, received part ${index}`,
      );
    }
    this.checkPartLength(partLen);
  }

  /** A part carries 1..maxFrameBytes bytes, and the frame it adds to stays within the reassembly cap. */
  private checkPartLength(partLen: number): void {
    if (partLen < 1 || partLen > this.maxFrameBytes) {
      throw new IrohProtocolError(`Invalid frame_part payload length: ${partLen} bytes (max ${this.maxFrameBytes})`);
    }
    const max = this.maxReassembledBytes();
    if (this.pendingBytes + partLen > max) {
      throw new FrameTooLargeError(`Reassembled Iroh frame too large: ${this.pendingBytes + partLen} bytes > max ${max}`);
    }
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

/** Copy from `src` at `offset` into `target` at `filled`, as much as both have room for; return the count. */
function fill(src: Buffer, offset: number, target: Buffer, filled: number): number {
  const n = Math.min(target.length - filled, src.length - offset);
  src.copy(target, filled, offset, offset + n);
  return n;
}
