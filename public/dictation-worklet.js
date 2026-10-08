class DictationProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(1024);
    this.offset = 0;
    this.port.onmessage = () => {
      this.flush();
      this.port.postMessage("flushed");
    };
  }

  flush() {
    if (this.offset > 0) {
      const buffer = new ArrayBuffer(this.offset * 2);
      const view = new DataView(buffer);
      for (let index = 0; index < this.offset; index++) {
        view.setInt16(index * 2, this.samples[index], true);
      }
      this.port.postMessage(buffer, [buffer]);
      this.offset = 0;
    }
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (const sample of channel) {
        const clipped = Math.max(-1, Math.min(1, sample));
        this.samples[this.offset++] = Math.round(clipped * (clipped < 0 ? 32768 : 32767));
        if (this.offset === this.samples.length) this.flush();
      }
    }
    return true;
  }
}

registerProcessor("dictation", DictationProcessor);
