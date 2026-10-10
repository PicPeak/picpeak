const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
process.env.NODE_ENV = 'test';
process.env.DATABASE_CLIENT = 'sqlite3';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mail-native-imap-')), 'db.sqlite');
process.env.SKIP_S3_TESTS = 'true';
process.env.JWT_SECRET = 'native-imap-owned-fixture-secret-at-least-32-characters';
const { bootCrmDb } = require('./helpers/crmDb');
jest.setTimeout(120000);
let db, cleanup, server, intake, port, image, messages, downloads;
const sockets = new Set();
const commands = [];
const previousPrivateEndpoints = process.env.MAIL_PRIVATE_ENDPOINTS;

function reply(socket, tag, command) {
  commands.push(command);
  if (/^CAPABILITY/i.test(command)) socket.write(`* CAPABILITY IMAP4rev1 UIDPLUS\r\n${tag} OK capability\r\n`);
  else if (/^LOGIN/i.test(command)) socket.write(`${tag} OK authenticated\r\n`);
  else if (/^LIST|^LSUB/i.test(command)) {
    const kind = command.split(' ')[0];
    const root = /^LIST "" ""$/i.test(command);
    socket.write(`* ${kind} (${root ? '\\\\Noselect' : '\\\\HasNoChildren'}) "/" "${root ? '' : 'INBOX'}"\r\n${tag} OK listed\r\n`);
  }
  else if (/^SELECT/i.test(command)) socket.write(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY 17] fixture\r\n* OK [UIDNEXT ${messages.length + 1}] fixture\r\n${tag} OK [READ-WRITE] selected\r\n`);
  else if (/^UID SEARCH/i.test(command)) socket.write(`* SEARCH ${messages.map(m => m.uid).join(' ')}\r\n${tag} OK search\r\n`);
  else if (/^UID FETCH/i.test(command)) {
    if (/ENVELOPE/i.test(command)) {
      for (const m of messages) socket.write(`* ${m.uid} FETCH (UID ${m.uid} RFC822.SIZE ${m.source.length} ENVELOPE ("Thu, 8 Oct 2026 08:00:00 +0000" "Supplier invoice" (("Supplier" NIL "supplier" "example.com")) NIL NIL ((NIL NIL "intake" "example.com")) NIL NIL NIL "${m.id}"))\r\n`);
    } else {
      const uid = Number(command.match(/^UID FETCH (\d+)/i)[1]);
      const m = messages.find(row => row.uid === uid);
      downloads.push(uid);
      socket.write(`* ${uid} FETCH (UID ${uid} BODY[] {${m.source.length}}\r\n`);
      socket.write(m.source);
      socket.write(')\r\n');
    }
    socket.write(`${tag} OK fetched\r\n`);
  } else if (/^UID STORE|^CLOSE|^NOOP/i.test(command)) socket.write(`${tag} OK done\r\n`);
  else if (/^LOGOUT/i.test(command)) socket.end(`* BYE done\r\n${tag} OK logout\r\n`);
  else socket.write(`${tag} BAD unsupported fixture command\r\n`);
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  require('../../src/database/db').logActivity = async () => {};
  image = await require('sharp')({ create: { width: 8, height: 8, channels: 3, background: '#ffeeaa' } }).png().toBuffer();
  server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.write('* OK Owned PicPeak IMAP fixture\r\n');
    let pending = '';
    socket.on('data', chunk => {
      pending += chunk.toString();
      let end;
      while ((end = pending.indexOf('\r\n')) !== -1) {
        const line = pending.slice(0, end); pending = pending.slice(end + 2);
        const split = line.indexOf(' ');
        if (split !== -1) reply(socket, line.slice(0, split), line.slice(split + 1));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  // Compose with the mail DNS boundary using one owned protocol/host/port,
  // never a NODE_ENV-wide private-network exception.
  process.env.MAIL_PRIVATE_ENDPOINTS = `imap://127.0.0.1:${port}`;
  await db('feature_flags').insert({ key: 'incomingMail', value: 1 }).onConflict('key').merge({ value: 1 });
  const cfg = { imap_host: '127.0.0.1', imap_port: port, imap_secure: 0, imap_user: 'intake@example.com', imap_pass: 'owned-fixture', imap_folder: 'INBOX' };
  const old = await db('email_configs').first();
  if (old) await db('email_configs').where({ id: old.id }).update(cfg);
  else await db('email_configs').insert({ smtp_host: 'smtp.example.com', smtp_port: 587, from_email: 'intake@example.com', ...cfg });
  intake = require('../../src/services/emailIntakeService');
});
beforeEach(async () => {
  for (const key of Object.keys(process.env).filter(k => k.startsWith('EMAIL_INTAKE_'))) delete process.env[key];
  downloads = []; commands.length = 0;
  messages = [1, 2].map(uid => {
    const id = `<native-${uid}@example.com>`;
    return { uid, id, source: Buffer.from(`Message-ID: ${id}\r\nFrom: Supplier <supplier@example.com>\r\nTo: intake@example.com\r\nSubject: Supplier invoice\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nOrdinary supplier body\r\n--x\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename=invoice.png\r\nContent-Transfer-Encoding: base64\r\n\r\n${image.toString('base64')}\r\n--x--\r\n`) };
  });
  await db('received_emails').del(); await db('inbound_documents').del();
  await db('mail_intake_files').del(); await db('mail_intake_state').del();
  await db('mail_intake_state').insert({ key: 'installation' });
});
afterAll(async () => {
  if (previousPrivateEndpoints === undefined) delete process.env.MAIL_PRIVATE_ENDPOINTS;
  else process.env.MAIL_PRIVATE_ENDPOINTS = previousPrivateEndpoints;
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise(resolve => server.close(resolve));
  if (cleanup) await cleanup();
});

