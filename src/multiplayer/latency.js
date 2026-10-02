// NTP-style clock offset estimation + rolling latency statistics.
// Used on phones (controller) and the host browser; the local server echoes timestamps.
//
// For a peer X talking to the server S:
//   offset_client_minus_server ≈ mean(clientSend+clientRecv)/2 - serverEcho
// We keep a rolling window of offset samples and expose the median.
export class ClockSync {
  constructor(windowSize = 24) {
    this.samples = [];
    this.windowSize = windowSize;
    this.offset = 0; // peerClock - serverClock, ms
  }
  /** Call when a pong arrives: tSend/tRecv are local times, serverT is server's single timestamp. */
  addSample(tSend, tRecv, serverT) {
    const o = (tSend + tRecv) / 2 - serverT;
    this.samples.push(o);
    if (this.samples.length > this.windowSize) this.samples.shift();
    this.offset = median(this.samples);
    return this.offset;
  }
}

export function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
}
export function percentile(a, p) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

/** Rolling RTT/jitter/loss statistics for one link. */
export class LinkStats {
  constructor(windowSize = 64) {
    this.windowSize = windowSize;
    this.rtts = [];
    this.updates = 0;        // packets sent (client) or received (host)
    this.dropped = 0;        // stale/out-of-order packets discarded
    this.outOfOrder = 0;
    this.disconnects = 0;
    this.reconnects = 0;
    this.lastSeq = -1;
    this._windowStart = now();
    this.rate = 0;           // updates per second over last window
  }
  addRtt(rtt) {
    this.rtts.push(rtt);
    if (this.rtts.length > this.windowSize) this.rtts.shift();
  }
  addUpdate(seq) {
    this.updates++;
    if (seq <= this.lastSeq && this.lastSeq >= 0) { this.outOfOrder++; this.dropped++; }
    else this.lastSeq = seq;
    const t = now();
    if (t - this._windowStart > 1000) {
      this.rate = this.updates / ((t - this._windowStart) / 1000);
      this._windowStart = t;
      this.updates = 0;
    }
  }
  get currentRtt() { return this.rtts.length ? this.rtts[this.rtts.length - 1] : 0; }
  get p50() { return percentile(this.rtts, 50); }
  get p95() { return percentile(this.rtts, 95); }
  get p99() { return percentile(this.rtts, 99); }
  /** Mean absolute successive difference. */
  get jitter() {
    if (this.rtts.length < 2) return 0;
    let s = 0;
    for (let i = 1; i < this.rtts.length; i++) s += Math.abs(this.rtts[i] - this.rtts[i - 1]);
    return s / (this.rtts.length - 1);
  }
  snapshot() {
    return {
      rtt: this.currentRtt, p50: this.p50, p95: this.p95, p99: this.p99,
      jitter: this.jitter, rate: Math.round(this.rate), outOfOrder: this.outOfOrder,
      dropped: this.dropped, disconnects: this.disconnects, reconnects: this.reconnects,
    };
  }
}

/** Thresholds used to color-code diagnostics. */
export function qualityOf({ p95, jitter }) {
  if (p95 <= 30 && jitter <= 10) return 'good';
  if (p95 <= 60 && jitter <= 25) return 'warn';
  return 'bad';
}

function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
