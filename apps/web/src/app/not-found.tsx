import Link from 'next/link';
import { buttonPrimary, buttonSecondary } from '@/components/ui';

export default function NotFound() {
  return (
    <div className="max-w-xl space-y-5">
      <h1 className="text-3xl font-black tracking-tight sm:text-4xl">
        We could not find that page
      </h1>
      <p className="text-lg">
        The link may be old or mistyped. You can look through the games, or join one a friend has
        started.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link href="/games" className={buttonPrimary}>
          See the games
        </Link>
        <Link href="/" className={buttonSecondary}>
          Go to the home page
        </Link>
      </div>
    </div>
  );
}
