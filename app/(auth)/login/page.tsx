import Image from 'next/image';
import { LoginPanel } from './LoginPanel';
import { isDevAuthEnabled } from '@/lib/auth';
import { listSeededUsersForDevSwitch } from '@/lib/services/dev';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const devUsers = isDevAuthEnabled ? await listSeededUsersForDevSwitch() : [];
  return (
    <main
      className="login-stage fixed inset-0 grid place-items-center"
      style={{
        background:
          'radial-gradient(70% 55% at 50% 42%, rgba(0,90,170,0.55) 0%, rgba(0,46,92,0.55) 22%, rgba(0,28,56,0.6) 42%, rgba(0,0,0,1) 78%), #000',
      }}
    >
      <section className="z-10 flex flex-col items-center gap-7 p-8" aria-labelledby="signin-title">
        <div className="relative aspect-square w-[min(340px,48vh,70vw)]">
          <div
            className="absolute inset-0 bg-black"
            style={{ animation: 'fadeOut 20000ms ease-out 1500ms forwards' }}
          />
          <Image
            src="/crystal-forge-logo.png"
            alt="Crystal Forge"
            fill
            className="object-contain opacity-0 mix-blend-screen drop-shadow-[0_22px_40px_rgba(0,0,0,0.6)]"
            style={{ animation: 'logoIn 20000ms cubic-bezier(.2,.65,.25,1) 1500ms forwards' }}
            priority
          />
        </div>
        <LoginPanel devUsers={devUsers} />
      </section>
    </main>
  );
}
