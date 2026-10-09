import type { Metadata } from 'next';
import Link from 'next/link';
import { GameRoom } from '@/components/game-room';
import { linkStyle } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Your game',
  // A game's address is an invitation. It should not be indexed.
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{ code?: string | string[] }>;
}

export default async function SessionPage({ params, searchParams }: PageProps) {
  const { sessionId } = await params;
  const { code } = await searchParams;
  const initialCode = (Array.isArray(code) ? code[0] : code) ?? '';

  return (
    <div className="space-y-6">
      <p>
        <Link href="/games" className={linkStyle}>
          ← All games
        </Link>
      </p>
      <h1 className="sr-only">Your game</h1>
      <GameRoom sessionId={decodeURIComponent(sessionId)} initialCode={initialCode.slice(0, 32)} />
    </div>
  );
}
