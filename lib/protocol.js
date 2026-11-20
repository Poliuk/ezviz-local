'use strict';

// Pure (socket-free) parts of the HCNetSDK "command port" (TCP 8000) protocol
// as spoken by EZVIZ cameras: frame layout, login frames, the login proof, the
// challenge decryption, and the per-command auth word.
//
// Ported from pyezvizapi 2.5.1 by Renier Moorcroft (Apache-2.0,
// https://github.com/RenierM26/pyEzvizApi), pyezvizapi/streaming/local/hcnetsdk/.
// This file was rewritten in JavaScript and modified; NOTICE at the root of
// this package lists what was ported and what changed. Only the Python
// library's logic was ported; nothing here comes from vendor SDK binaries,
// headers or decompiled code.

const crypto = require('node:crypto');
const { Buffer } = require('node:buffer');

// Constants (pyezvizapi .../hcnetsdk/constants.py and api.py).
const HEADER_LENGTH = 16;
const CONTROL_FAMILY = 0x63000000;
const LOGIN_FAMILY = 0x5a000000;
const LOGIN_HEADER_FIELD_12 = 0x00010000;
const LOGIN_SEED_PREFIX = Buffer.from('05013d4b00000001', 'hex');
const LOGIN_SEED_SUFFIX = Buffer.from('0000000000006f00', 'hex');
const USERNAME_LENGTH = 48;
const RSA_BITS = 1024;
const RSA_BLOCK_LENGTH = 128;
const PASSWORD_SEED_LENGTH = 64;
const PRIMARY_PROOF_LENGTH = 32;
const SECONDARY_PROOF_LENGTH = 16;
const AUTH_KEY_LENGTH = 16;
const AUTH_MASK_LENGTH = 6;
const DEFAULT_USERNAME = 'admin';

class EzvizLanError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'EzvizLanError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------- framing

// build_hcnetsdk_tcp_frame: 16-byte big-endian header (total length, three
// opaque words) followed by the body.
function buildFrame(body = Buffer.alloc(0), field4 = 0, field8 = 0, field12 = 0) {
  const header = Buffer.alloc(HEADER_LENGTH);
  header.writeUInt32BE(HEADER_LENGTH + body.length, 0);
  header.writeUInt32BE(field4 >>> 0, 4);
  header.writeUInt32BE(field8 >>> 0, 8);
  header.writeUInt32BE(field12 >>> 0, 12);
  return Buffer.concat([header, body]);
}

function parseHeader(buf) {
  return {
    totalLength: buf.readUInt32BE(0),
    field4: buf.readUInt32BE(4),
    field8: buf.readUInt32BE(8),
    field12: buf.readUInt32BE(12),
  };
}

// _hcnetsdk_command_port_local_ip_word: the client's IPv4 address, reversed
// (little-endian).
function localIpWord(localIp) {
  const ip = normalizeIpv4(localIp);
  if (!ip) {
    throw new EzvizLanError('invalid_argument', 'localIp must be an IPv4 address');
  }
  return Buffer.from(ip.split('.').map(Number).reverse());
}

function normalizeIpv4(value) {
  if (typeof value !== 'string') return null;
  const v = value.startsWith('::ffff:') ? value.slice(7) : value;
  const parts = v.split('.');
  if (parts.length !== 4) return null;
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255) return null;
  }
  return v;
}

// _hcnetsdk_command_port_login_prefix
function loginPrefix(localIp) {
  return Buffer.concat([LOGIN_SEED_PREFIX, localIpWord(localIp), LOGIN_SEED_SUFFIX]);
}

// _hcnetsdk_command_port_username: UTF-8, NUL-padded to 48 bytes.
function usernameField(username) {
  const bytes = Buffer.from(username, 'utf8');
  if (bytes.length > USERNAME_LENGTH) {
    throw new EzvizLanError('invalid_argument', 'username is too long (max 48 bytes)');
  }
  const out = Buffer.alloc(USERNAME_LENGTH);
  bytes.copy(out);
  return out;
}

// ---------------------------------------------------------------- RSA

// hcnetsdk_command_port_public_key_der: PKCS#1 RSAPublicKey DER (SEQUENCE {n, e}),
// not SubjectPublicKeyInfo.
function publicKeyDer(privateKey) {
  return crypto.createPublicKey(privateKey).export({ type: 'pkcs1', format: 'der' });
}

