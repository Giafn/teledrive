import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ruang — Drive pribadi',
  description: 'Drive pribadi berbasis Telegram',
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = { themeColor: '#f4f1ea' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
