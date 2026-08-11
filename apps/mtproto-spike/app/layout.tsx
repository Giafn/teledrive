import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'MTProto local spike',
  description: 'Local-only Phase 2 MTProto proof',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
