import bcrypt from 'bcryptjs';
import { db } from './db.js';

const email = process.env.SEED_ADMIN_EMAIL;
const password = process.env.SEED_ADMIN_PASSWORD;
const fullName = process.env.SEED_ADMIN_NAME || 'Development Administrator';
if (!email || !password || password.length < 12) {
  console.error('Set SEED_ADMIN_EMAIL and a SEED_ADMIN_PASSWORD of at least 12 characters in .env first.');
  process.exitCode = 1;
} else {
  const existing = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email);
  if (existing) {
    console.error('An account with that email already exists; no changes were made.');
    process.exitCode = 1;
  } else {
    const passwordHash = await bcrypt.hash(password, 12);
    db.prepare("INSERT INTO users (email, password_hash, role, full_name) VALUES (?, ?, 'admin', ?)").run(email, passwordHash, fullName);
    console.log(`Administrator account created for ${email}.`);
  }
}
