import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'DILSHAN MD Pair API',
  description: 'WhatsApp pairing API health and service information.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body style={{ fontFamily: 'system-ui', padding: 24 }}>{children}</body></html>;
}
