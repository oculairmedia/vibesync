import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_FRAME_BYTES,
  FRAME_PART_CAPABILITY,
  FrameDecoder,
  FrameTooLargeError,
  IrohProtocolError,
  encodeFrame,
  encodeFrameParts,
} from '../../../../../src/orchestration/runtime/iroh/frame-codec.js';

function feedAll(decoder: FrameDecoder, wire: Uint8Array[], chunkSize?: number): string[] {
  const out: string[] = [];
  for (const w of wire) {
    if (!chunkSize) {
      out.push(...decoder.feed(w));
      continue;
    }
    for (let i = 0; i < w.length; i += chunkSize) out.push(...decoder.feed(w.subarray(i, i + chunkSize)));
  }
  return out;
}

describe('iroh frame codec (port of IrohFrameCodec.kt)', () => {
  it('advertises the frame_part capability string', () => {
    expect(FRAME_PART_CAPABILITY).toBe('frame_part');
  });

  it('round-trips a plain frame as 4-byte BE length + utf8', () => {
    const wire = encodeFrame('{"a":"héllo"}');
    const payload = Buffer.from('{"a":"héllo"}', 'utf8');
    expect(Buffer.from(wire.subarray(0, 4)).readUInt32BE(0)).toBe(payload.length);
    expect(Buffer.from(wire.subarray(4)).equals(payload)).toBe(true);
    expect(feedAll(new FrameDecoder(), [wire])).toEqual(['{"a":"héllo"}']);
  });

  it('decodes frames fed one byte at a time and several frames per chunk', () => {
    const a = encodeFrame('one');
    const b = encodeFrame('two');
    expect(feedAll(new FrameDecoder(), [a, b], 1)).toEqual(['one', 'two']);
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a, 0);
    joined.set(b, a.length);
    expect(new FrameDecoder().feed(joined)).toEqual(['one', 'two']);
  });

  it('decodes an empty (zero-length) plain frame', () => {
    expect(new FrameDecoder().feed(encodeFrame(''))).toEqual(['']);
  });

  it('keeps a frame that fits in one part as a single plain frame', () => {
    const parts = encodeFrameParts('small', 16);
    expect(parts).toHaveLength(1);
    expect(Buffer.from(parts[0]!.subarray(0, 4)).readUInt32BE(0)).toBe(5);
  });

  it('splits an oversize frame into sentinel parts: flags/index/len header, FIN only on last', () => {
    const text = 'x'.repeat(25);
    const parts = encodeFrameParts(text, 10);
    expect(parts).toHaveLength(3);
    const view = parts.map((p) => Buffer.from(p));
    for (const [i, p] of view.entries()) {
      expect(p.readUInt32BE(0)).toBe(0x7fffffff);
      expect(p.readUInt8(4)).toBe(i === 2 ? 0x01 : 0x00);
      expect(p.readUInt32BE(5)).toBe(i);
      expect(p.readUInt32BE(9)).toBe(i === 2 ? 5 : 10);
      expect(p.length).toBe(13 + p.readUInt32BE(9));
    }
  });

  it('reassembles frame_part sequences, including across tiny chunk boundaries', () => {
    const text = JSON.stringify({ type: 'big', body: 'é'.repeat(40) });
    const parts = encodeFrameParts(text, 16);
    expect(parts.length).toBeGreaterThan(2);
    expect(feedAll(new FrameDecoder(16), parts)).toEqual([text]);
    expect(feedAll(new FrameDecoder(16), parts, 3)).toEqual([text]);
  });

  it('resets reassembly after FIN so a second multi-part frame decodes', () => {
    const t1 = 'a'.repeat(30);
    const t2 = 'b'.repeat(30);
    const wire = [...encodeFrameParts(t1, 8), encodeFrame('plain'), ...encodeFrameParts(t2, 8)];
    expect(feedAll(new FrameDecoder(8), wire)).toEqual([t1, 'plain', t2]);
  });

  it('rejects an out-of-order part index', () => {
    const parts = encodeFrameParts('y'.repeat(30), 10);
    const dec = new FrameDecoder(10);
    dec.feed(parts[0]!);
    expect(() => dec.feed(parts[2]!)).toThrow(IrohProtocolError);
    expect(() => new FrameDecoder(10).feed(parts[1]!)).toThrow(/Out-of-sequence/);
  });

  it('rejects a plain frame interleaved mid frame_part sequence', () => {
    const parts = encodeFrameParts('z'.repeat(30), 10);
    const dec = new FrameDecoder(10);
    dec.feed(parts[0]!);
    expect(() => dec.feed(encodeFrame('plain'))).toThrow(/interleaved/);
  });

  it('rejects unknown part flags and zero-length / oversize part payloads', () => {
    const bad = Buffer.alloc(13);
    bad.writeUInt32BE(0x7fffffff, 0);
    bad.writeUInt8(0x02, 4);
    bad.writeUInt32BE(0, 5);
    bad.writeUInt32BE(4, 9);
    expect(() => new FrameDecoder().feed(bad)).toThrow(/Unknown frame_part flags/);

    const zero = Buffer.alloc(13);
    zero.writeUInt32BE(0x7fffffff, 0);
    zero.writeUInt8(0x01, 4);
    zero.writeUInt32BE(0, 5);
    zero.writeUInt32BE(0, 9);
    expect(() => new FrameDecoder().feed(zero)).toThrow(/Invalid frame_part payload length/);

    const big = Buffer.from(zero);
    big.writeUInt32BE(11, 9);
    expect(() => new FrameDecoder(10).feed(big)).toThrow(/Invalid frame_part payload length/);
  });

  it('rejects an oversize plain frame on decode and on encode', () => {
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32BE(DEFAULT_MAX_FRAME_BYTES + 1, 0);
    expect(() => new FrameDecoder().feed(hdr)).toThrow(IrohProtocolError);
    expect(() => encodeFrame('x'.repeat(11), 10)).toThrow(FrameTooLargeError);
  });

  it('rejects a reassembled frame above the cap (typed) and an encode above the cap', () => {
    const parts = encodeFrameParts('q'.repeat(40), 10);
    const dec = new FrameDecoder(10, 25);
    dec.feed(parts[0]!);
    dec.feed(parts[1]!);
    expect(() => dec.feed(parts[2]!)).toThrow(FrameTooLargeError);
    expect(() => encodeFrameParts('q'.repeat(40), 10, 30)).toThrow(FrameTooLargeError);
  });

  it('finish() flags a stream that ended mid-frame, and is quiet on a clean end', () => {
    const dec = new FrameDecoder();
    dec.feed(encodeFrame('ok'));
    expect(() => dec.finish()).not.toThrow();
    const trunc = new FrameDecoder();
    trunc.feed(encodeFrame('hello').subarray(0, 6));
    expect(() => trunc.finish()).toThrow(/Truncated/);
    const midParts = new FrameDecoder(10);
    midParts.feed(encodeFrameParts('m'.repeat(30), 10)[0]!);
    expect(() => midParts.finish()).toThrow(/Truncated/);
  });
});
