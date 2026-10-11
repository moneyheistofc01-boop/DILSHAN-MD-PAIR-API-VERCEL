import { randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { MongoClient, type Collection } from 'mongodb';

type SessionDocument = {
  _id: string;
  payload: string;
  createdAt: Date;
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars; token is exactly 10 chars
let client: MongoClient | undefined;
let clientUri: string | undefined;

function makeToken(): string {
  // 10 random bytes mapped to a 32-character alphabet = 50 bits of randomness.
  return Array.from(randomBytes(10), (byte) => ALPHABET[byte & 31]).join('');
}

async function sessions(): Promise<Collection<SessionDocument>> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not configured in Vercel.');
  let activeClient = client;
  if (!activeClient || clientUri !== uri) {
    const nextClient = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 10000 });
    client = nextClient;
    clientUri = uri;
    try {
      await nextClient.connect();
      activeClient = nextClient;
    } catch (error) {
      client = undefined;
      clientUri = undefined;
      try { await nextClient.close(); } catch {}
      throw error;
    }
  }
  return activeClient.db(process.env.MONGODB_DB || 'dilshan_md').collection<SessionDocument>('short_sessions');
}

function validFiles(files: unknown): files is Record<string, string> {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return false;
  const record = files as Record<string, unknown>;
  if (typeof record['creds.json'] !== 'string') return false;
  const names = Object.keys(record);
  if (!names.length || names.some((name) => !/^[A-Za-z0-9._-]+\.json$/.test(name))) return false;
  if (names.some((name) => typeof record[name] !== 'string')) return false;
  try {
    const creds = JSON.parse(record['creds.json'] as string);
    return !!creds && typeof creds === 'object' && creds.registered === true;
  } catch {
    return false;
  }
}

export async function saveAuthFiles(files: Record<string, string>): Promise<string> {
  if (!validFiles(files)) throw new Error('The linked WhatsApp auth files are incomplete or invalid.');
  const payload = gzipSync(Buffer.from(JSON.stringify({ version: 1, files })), { level: 9 }).toString('base64url');
  // Keep margin below MongoDB's 16 MiB BSON document limit.
  if (Buffer.byteLength(payload, 'utf8') > 14 * 1024 * 1024) {
    throw new Error('The session backup is too large to store in MongoDB.');
  }
  const collection = await sessions();
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = makeToken();
    try {
      await collection.insertOne({ _id: id, payload, createdAt: new Date() });
      return id;
    } catch (error) {
      if ((error as { code?: number })?.code === 11000) continue;
      throw error;
    }
  }
  throw new Error('Could not allocate a unique short session token.');
}

export async function getAuthFiles(id: string): Promise<Record<string, string> | null> {
  const collection = await sessions();
  const record = await collection.findOne({ _id: id });
  if (!record) return null;
  const decoded = JSON.parse(gunzipSync(Buffer.from(record.payload, 'base64url'), { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8')) as { version?: number; files?: unknown };
  const files = decoded.files;
  if (decoded.version !== 1 || !validFiles(files)) throw new Error('Stored session data is invalid.');
  return files;
}
