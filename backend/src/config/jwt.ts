import jwt, { SignOptions } from 'jsonwebtoken';

export type Role = 'STUDENT' | 'WARDEN';

export interface JwtPayload {
  id: string;
  role: Role;
}

const secret = process.env.JWT_SECRET;

if (!secret) {
  throw new Error(
    'JWT_SECRET is not defined. Copy backend/.env.example to backend/.env and set it.',
  );
}

const JWT_SECRET: string = secret;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '7d';

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  } as SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, JWT_SECRET);

  if (
    typeof decoded === 'string' ||
    typeof decoded.id !== 'string' ||
    (decoded.role !== 'STUDENT' && decoded.role !== 'WARDEN')
  ) {
    throw new Error('Invalid token payload');
  }

  return { id: decoded.id, role: decoded.role as Role };
}