function toPrivateKeyObject(rsaKey) {
  const key = rsaKey instanceof crypto.KeyObject ? rsaKey : crypto.createPrivateKey(rsaKey);
  if (key.type !== 'private' || key.asymmetricKeyType !== 'rsa') {
    throw new EzvizLanError('invalid_argument', 'rsaKey must be an RSA private key');
  }
  if (key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength !== RSA_BITS) {
    throw new EzvizLanError('invalid_argument', 'rsaKey must be a 1024-bit RSA key');
  }
  return key;
}

// hcnetsdk_command_port_rsa_key: a fresh 1024-bit key per login.
function generateRsaKey() {
  return new Promise((resolve, reject) => {
    crypto.generateKeyPair('rsa', { modulusLength: RSA_BITS, publicExponent: 65537 }, (err, _pub, priv) => {
      if (err) reject(err);
      else resolve(priv);
    });
  });
}

function b64urlToBigInt(s) {
  return BigInt('0x' + (Buffer.from(s, 'base64url').toString('hex') || '0'));
}

function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

// RSAES-PKCS1-v1_5 decryption done by hand with BigInt, so it works on any
// Node/OpenSSL build (some builds refuse PKCS#1 v1.5 private decryption).
// Mirrors PyCryptodome's PKCS1_v1_5.decrypt(ct, sentinel=b""): returns null
// where PyCryptodome would return the sentinel.
function rsaPkcs1v15Decrypt(privateKey, ciphertext) {
  const jwk = privateKey.export({ format: 'jwk' });
  const n = b64urlToBigInt(jwk.n);
  const k = RSA_BLOCK_LENGTH;
  const c = BigInt('0x' + ciphertext.toString('hex'));
  if (c >= n) return null;
  // CRT
  const p = b64urlToBigInt(jwk.p);
  const q = b64urlToBigInt(jwk.q);
  const m1 = modPow(c, b64urlToBigInt(jwk.dp), p);
  const m2 = modPow(c, b64urlToBigInt(jwk.dq), q);
  let h = ((m1 - m2) * b64urlToBigInt(jwk.qi)) % p;
  if (h < 0n) h += p;
  const m = m2 + h * q;
  const em = Buffer.from(m.toString(16).padStart(k * 2, '0'), 'hex');
  if (em.length !== k || em[0] !== 0x00 || em[1] !== 0x02) return null;
  const sep = em.indexOf(0x00, 2);
  if (sep < 10) return null; // at least 8 non-zero padding bytes
  return em.subarray(sep + 1);
}

// ---------------------------------------------------------------- login

// hcnetsdk_command_port_login_request_frame
function loginRequestFrame(publicDer, { username, localIp }) {
  const body = Buffer.concat([loginPrefix(localIp), usernameField(username), publicDer]);
  return buildFrame(body, LOGIN_FAMILY, 0, LOGIN_HEADER_FIELD_12);
}

// hcnetsdk_command_port_password_digest: lowercase hex of
// SHA-256(username || password_seed || password), as ASCII bytes.
function passwordDigest(username, password, passwordSeed) {
  if (passwordSeed.length !== PASSWORD_SEED_LENGTH) {
    throw new EzvizLanError('bad_response', 'password seed must be 64 bytes');
  }
  const h = crypto.createHash('sha256');
  h.update(Buffer.from(username, 'utf8'));
  h.update(passwordSeed);
  h.update(toPasswordBytes(password));
  return Buffer.from(h.digest('hex'), 'ascii');
}

function toPasswordBytes(password) {
  return Buffer.isBuffer(password) ? password : Buffer.from(String(password), 'utf8');
}

function stripTrailingZeros(buf) {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end--;
  return buf.subarray(0, end);
}

function hmacMd5(key, data) {
  return crypto.createHmac('md5', key).update(data).digest();
}

// hcnetsdk_command_port_login_proof
function loginProof(username, password, challenge, passwordSeed) {
  const ch = stripTrailingZeros(challenge);
  if (ch.length === 0) throw new EzvizLanError('bad_response', 'login challenge is empty');
  const digest = passwordDigest(username, password, passwordSeed);
  return [hmacMd5(ch, Buffer.from(username, 'utf8')), hmacMd5(ch, digest)];
}

