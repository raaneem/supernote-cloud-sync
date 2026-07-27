const encoder = new TextEncoder();

const block = (content: Uint8Array): Uint8Array => {
  const bytes = new Uint8Array(content.byteLength + 4);
  new DataView(bytes.buffer).setUint32(0, content.byteLength, true);
  bytes.set(content, 4);
  return bytes;
};

const textBlock = (content: string): Uint8Array =>
  block(encoder.encode(content));

export const sanitizedWhiteNote = (): Uint8Array => {
  const signature = encoder.encode("noteSN_FILE_VER_20260016");
  if (signature.byteLength !== 24) {
    throw new Error("Sanitized Supernote signature must be 24 bytes");
  }
  const chunks: Uint8Array[] = [signature];
  let address = signature.byteLength;
  const append = (chunk: Uint8Array): number => {
    const chunkAddress = address;
    chunks.push(chunk);
    address += chunk.byteLength;
    return chunkAddress;
  };

  append(textBlock("<APPLY_EQUIPMENT:N5><FINALOPERATION_PAGE:1>"));
  const whitePage = new Uint8Array(300 * 2);
  for (let run = 0; run < 300; run += 1) {
    whitePage[run * 2] = 0x65;
    whitePage[run * 2 + 1] = 0xff;
  }
  const backgroundBitmap = append(block(whitePage));
  const backgroundLayer = append(
    textBlock(
      `<LAYERTYPE:NOTE><LAYERPROTOCOL:RATTA_RLE><LAYERNAME:BGLAYER><LAYERBITMAP:${backgroundBitmap}>`,
    ),
  );
  const page = append(
    textBlock(
      `<PAGESTYLE:style_white_a5x2><PAGESTYLEMD5:sanitized><MAINLAYER:0><LAYER1:0><LAYER2:0><LAYER3:0><BGLAYER:${backgroundLayer}><LAYERSEQ:MAINLAYER,BGLAYER><LAYERINFO:[]>`,
    ),
  );
  const footer = append(textBlock(`<FILE_FEATURE:24><PAGE1:${page}>`));
  const footerPointer = new Uint8Array(4);
  new DataView(footerPointer.buffer).setUint32(0, footer, true);
  chunks.push(footerPointer);

  const bytes = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};
