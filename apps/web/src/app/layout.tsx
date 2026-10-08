import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'TouchGrass — AI Game Master',
    template: '%s · TouchGrass',
  },
  description:
    'An open-weight AI Game Master for real-world outdoor games. The screen is the referee; the world is the game.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#2c4a24',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-5 py-6 sm:px-8">
          <header className="border-moss-200 dark:border-bark-700 flex flex-wrap items-center justify-between gap-4 border-b pb-5">
            <Link href="/" className="group">
              <span className="block text-lg font-bold tracking-tight">
                Touch<span className="text-moss-600 dark:text-moss-400">Grass</span>
              </span>
              <span className="text-bark-700 dark:text-moss-200/70 block text-xs">
                open-weight AI Game Master
              </span>
            </Link>
            <nav className="flex items-center gap-5 text-sm font-medium">
              <Link href="/games" className="hover:text-moss-600 dark:hover:text-moss-400">
                Games
              </Link>
              <a
                href="https://github.com/SHWETANK-SAURABH/touchgrass_game_master"
                className="hover:text-moss-600 dark:hover:text-moss-400"
                target="_blank"
                rel="noreferrer"
              >
                GitHub
              </a>
            </nav>
          </header>

          <main className="flex-1 py-8">{children}</main>

          <footer className="border-moss-200 text-bark-700 dark:border-bark-700 dark:text-moss-200/60 border-t pt-5 text-xs">
            <p>
              Phase 5F: the deterministic game engine runs Tag and Hide &amp; Seek, a Game Master
              can propose events, and a deterministic safety validator checks a proposal before the
              engine applies it. A WebSocket server can hold one game, let players join, drop and
              resume, and let a host pause or stop it, for development only: this site does not
              connect to it, there is no in-app game, no authentication, and the Game Master is not
              connected — see ARCHITECTURE.md.
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
