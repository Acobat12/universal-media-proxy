import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createVotGateway } from '../src/vot-gateway.js';

test('VOT gateway is public and rejects invalid routes', async () => {
 const gateway = createVotGateway();
 const server = http.createServer(gateway);
 await new Promise(r => server.listen(0, '127.0.0.1', r));
 try {
   const base = `http://127.0.0.1:${server.address().port}`;
   assert.equal((await fetch(base+'/vot/not-valid')).status, 404);
   const res = await fetch(base+'/vot/video-translation/translate', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
   assert.notEqual(res.status, 401);
 } finally { await new Promise(r => server.close(r)); }
});
