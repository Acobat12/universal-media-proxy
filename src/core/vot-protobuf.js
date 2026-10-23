const utf8 = new TextDecoder('utf-8', { fatal: true });
function readVarint(buf, pos) {
  let val = 0, shift = 0, p = pos;
  for (let i = 0; i < 5; i++) {
    if (p >= buf.length) throw Error('Truncated protobuf');
    const b = buf[p++]; val += (b & 127) * 2 ** shift;
    if (!(b & 128)) return [val, p];
    shift += 7;
  }
  throw Error('Unsupported protobuf varint');
}
// Accept only the canonical proxy URL in protobuf field 3, already signed by the client.
function signedProxyMediaUrl(payload) {
  let pos = 0, result = null;
  while (pos < payload.length) {
    const [tag, afterTag] = readVarint(payload, pos);
    const field = tag >>> 3, wire = tag & 7;
    if (!field) throw Error('Invalid protobuf field');
    pos = afterTag;
    if (wire === 0) { [, pos] = readVarint(payload, pos); }
    else if (wire === 1 || wire === 5) pos += wire === 1 ? 8 : 4;
    else if (wire === 2) {
      const [len, start] = readVarint(payload, pos);
      pos = start + len;
      if (pos > payload.length) throw Error('Truncated protobuf');
      if (field === 3) {
        if (result !== null) throw Error('Duplicate protobuf video URL');
        result = utf8.decode(payload.subarray(start, pos));
      }
    } else throw Error('Unsupported protobuf wire type');
    if (pos > payload.length) throw Error('Truncated protobuf');
  }
  return result;
}

export function signedProxyMediaUrlFromEnvelope(envelope) {
  let pos = 0, result = null;
  while (pos < envelope.length) {
    const [tag, next] = readVarint(envelope, pos);
    if ((tag & 7) !== 2) throw Error('Invalid VOT envelope');
    const [len, start] = readVarint(envelope, next);
    const end = start + len;
    if (end > envelope.length) throw Error('Truncated VOT envelope');
    if ((tag >>> 3) === 2) {
      if (result !== null) throw Error('Duplicate envelope body');
      result = signedProxyMediaUrl(envelope.subarray(start, end));
    }
    pos = end;
  }
  return result;
}

