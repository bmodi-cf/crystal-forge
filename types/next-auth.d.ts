import 'next-auth';
import type { SessionUser } from '@/lib/services/types';

declare module 'next-auth' {
  interface Session {
    user: SessionUser;
  }
}
