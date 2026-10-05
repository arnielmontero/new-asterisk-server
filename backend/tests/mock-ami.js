'use strict';
const net = require('node:net');
const { EventEmitter } = require('node:events');

const CRLF = '\r\n';

/**
 * A tiny TCP server speaking enough of the AMI wire protocol to exercise the real
 * AmiClient (login, ping, command, event lists, events, drops). Test-only.
 */
class MockAmi extends EventEmitter {
  constructor({ secret = 'mock-secret', username = 'mock' } = {}) {
    super();
    this.secret = secret;
    this.username = username;
    this.sockets = new Set();
    this.logins = 0;
    this.respondToPing = true;
    this.server = net.createServer((s) => this.onConnection(s));
  }

  listen(port = 0) {
    return new Promise((resolve) => this.server.listen(port, '127.0.0.1', () => resolve(this.server.address().port)));
  }

  get port() { return this.server.address().port; }

  /** Drop every client connection (simulates an Asterisk restart / crash). */
  dropClients() {
    for (const s of this.sockets) s.destroy();
  }

  async close() {
    this.dropClients();
    await new Promise((resolve) => this.server.close(resolve));
  }

  send(socket, fields) {
    socket.write(Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join(CRLF) + CRLF + CRLF);
  }

  broadcastEvent(fields) {
    for (const s of this.sockets) if (s.authed) this.send(s, fields);
  }

  onConnection(socket) {
    this.sockets.add(socket);
    socket.authed = false;
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    socket.write(`Asterisk Call Manager/11.0.0${CRLF}`);
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf(CRLF + CRLF)) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 4);
        const msg = {};
        for (const line of frame.split(CRLF)) {
          const c = line.indexOf(':');
          if (c > -1) msg[line.slice(0, c)] = line.slice(c + 2);
        }
        this.onAction(socket, msg);
      }
    });
  }

  onAction(socket, msg) {
    const id = msg.ActionID;
    this.emit('action', msg);
    switch (msg.Action) {
      case 'Login':
        this.logins += 1;
        if (msg.Username === this.username && msg.Secret === this.secret) {
          socket.authed = true;
          this.send(socket, { Response: 'Success', ActionID: id, Message: 'Authentication accepted' });
        } else {
          this.send(socket, { Response: 'Error', ActionID: id, Message: 'Authentication failed' });
        }
        break;
      case 'Ping':
        if (this.respondToPing) this.send(socket, { Response: 'Success', ActionID: id, Ping: 'Pong' });
        break;
      case 'Logoff':
        this.send(socket, { Response: 'Goodbye', ActionID: id });
        socket.end();
        break;
      case 'PJSIPShowEndpoints':
        this.send(socket, { Response: 'Success', ActionID: id, EventList: 'start', Message: 'A listing of Endpoints follows' });
        this.send(socket, { Event: 'EndpointList', ActionID: id, ObjectName: '1001', DeviceState: 'Not in use' });
        this.send(socket, { Event: 'EndpointList', ActionID: id, ObjectName: '1002', DeviceState: 'Unavailable' });
        this.send(socket, { Event: 'EndpointListComplete', ActionID: id, EventList: 'Complete', ListItems: '2' });
        break;
      case 'Command':
        this.send(socket, { Response: 'Success', ActionID: id, Message: 'Command output follows', Output: 'line one' });
        break;
      case 'Echo':
        this.send(socket, { Response: 'Success', ActionID: id, Echoed: msg.Value || '' });
        break;
      default:
        this.send(socket, { Response: 'Error', ActionID: id, Message: 'Invalid/unknown command' });
    }
  }
}

module.exports = { MockAmi };
