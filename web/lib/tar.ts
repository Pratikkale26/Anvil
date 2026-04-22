import type { EmitFile } from "./constants";

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function octal(v: number, w: number) {
  return v.toString(8).padStart(w - 1, "0") + "\0";
}

function writeStr(buf: Uint8Array, off: number, len: number, val: string) {
  buf.set(new TextEncoder().encode(val.slice(0, len)), off);
}

function toAB(v: Uint8Array): ArrayBuffer {
  return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
}

export function makeTar(files: EmitFile[]): Blob {
  const chunks: BlobPart[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const f of files) {
    const content = new TextEncoder().encode(f.content);
    const hdr = new Uint8Array(512);
    writeStr(hdr, 0, 100, f.path);
    writeStr(hdr, 100, 8, octal(0o644, 8));
    writeStr(hdr, 108, 8, octal(0, 8));
    writeStr(hdr, 116, 8, octal(0, 8));
    writeStr(hdr, 124, 12, octal(content.length, 12));
    writeStr(hdr, 136, 12, octal(now, 12));
    writeStr(hdr, 148, 8, "        ");
    hdr[156] = "0".charCodeAt(0);
    writeStr(hdr, 257, 6, "ustar");
    writeStr(hdr, 263, 2, "00");
    let cs = 0;
    for (const b of hdr) cs += b;
    writeStr(hdr, 148, 8, octal(cs, 8).replace(/\0$/, " "));
    chunks.push(toAB(hdr), toAB(content));
    const pad = (512 - (content.length % 512)) % 512;
    if (pad > 0) chunks.push(toAB(new Uint8Array(pad)));
  }
  chunks.push(toAB(new Uint8Array(1024)));
  return new Blob(chunks, { type: "application/x-tar" });
}
