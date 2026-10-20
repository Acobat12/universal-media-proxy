import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createVotGateway } from '../src/vot-gateway.js';

test('VOT gateway rejects invalid path and requires configured key', async () => {
 const gateway = createVotGateway({ key: 'a'.repeat(32) });
 const server = http.createServer(gateway); await new Promise(r => server.listen(0, '127.0.0.1', r));
 try { const base = `http://127.0.0.1:${server.address().port}`;
   assert.equal((await fetch(base+'/vot/not-valid')).status, 404);
   assert.equal((await fetch(base+'/vot/video-translation/translate', { method: 'POST' })).status, 401);
 } finally { await new Promise(r => server.close(r)); }
});
