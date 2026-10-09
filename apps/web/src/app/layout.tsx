import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'TouchGrass — outdoor games with an AI Game Master',
    template: '%s · TouchGrass',
  },
  description:
    'Pick a game, share a link, and go outside. TouchGrass keeps the score and the clock for real-world games like Tag and Hide & Seek.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#2c4a24',
};

const navLink =
  'inline-flex min-h-11 items-center rounded-lg px-3 font-semibold hover:bg-moss-100 dark:hover:bg-bark-800 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-sun-500';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <a href="#main" className="skip-link">
          Skip to the main content
        </a>
        <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-4 py-4 sm:px-8 sm:py-6">
          <header className="border-moss-200 dark:border-bark-700 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b pb-4">
            <Link
              href="/"
              aria-label="TouchGrass home"
              className="focus-visible:outline-sun-500 rounded-lg text-xl font-black tracking-tight focus-visible:outline-3 focus-visible:outline-offset-4"
            >
              Touch<span className="text-moss-700 dark:text-moss-400">Grass</span>
            </Link>
            <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
              <Link href="/" className={navLink}>
                Home
              </Link>
              <Link href="/games" className={navLink}>
                Games
              </Link>
              <Link href="/join" className={navLink}>
                Join a game
              </Link>
            </nav>
          </header>

          <main id="main" className="flex-1 py-8">
            {children}
          </main>

          <footer className="border-moss-200 text-bark-700 dark:border-bark-700 dark:text-moss-200/80 space-y-2 border-t pt-5 text-sm">
            <p>
              TouchGrass keeps the score and the clock. Staying safe outdoors is still up to the
              people playing: agree your boundaries, and stay away from roads, water and heights.
            </p>
            <p>
              An open-source project.{' '}
              <a
                href="https://github.com/SHWETANK-SAURABH/touchgrass_game_master"
                className="font-semibold underline underline-offset-4"
                target="_blank"
                rel="noreferrer"
              >
                Source on GitHub
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
