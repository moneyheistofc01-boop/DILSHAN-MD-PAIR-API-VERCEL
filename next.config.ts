import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['@whiskeysockets/baileys', 'pino'],
  poweredByHeader: false,
};

export default nextConfig;