// hcnetsdk_command_port_login_proof_frame
function loginProofFrame({ username, password, challenge, passwordSeed, localIp }) {
  const [primary, secondary] = loginProof(username, password, challenge, passwordSeed);
  const primaryField = Buffer.alloc(Math.max(PRIMARY_PROOF_LENGTH, primary.length));
  primary.copy(primaryField);
  const body = Buffer.concat([
    loginPrefix(localIp),
    primaryField,
    secondary.subarray(0, SECONDARY_PROOF_LENGTH),
  ]);
  return buildFrame(body, LOGIN_FAMILY, 0, LOGIN_HEADER_FIELD_12);
}

// decode_hcnetsdk_command_port_login_challenge
function decodeLoginChallenge(responseBody, privateKey) {
  if (responseBody.length < RSA_BLOCK_LENGTH + PASSWORD_SEED_LENGTH) {
    throw new EzvizLanError('bad_response', 'login challenge response is truncated');
  }
  const plain = rsaPkcs1v15Decrypt(privateKey, responseBody.subarray(0, RSA_BLOCK_LENGTH));
  if (!plain || plain.length === 0) {
    throw new EzvizLanError('bad_response', 'RSA challenge decrypt failed');
  }
  return {
    challenge: Buffer.from(stripTrailingZeros(plain)),
    passwordSeed: Buffer.from(
      responseBody.subarray(RSA_BLOCK_LENGTH, RSA_BLOCK_LENGTH + PASSWORD_SEED_LENGTH),
    ),
  };
}

// parse_hcnetsdk_command_port_login_session: session id = first 4 body bytes
// (all-zero means rejected), auth seed = header word at offset 4, serial =
// NUL-terminated ASCII in body[4:48].
function parseLoginSession(header, body) {
  if (body.length < 4 || body.readUInt32BE(0) === 0) {
    throw new EzvizLanError('auth_failed', 'command-port login failed (wrong username or password?)', {
      response: { ...header, bodyLength: body.length },
    });
  }
  const serialField = body.subarray(4, 48);
  const nul = serialField.indexOf(0);
  const serial = (nul === -1 ? serialField : serialField.subarray(0, nul))
    .toString('latin1')
    .replace(/[^\x00-\x7f]/g, '');
  return { sessionId: Buffer.from(body.subarray(0, 4)), authSeed: header.field4, serial };
}

// ---------------------------------------------------------------- auth word