test('real ImapFlow and MIME parser preserve ordinary body/evidence and physically deduplicate', async () => {
  const result = await intake.pollOnce();
  expect({ result, commands: result.processed === 2 ? [] : commands }).toEqual({ result: { processed: 2 }, commands: [] });
  expect(downloads).toEqual([1, 2]);
  const files = await db('mail_intake_files');
  expect(files).toHaveLength(1);
  expect(await fs.promises.readFile(require('../../src/utils/storedPath').resolveStoredPath(files[0].file_path))).toEqual(image);
  expect((await db('received_emails')).every(row => row.body_text.includes('Ordinary supplier body'))).toBe(true);
  await intake.pollOnce();
  expect(downloads).toEqual([1, 2]);
});

test('native IMAP envelope capacity refusal never requests source literals', async () => {
  process.env.EMAIL_INTAKE_INSTALLATION_BYTES = '50000';
  process.env.EMAIL_INTAKE_MAILBOX_BYTES = '50000';
  expect(await intake.pollOnce()).toEqual({ processed: 0 });
  expect(downloads).toHaveLength(0);
  // Refused mail is neither recorded nor flagged \Seen: it waits for room.
  expect(await db('received_emails')).toHaveLength(0);
  expect(commands.filter(command => /^UID STORE/i.test(command))).toHaveLength(0);
  delete process.env.EMAIL_INTAKE_INSTALLATION_BYTES;
  delete process.env.EMAIL_INTAKE_MAILBOX_BYTES;
  expect(await intake.pollOnce()).toEqual({ processed: 2 });
});

test('native sender envelope budget allows one ordinary source and leaves the next unique ID unread', async () => {
  process.env.EMAIL_INTAKE_SENDER_PER_HOUR = '1';
  expect(await intake.pollOnce()).toEqual({ processed: 1 });
  expect(downloads).toEqual([1]);
  expect((await db('received_emails')).map(row => row.status)).toEqual(['ingested']);
  expect(commands.filter(command => /^UID STORE/i.test(command))).toHaveLength(1);
});
