import { randomInt } from 'node:crypto';

// Unambiguous characters so a manager can read the password aloud or copy it.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

export function generateTemporaryPassword(length = 14): string {
  let password = '';
  for (let index = 0; index < length; index += 1)
    password += ALPHABET[randomInt(ALPHABET.length)];
  return password;
}

export function validateNewPassword(value: string) {
  return value.length >= 12 && value.length <= 128;
}