// AES S-box, generated (FIPS-197) rather than tabled.
const SBOX = (() => {
  const sbox = new Uint8Array(256);
  const rotl8 = (x, s) => ((x << s) | (x >>> (8 - s))) & 0xff;
  let p = 1;
  let q = 1;
  do {
    p = (p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    sbox[p] = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63;
  } while (p !== 1);
  sbox[0] = 0x63;
  return sbox;
})();
const RCON = [0x01, 0x02, 0x04, 0x08];
const SHIFT_ROWS = [0, 5, 10, 15, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11];

// _hcnetsdk_aes128_round_keys(key, rounds=4)
function roundKeys(key, rounds) {
  const words = [];
  for (let i = 0; i < 16; i += 4) words.push([key[i], key[i + 1], key[i + 2], key[i + 3]]);
  while (words.length < 4 * (rounds + 1)) {
    let word = words[words.length - 1].slice();
    if (words.length % 4 === 0) {
      word = [word[1], word[2], word[3], word[0]].map((b) => SBOX[b]);
      word[0] ^= RCON[words.length / 4 - 1];
    }
    const prev = words[words.length - 4];
    words.push(prev.map((b, i) => b ^ word[i]));
  }
  const keys = [];
  for (let r = 0; r <= rounds; r++) {
    keys.push(Uint8Array.from(words.slice(r * 4, r * 4 + 4).flat()));
  }
  return keys;
}

function xtime(v) {
  return ((v << 1) ^ (v & 0x80 ? 0x1b : 0)) & 0xff;
}

function addRoundKey(state, rk) {
  return state.map((b, i) => b ^ rk[i]);
}
function subBytes(state) {
  return state.map((b) => SBOX[b]);
}
function shiftRows(state) {
  return Uint8Array.from(SHIFT_ROWS, (i) => state[i]);
}
function mixColumns(state) {
  const out = new Uint8Array(16);
  for (let c = 0; c < 16; c += 4) {
    const a = state.subarray(c, c + 4);
    const d = Array.from(a, xtime);
    out[c] = d[0] ^ a[3] ^ a[2] ^ d[1] ^ a[1];
    out[c + 1] = d[1] ^ a[0] ^ a[3] ^ d[2] ^ a[2];
    out[c + 2] = d[2] ^ a[1] ^ a[0] ^ d[3] ^ a[3];
    out[c + 3] = d[3] ^ a[2] ^ a[1] ^ d[0] ^ a[0];
  }
  return out;
}

// _hcnetsdk_command_port_four_round_aes: AES-128 truncated to four rounds.
function fourRoundAes(block, key) {
  if (block.length !== 16) throw new EzvizLanError('invalid_argument', 'auth block must be 16 bytes');
  if (key.length !== AUTH_KEY_LENGTH) throw new EzvizLanError('invalid_argument', 'auth key must be 16 bytes');
  const rk = roundKeys(key, 4);
  let state = addRoundKey(Uint8Array.from(block), rk[0]);
  for (let r = 1; r < 4; r++) {
    state = addRoundKey(mixColumns(shiftRows(subBytes(state))), rk[r]);
  }
  state = addRoundKey(shiftRows(subBytes(state)), rk[4]);
  return Buffer.from(state);
}

// _hcnetsdk_command_port_auth_mask (zero for the default all-zero mask seed)
function authMask(sessionWord, maskSeed) {
  let sum = 0;
  for (let i = 0; i < AUTH_MASK_LENGTH; i++) {
    sum += maskSeed[i] & (Math.floor(sessionWord / 2 ** (5 * i)) & 0xff);
  }
  return sum;
}

// hcnetsdk_command_port_auth_word
function authWord({ sessionId, authSeed, commandId, key, addend = null, maskSeed = Buffer.alloc(AUTH_MASK_LENGTH) }) {
  if (sessionId.length !== 4) throw new EzvizLanError('invalid_argument', 'session id must be 4 bytes');
  if (key.length < AUTH_KEY_LENGTH) {
    throw new EzvizLanError('bad_response', 'login challenge is shorter than the 16-byte auth key');
  }
  const sessionWord = sessionId.readUInt32BE(0);
  const input = (authSeed + commandId * 2 + authMask(sessionWord, maskSeed)) % 2 ** 32;
  const block = Buffer.alloc(16);
  block.writeUInt32LE(input >>> 0, 0);
  const t = fourRoundAes(block, key.subarray(0, AUTH_KEY_LENGTH));
  const folded = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) folded[i] = t[i] ^ t[i + 4] ^ t[i + 8] ^ t[i + 12];
  return (folded.readUInt32LE(0) + (addend === null ? sessionWord : addend)) % 2 ** 32;
}

// hcnetsdk_command_port_control_frame / HcNetSdkCommandPortControlTemplate.to_frame
// (template with no addend, addend_delta, mask seed or body-tail transform).
function controlFrame({ sessionId, authSeed, commandId, key, localIp, bodyTail = Buffer.alloc(0) }) {
  if (sessionId.length !== 4) throw new EzvizLanError('invalid_argument', 'session id must be 4 bytes');
  const body = Buffer.concat([localIpWord(localIp), sessionId, Buffer.alloc(8), bodyTail]);
  return buildFrame(body, CONTROL_FAMILY, authWord({ sessionId, authSeed, commandId, key }), commandId);
}

module.exports = {
  HEADER_LENGTH,
  CONTROL_FAMILY,
  LOGIN_FAMILY,
  DEFAULT_USERNAME,
  RSA_BITS,
  EzvizLanError,
  SBOX,
  buildFrame,
  parseHeader,
  normalizeIpv4,
  localIpWord,
  publicKeyDer,
  toPrivateKeyObject,
  generateRsaKey,
  rsaPkcs1v15Decrypt,
  loginRequestFrame,
  passwordDigest,
  loginProofFrame,
  decodeLoginChallenge,
  parseLoginSession,
  fourRoundAes,
  authWord,
  controlFrame,
};
