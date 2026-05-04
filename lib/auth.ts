import NextAuth, { type NextAuthConfig } from 'next-auth';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import Credentials from 'next-auth/providers/credentials';
import { PrismaAdapter } from '@auth/prisma-adapter';
// Auth.js's PrismaAdapter requires direct access to the Prisma client; it is
// not a service consumer. This is the canonical Auth.js wiring pattern.
// eslint-disable-next-line crystal-forge/no-prisma-outside-services
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import {
  provisionFromEntra,
  getSessionUserById,
  getSessionUserByEmail,
} from '@/lib/services/users';

const providers: NextAuthConfig['providers'] = [
  MicrosoftEntraID({
    clientId: env.AUTH_MICROSOFT_ENTRA_ID_ID,
    clientSecret: env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
    issuer: env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
  }),
];

if (env.AUTH_DEV_USERS_ENABLED) {
  providers.push(
    Credentials({
      id: 'dev',
      name: 'Dev sign-in',
      credentials: { email: { label: 'Email', type: 'email' } },
      async authorize(creds) {
        const email = (creds?.email as string | undefined)?.toLowerCase();
        if (!email) return null;
        const user = await getSessionUserByEmail(email);
        if (!user) return null;
        return {
          id: user.id,
          email: user.email,
          name: user.name,
        };
      },
    })
  );
}

export const authConfig: NextAuthConfig = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: 'database' },
  pages: { signIn: '/login' },
  trustHost: true,
  providers,
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider === 'microsoft-entra-id' && profile) {
        await provisionFromEntra({
          entraOid: account.providerAccountId,
          email: (profile.email as string) ?? `${account.providerAccountId}@unknown.local`,
          name: (profile.name as string) ?? 'Unknown User',
        });
      }
      return true;
    },
    async session({ session, user }) {
      const enriched = await getSessionUserById(user.id);
      if (enriched) {
        session.user = enriched as typeof session.user;
      }
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export const isDevAuthEnabled = env.AUTH_DEV_USERS_ENABLED;
