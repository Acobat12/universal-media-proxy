#!/usr/bin/env python3
# Apply on the proxy server: python3 patch-media-server.py
from pathlib import Path
import shutil, datetime
p=Path('/opt/universal-media-proxy/src/media-translation.js')
s=p.read_text()
if 'function signedProxyMediaUrl(' in s:
    print('Already patched'); raise SystemExit(0)
anchor='export async function prepareMediaTranslation(body, { publicBaseUrl }) {'
assert s.count(anchor)==1, 'Cannot find prepareMediaTranslation; no changes made'
helper=r'''// Accept only the canonical proxy URL in protobuf field 3, already signed by the client.
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

'''
s=s.replace(anchor,helper+anchor)
needle='  const mediaUrl = stableMediaUrl(videoUrl, publicBaseUrl);'
assert s.count(needle)==1, 'Cannot find mediaUrl calculation; no changes made'
s=s.replace(needle,needle+'''
  // The UserScript generated this URL before signing. Preserve the exact bytes.
  if (found.sourceVideoUrl && unique.length === 0) {
    const signedUrl = signedProxyMediaUrlFromEnvelope(body);
    if (signedUrl === mediaUrl) {
      console.log('[MEDIA MODE] signed proxy media URL accepted; forwarding unchanged');
      return { body, mediaUrl };
    }
  }
''')
# Extract field 2 directly from envelope (do not assume field order).
helper2=r'''function signedProxyMediaUrlFromEnvelope(envelope) {
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

'''
s=s.replace(anchor,helper2+anchor)
backup=p.with_suffix('.js.bak-'+datetime.datetime.now().strftime('%Y%m%d%H%M%S'))
shutil.copy2(p,backup)
p.write_text(s)
print('Patched:',p,'Backup:',backup)
