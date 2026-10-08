// Busy-lamp (BLF) check against the real Asterisk, with a minimal SIP phone over UDP (see scripts/test-blf.sh):
//   - registers 1001-phone and 1002-phone (digest authentication)
//   - 1001-phone SUBSCRIBEs (Event: dialog) to extension 1002, like a phone's lamp key
//   - scripts/test-blf.sh then makes Asterisk ring 1002-phone; the lamp must go idle -> ringing -> idle
// Exits 0 only when every expected NOTIFY arrived.
const dgram = require('dgram');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HOST = process.env.SIP_HOST || '127.0.0.1';
const SRC = process.env.SRC_IP || '0.0.0.0'; // an address inside LAN_SUBNET: endpoints only accept phones from there
const PORT = 5060;
const DOMAIN = process.env.SIP_DOMAIN || 'communications.local';
const creds = JSON.parse(process.env.CREDS); // { "1001": "pw", "1002": "pw" }
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const rnd = () => crypto.randomBytes(6).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Phone {
  constructor(ext) {
    this.ext = ext;
    this.user = `${ext}-phone`;
    this.sock = dgram.createSocket('udp4');
    this.callId = `${rnd()}@blf`;
    this.cseq = 1;
    this.notifies = [];
    this.invites = [];
    this.waiters = [];
  }

  async start() {
    await new Promise((r) => this.sock.bind(0, SRC, r));
    this.port = this.sock.address().port;
    this.sock.on('message', (buf) => this.onMessage(buf.toString()));
  }

  send(text) { this.sock.send(Buffer.from(text.replace(/\n/g, '\r\n')), PORT, HOST); }

  onMessage(msg) {
    const first = msg.split('\r\n')[0];
    if (first.startsWith('SIP/2.0')) {
      const w = this.waiters.find((x) => msg.includes(`CSeq: ${x.cseq} ${x.method}`));
      if (w) w.resolve(msg);
      return;
    }
    const hdr = (n) => (new RegExp(`^${n}: (.*)$`, 'mi').exec(msg) || [])[1];
    const reply = (code, text, extra = '') => this.send(
      `SIP/2.0 ${code} ${text}\nVia: ${hdr('Via')}\nFrom: ${hdr('From')}\nTo: ${hdr('To')}${/tag=/.test(hdr('To')) ? '' : `;tag=${rnd()}`}\nCall-ID: ${hdr('Call-ID')}\nCSeq: ${hdr('CSeq')}\n${extra}Content-Length: 0\n\n`);
    if (first.startsWith('NOTIFY')) {
      const body = msg.split('\r\n\r\n')[1] || '';
      this.notifies.push({ at: Date.now(), state: (/Subscription-State: (.*)/i.exec(msg) || [])[1], body });
      reply(200, 'OK');
    } else if (first.startsWith('INVITE')) {
      this.invites.push(first);
      reply(180, 'Ringing', `Contact: <sip:${this.user}@${SRC}:${this.port}>\n`);
      this.inviteMsg = msg;
    } else if (first.startsWith('CANCEL')) {
      reply(200, 'OK');
      if (this.inviteMsg) {
        const h2 = (n) => (new RegExp(`^${n}: (.*)$`, 'mi').exec(this.inviteMsg) || [])[1];
        this.send(`SIP/2.0 487 Request Terminated
Via: ${h2('Via')}
From: ${h2('From')}
To: ${h2('To')}${/tag=/.test(h2('To')) ? '' : `;tag=${rnd()}`}
Call-ID: ${h2('Call-ID')}
CSeq: ${h2('CSeq')}
Content-Length: 0

`);
      }
    } else if (first.startsWith('OPTIONS')) {
      reply(200, 'OK');
    }
  }

  request(method, uri, headers, auth) {
    const cseq = this.cseq++;
    const branch = `z9hG4bK${rnd()}`;
    const text = `${method} ${uri} SIP/2.0\nVia: SIP/2.0/UDP ${SRC}:${this.port};branch=${branch};rport\nMax-Forwards: 70\nFrom: <sip:${this.user}@${DOMAIN}>;tag=${this.tag || (this.tag = rnd())}\nTo: <sip:${method === 'SUBSCRIBE' ? this.target : this.user}@${DOMAIN}>${this.toTag && method === 'SUBSCRIBE' ? `;tag=${this.toTag}` : ''}\nCall-ID: ${method === 'SUBSCRIBE' ? this.subCallId : this.callId}\nCSeq: ${cseq} ${method}\nContact: <sip:${this.user}@${SRC}:${this.port}>\nUser-Agent: blf-test\n${headers}${auth ? `Authorization: ${auth}\n` : ''}Content-Length: 0\n\n`;
    return new Promise((resolve) => { this.waiters.push({ cseq, method, resolve }); this.send(text); });
  }

  digest(resp, method, uri) {
    const ch = /WWW-Authenticate: Digest (.*)/i.exec(resp)[1];
    const get = (k) => (new RegExp(`${k}="([^"]*)"`).exec(ch) || [])[1];
    const realm = get('realm'); const nonce = get('nonce');
    const ha1 = md5(`${this.user}:${realm}:${creds[this.ext]}`);
    const ha2 = md5(`${method}:${uri}`);
    const opaque = get('opaque');
    const cnonce = rnd();
    const response = md5(`${ha1}:${nonce}:00000001:${cnonce}:auth:${ha2}`);
    return `Digest username="${this.user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}", algorithm=MD5, qop=auth, nc=00000001, cnonce="${cnonce}"${opaque ? `, opaque="${opaque}"` : ''}`;
  }

  async authed(method, uri, headers) {
    let r = await this.request(method, uri, headers);
    if (/^SIP\/2.0 401/.test(r)) r = await this.request(method, uri, headers, this.digest(r, method, uri));
    return r;
  }

  async register() {
    const r = await this.authed('REGISTER', `sip:${DOMAIN}`, 'Expires: 120\n');
    return r.split('\r\n')[0];
  }

  async subscribe(target) {
    this.target = target;
    this.subCallId = `${rnd()}@blfsub`;
    const uri = `sip:${target}@${DOMAIN}`;
    const r = await this.authed('SUBSCRIBE', uri, 'Event: dialog\nAccept: application/dialog-info+xml\nExpires: 120\n');
    return r.split('\r\n')[0];
  }
}

