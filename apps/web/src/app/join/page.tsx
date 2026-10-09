import type { Metadata } from 'next';
import Link from 'next/link';
import { JoinForm } from '@/components/join-form';
import { card, linkStyle, muted } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Join a game',
  description: 'Join a TouchGrass game your friend has started.',
};

export default function JoinPage() {
  return (
    <div className="max-w-2xl space-y-8">
      <header className="space-y-3">
        <h1 className="text-3xl font-black tracking-tight sm:text-4xl">Join a game</h1>
        <p className="text-lg">
          Someone started a game and sent you a link? The quickest way in is to open that link. You
          can also paste it here.
        </p>
      </header>

      <section className={card}>
        <JoinForm />
      </section>

      <p className={muted}>
        Nobody has started a game yet?{' '}
        <Link href="/games" className={linkStyle}>
          Pick one and start it yourself
        </Link>
        .
      </p>
    </div>
  );
}
