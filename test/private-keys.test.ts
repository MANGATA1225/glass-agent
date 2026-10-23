import assert from 'node:assert/strict';
import test from 'node:test';
import { PrivateKeyStreamRedactor } from '../src/private-keys.ts';
import { redactSecrets } from '../src/secrets.ts';
import { safeOutput, SafeOutputStream } from '../src/output.ts';

const root = '/Users/example/glass-agent';

for (const type of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
  test(`${type} is hidden at every transport split`, () => {
    const input = `before -----BEGIN ${type}-----\r\nFAKE-BODY/abc+123\r\n-----END ${type}----- after`;
    for (let split = 0; split <= input.length; split++) {
      let output = '';
      const stream = new SafeOutputStream(root, chunk => { output += chunk; });
      stream.write(input.slice(0, split));
      assert.ok(!output.includes('FAKE'), `leak before split ${split}`);
      stream.write(input.slice(split));
      stream.finish();
      assert.equal(output, safeOutput(input, root), `split ${split}`);
      assert.equal(output, 'before [REDACTED PRIVATE KEY] after');
    }
  });
}

test('byte chunks hide multiple keys while preserving surrounding credentials and paths', () => {
  const key = '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----';
  const input = `open ${root}/src\n${key}\ntoken=opaqueValue123\n${key}\ndone`;
  let output = '';
  const stream = new SafeOutputStream(root, chunk => { output += chunk; });
  for (const byte of input) {
    stream.write(byte);
    assert.ok(!output.includes('FAKE'));
  }
  stream.finish();
  assert.equal(output, safeOutput(input, root));
});

test('unterminated keys and mismatched footers fail closed on finish', () => {
  for (const tail of ['', '\n-----END RSA PRIVATE KEY-----\nmore body']) {
    const input = `before -----BEGIN PRIVATE KEY-----\nFAKE${tail}`;
    let output = '';
    const stream = new SafeOutputStream(root, chunk => { output += chunk; });
    stream.write(input);
    assert.equal(output, 'before [REDACTED PRIVATE KEY]');
    stream.finish();
    stream.finish();
    assert.equal(output, 'before [REDACTED PRIVATE KEY]');
    assert.equal(redactSecrets(input), output);
  }
});

test('long key bodies are discarded while waiting for a split matching footer', () => {
  const stream = new PrivateKeyStreamRedactor();
  assert.equal(stream.write('-----BEGIN RSA PRIVATE KEY-----'), '[REDACTED PRIVATE KEY]');
  for (let i = 0; i < 100; i++) assert.equal(stream.write('A'.repeat(10_000)), '');
  assert.equal(stream.write('-----END RSA PRI'), '');
  assert.equal(stream.write('VATE KEY----- visible'), ' visible');
  assert.equal(stream.finish(), '');
});

test('non-private PEM blocks, ordinary dashes and incomplete prefixes remain readable', () => {
  for (const input of ['-----BEGIN CERTIFICATE-----\nPUBLIC\n-----END CERTIFICATE-----',
    'hello -', '-----BEGIN ', '-----BEGIN RSA PRIV', 'ordinary text']) {
    const stream = new PrivateKeyStreamRedactor();
    let output = '';
    for (const char of input) output += stream.write(char);
    output += stream.finish();
    assert.equal(output, input);
  }
});