(async () => {
  const a = new Phone('1001'); const b = new Phone('1002');
  await a.start(); await b.start();
  console.log('REGISTER 1001-phone:', await a.register());
  console.log('REGISTER 1002-phone:', await b.register());
  console.log('SUBSCRIBE 1001 -> 1002:', await a.subscribe('1002'));
  await sleep(1500);
  const show = (label) => {
    const n = a.notifies[a.notifies.length - 1];
    const states = n ? [...n.body.matchAll(/<state[^>]*>([^<]*)<\/state>/g)].map((m) => m[1]) : [];
    console.log(`${label}: ${a.notifies.length} NOTIFY so far; last Subscription-State=${n && n.state}; dialog states=${JSON.stringify(states)}; has dialog element=${n ? /<dialog /.test(n.body) : false}`);
  };
  show('idle');
  // scripts/test-blf.sh rings 1002-phone from Asterisk about four seconds from now and lets it ring for five.
  await sleep(14000);
  const seen = a.notifies.map((n) => [...n.body.matchAll(/<state[^>]*>([^<]*)<\/state>/g)].map((m) => m[1]).join('+') || 'none');
  console.log('1002-phone saw INVITE:', b.invites.length);
  console.log('lamp sequence:', seen.join(' -> '));
  const ok = seen[0] === 'terminated' && seen.includes('early') && seen[seen.length - 1] === 'terminated' && b.invites.length === 1;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
