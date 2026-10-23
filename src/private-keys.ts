const BEGIN = '-----BEGIN ';
const PRIVATE_KEY_BEGIN = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----/;
const PRIVATE_KEY_BLOCK = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g;
const INCOMPLETE_HEADER = /-----BEGIN [A-Z ]*(?:-{1,4})?$/;
const REDACTED = '[REDACTED PRIVATE KEY]';

export function redactPrivateKeys(text: string): string {
  return text.replace(PRIVATE_KEY_BLOCK, REDACTED);
}

// Retain possible BEGIN headers across writes. Once a private key is recognized,
// discard its body and retain only enough text to recognize the matching END.
// No key material needs to be buffered until completion.
export class PrivateKeyStreamRedactor {
  private pending = '';
  private endMarker: string | undefined;

  write(delta: string): string {
    this.pending += delta;
    let output = '';
    while (this.pending) {
      if (this.endMarker) {
        const end = this.pending.indexOf(this.endMarker);
        if (end < 0) {
          this.pending = this.pending.slice(-(this.endMarker.length - 1));
          break;
        }
        this.pending = this.pending.slice(end + this.endMarker.length);
        this.endMarker = undefined;
        continue;
      }

      const begin = PRIVATE_KEY_BEGIN.exec(this.pending);
      if (begin) {
        output += this.pending.slice(0, begin.index) + REDACTED;
        this.pending = this.pending.slice(begin.index + begin[0].length);
        this.endMarker = `-----END ${begin[1]}-----`;
        continue;
      }

      // A header can split anywhere, including within the key type or dashes.
      let held = INCOMPLETE_HEADER.exec(this.pending)?.[0].length ?? 0;
      for (let length = 1; length < BEGIN.length && length <= this.pending.length; length++) {
        if (this.pending.endsWith(BEGIN.slice(0, length))) held = Math.max(held, length);
      }
      output += this.pending.slice(0, this.pending.length - held);
      this.pending = this.pending.slice(this.pending.length - held);
      break;
    }
    return output;
  }

  finish(): string {
    // An opened key remains redacted even if the stream ends or fails early.
    const tail = this.endMarker ? '' : this.pending;
    this.pending = '';
    this.endMarker = undefined;
    return tail;
  }
}
