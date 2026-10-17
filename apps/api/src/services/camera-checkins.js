import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const CAMERA_CONSENT_VERSION = 'camera-checkin-2026-10-17-v1';
export const CAMERA_CHECKIN_RETENTION_DAYS = 30;

export function getCameraStorageKey() {
  const configured = process.env.CAMERA_STORAGE_KEY;
  if (!configured || !/^[A-Za-z0-9+/]{43}=$/.test(configured)) return null;
  const key = Buffer.from(configured, 'base64');
  return key.length === 32 ? key : null;
}

export function encryptCameraImage(image, userId, activityEventId) {
  const key = getCameraStorageKey();
  if (!key) throw new Error('Camera storage encryption key is not configured');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`${userId}:${activityEventId}`));
  const ciphertext = Buffer.concat([cipher.update(image), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptCameraImage(encryptedImage, userId, activityEventId) {
  const key = getCameraStorageKey();
  if (!key) throw new Error('Camera storage encryption key is not configured');
  const nonce = encryptedImage.subarray(0, 12);
  const authTag = encryptedImage.subarray(12, 28);
  const ciphertext = encryptedImage.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(`${userId}:${activityEventId}`));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function purgeExpiredCameraCheckins(db, referenceDate = new Date()) {
  const retentionStart = new Date(referenceDate.getTime() - CAMERA_CHECKIN_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM employee_camera_checkins WHERE captured_at < ?').run(retentionStart);
}
