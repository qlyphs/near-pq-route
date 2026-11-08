// Pads a Wasm module to an exact size with one custom section, for maximum-size upgrade tests.
// Usage: node scripts/pad-wasm.mjs <in.wasm> <out.wasm> <size>
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output, sizeArg] = process.argv.slice(2);
const size = Number(sizeArg);
const wasm = readFileSync(input);
const leb = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };
const name = Buffer.from('padding');
// Section = id (1) + LEB(size of body) + body, body = LEB(name length) + name + payload. Solve for payload.
for (let payload = 0; payload <= size; payload++) {
  const body = Buffer.concat([leb(name.length), name, Buffer.alloc(payload)]);
  const section = Buffer.concat([Buffer.from([0]), leb(body.length), body]);
  if (wasm.length + section.length === size) {
    const out = Buffer.concat([wasm, section]);
    new WebAssembly.Module(out); // still a valid module
    writeFileSync(output, out);
    process.exit(0);
  }
  if (wasm.length + section.length > size) break;
}
throw new Error(`cannot pad ${input} to exactly ${size} bytes`);
