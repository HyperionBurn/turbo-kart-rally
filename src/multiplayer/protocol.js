// Shared input-packet protocol for Turbo Kart Rally event mode.
// A single binary frame layout keeps hot-path parsing allocation-free and tiny.
//
//  INPUT FRAME (client -> server -> host, type byte 0x01 inside payload):
//   [0]  byte   magic 0x54 ('T')
//   [1]  byte   msg type 0x01 (INPUT)
//   [2]  u16le  teamId (1..6, 0 = unassigned)
//   [4]  u32le  sessionId (slot session; rejects stale senders)
//   [8]  u32le  seq (monotonic per client)
//   [12] f64le  clientTimestampMs (client performance.now())
//   [20] i8     steer  (-127..127 -> -1..1)
//   [21] u8     throttle (0..255)
//   [22] u8     brake
//   [23] u8     flags: bit0 drift, bit1 lookBack, bit2 itemEdge, bit3 hopEdge, bit4 pauseEdge
// Total: 24 bytes.
export const MAGIC = 0x54;
export const TYPE_INPUT = 0x01;
export const INPUT_SIZE = 24;

export function encodeInput({ teamId, sessionId, seq, timestamp, steer, throttle, brake, flags }) {
  const b = new Uint8Array(INPUT_SIZE);
  const v = new DataView(b.buffer);
  b[0] = MAGIC;
  b[1] = TYPE_INPUT;
  v.setUint16(2, teamId & 0xffff, true);
  v.setUint32(4, sessionId >>> 0, true);
  v.setUint32(8, seq >>> 0, true);
  v.setFloat64(12, timestamp, true);
  v.setInt8(20, Math.max(-127, Math.min(127, Math.round(steer * 127))));
  b[21] = Math.max(0, Math.min(255, Math.round(throttle * 255)));
  b[22] = Math.max(0, Math.min(255, Math.round(brake * 255)));
  b[23] = flags & 0xff;
  return b;
}

export function decodeInput(buf) {
  let b;
  if (buf instanceof Uint8Array) b = buf;
  else if (buf instanceof ArrayBuffer) b = new Uint8Array(buf);
  else if (ArrayBuffer.isView(buf)) b = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  else return null;
  if (b.length < INPUT_SIZE || b[0] !== MAGIC || b[1] !== TYPE_INPUT) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    teamId: v.getUint16(2, true),
    sessionId: v.getUint32(4, true),
    seq: v.getUint32(8, true),
    timestamp: v.getFloat64(12, true),
    steer: v.getInt8(20) / 127,
    throttle: b[21] / 255,
    brake: b[22] / 255,
    flags: b[23],
  };
}

export const FLAG_DRIFT = 1;
export const FLAG_LOOKBACK = 2;
export const FLAG_ITEM = 4;
export const FLAG_HOP = 8;
export const FLAG_PAUSE = 16;

/** Decode flags into the kart input shape, edge flags consumed by host. */
export function flagsToState(flags) {
  return {
    drift: !!(flags & FLAG_DRIFT),
    lookBack: !!(flags & FLAG_LOOKBACK),
    itemEdge: !!(flags & FLAG_ITEM),
    hopEdge: !!(flags & FLAG_HOP),
    pauseEdge: !!(flags & FLAG_PAUSE),
  };
}
