// Gzip, through the platform's own streams — no library, in either runtime.
//
// A backup's table parts go up compressed and come back down the same way,
// and both the function that writes them and the function that reads them
// have to agree byte for byte, so the pair lives in one file.
//
// Erasable TypeScript only and no imports: the node suite exercises this
// file directly.

export async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
