'use strict';
/**
 * Minecraft Server List Ping (https://wiki.vg/Server_List_Ping).
 * Pure Node - no Electron dependency, so it can be unit-tested.
 */
const net = require('net');

function writeVarInt(value) {
  const out = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return Buffer.from(out);
}

function readVarInt(buf, offset) {
  let num = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    num |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
    if (shift >= 35) throw new Error('VarInt too long');
  }
  return { value: num, bytes: i - offset };
}

function stripCodes(s) {
  return String(s).replace(/\u00a7[0-9a-fk-or]/gi, '');
}

function describeMotd(desc) {
  if (!desc) return '';
  if (typeof desc === 'string') return stripCodes(desc);
  let text = stripCodes(desc.text || '');
  if (Array.isArray(desc.extra)) {
    for (const part of desc.extra) text += describeMotd(part);
  }
  return text;
}

/** Status ping. Always resolves: { online, motd, playersOnline, playersMax, version }. */
function pingServer(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ online: false }), timeoutMs);
    const socket = net.createConnection({ host, port: Number(port) || 25565 });
    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(Number(port) || 25565, 0);
      const handshake = Buffer.concat([
        writeVarInt(0x00),
        writeVarInt(47), // protocol version; any value is accepted for status
        writeVarInt(hostBuf.length),
        hostBuf,
        portBuf,
        writeVarInt(1), // next state: status
      ]);
      const request = writeVarInt(0x00);
      socket.write(Buffer.concat([writeVarInt(handshake.length), handshake]));
      socket.write(Buffer.concat([writeVarInt(request.length), request]));
    });

    let data = Buffer.alloc(0);
    let finished = false;
    const done = (r) => { if (!finished) { finished = true; finish(r); } };
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      try {
        const { value: length, bytes: lb } = readVarInt(data, 0);
        if (data.length < lb + length) return; // incomplete packet, wait for more
        const { value: packetId, bytes: pb } = readVarInt(data, lb);
        if (packetId !== 0x00) return done({ online: false });
        const { value: strLen, bytes: sb } = readVarInt(data, lb + pb);
        if (data.length < lb + pb + sb + strLen) return;
        const jsonStr = data.slice(lb + pb + sb, lb + pb + sb + strLen).toString('utf8');
        const json = JSON.parse(jsonStr);
        done({
          online: true,
          motd: describeMotd(json.description),
          playersOnline: json.players ? json.players.online : 0,
          playersMax: json.players ? json.players.max : 0,
          version: json.version ? json.version.name : '',
        });
      } catch {
        // incomplete data; keep waiting until timeout
      }
    });

    socket.on('error', () => done({ online: false }));
    socket.on('timeout', () => done({ online: false }));
    socket.on('close', () => done({ online: false }));
  });
}

module.exports = { pingServer, writeVarInt, readVarInt, stripCodes, describeMotd };
